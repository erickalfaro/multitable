import { Router } from 'express';
import type { Request, Response } from 'express';
import simpleGit from 'simple-git';
import {
  getSessionById,
  createSession,
  updateSession,
  deleteSession,
  getAllSessions,
  getSessionCostAggregate,
  getProjectById,
} from '../db/store.js';
import { isGitRepo } from '../git/index.js';
import { parseSessionCost } from '../hooks/costParser.js';
import { parseSessionPrompts, parseAllProjectPrompts } from '../hooks/promptsParser.js';
import { generateSessionLabel } from '../hooks/labeler.js';
import {
  parseTranscriptChain,
  walkParentUuidChain,
  getSessionJsonlPath,
} from '../transcripts/parser.js';
import { parseCodexThread } from '../transcripts/codexParser.js';
import { createAttachmentHandler, rawAttachmentBody, removeAttachmentDir } from './attachments.js';
import type { AgentSessionManager } from '../agent/manager.js';

export function createSessionsRouter(agentManager: AgentSessionManager): Router {
  const router = Router();

  const attachmentHandler = createAttachmentHandler({
    resolve: (id) => (getSessionById(id) ? id : null),
  });

  // POST /api/sessions/:id/attachments — upload a single image as raw body.
  router.post('/:id/attachments', rawAttachmentBody, attachmentHandler);

  // GET /api/sessions
  router.get('/', (_req: Request, res: Response) => {
    const sessions = getAllSessions();
    const enriched = sessions.map((s) => {
      // Sessions no longer spawn a PTY; state lives in the AgentSessionManager.
      // pid is always null for sessions now.
      const agent = agentManager.get(s.id);
      const capabilities = agentManager.getCapabilities(s.id);
      return {
        ...s,
        state: agent?.state ?? 'stopped',
        pid: null,
        mode: agent?.mode ?? s.mode ?? 'default',
        capabilities,
      };
    });
    res.json(enriched);
  });

  // GET /api/sessions/:id
  router.get('/:id', (req: Request, res: Response) => {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const agent = agentManager.get(session.id);
    const capabilities = agentManager.getCapabilities(session.id);
    res.json({
      ...session,
      state: agent?.state ?? 'stopped',
      pid: null,
      mode: agent?.mode ?? session.mode ?? 'default',
      capabilities,
    });
  });

  // POST /api/sessions
  router.post('/', (req: Request, res: Response) => {
    const {
      projectId,
      name,
      command,
      workingDirectory,
      autostart,
      autorestart,
      autorestartMax,
      autorestartDelayMs,
      autorestartWindowSecs,
      autorespawn,
      terminalAlerts,
      fileWatchPatterns,
    } = req.body || {};

    if (!projectId || !name || !command) {
      return res.status(400).json({ error: 'projectId, name, and command are required' });
    }

    try {
      const session = createSession({
        projectId,
        name,
        command,
        workingDirectory,
        type: 'session',
        autostart,
        autorestart,
        autorestartMax,
        autorestartDelayMs,
        autorestartWindowSecs,
        autorespawn,
        terminalAlerts,
        fileWatchPatterns,
      });
      // Register immediately so the next `session:send` from the UI doesn't
      // race the DB write with the agent manager's lookup.
      agentManager.register({
        id: session.id,
        projectId: session.projectId,
        name: session.name,
        workingDir: session.workingDirectory || '',
        provider: session.agentProvider,
        model: session.model,
        mode: session.mode,
        agentSessionId: session.agentSessionId ?? null,
        agentSessionIdHistory: session.agentSessionIdHistory ?? [],
        claudeSessionId: session.claudeSessionId ?? null,
        claudeSessionIdHistory: session.claudeSessionIdHistory ?? [],
      });
      // Mint the provider-side session id eagerly so the transcript file
      // exists and resume works the moment the user clicks Start. Errors are
      // logged inside; we don't await — the UI gets the new id via the
      // `session-updated` WS broadcast when it lands.
      void agentManager.provisionSession(session.id);
      res.status(201).json(session);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  // PUT /api/sessions/:id
  router.put('/:id', (req: Request, res: Response) => {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const updated = updateSession(req.params.id, req.body);
    // Re-broadcast when the visible name changed so other tabs/clients
    // pick up manual renames without a full refresh.
    if (
      updated &&
      typeof req.body?.name === 'string' &&
      req.body.name !== session.name
    ) {
      agentManager.emit('session-renamed', { sessionId: req.params.id });
    }
    res.json(updated);
  });

  // DELETE /api/sessions/:id
  router.delete('/:id', (req: Request, res: Response) => {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    deleteSession(req.params.id);
    // Clean up in-memory agent state + any in-flight turn.
    agentManager.remove(req.params.id);
    removeAttachmentDir(req.params.id);
    res.status(204).send();
  });

  // GET /api/sessions/:id/cost
  //
  // Phase 7 lookup order:
  //   1. In-memory AgentSessionManager totals (live; populated by SDK `result`
  //      messages within the current daemon process).
  //   2. JSONL parse (real-time on disk; covers cold-start / pre-Phase-2
  //      sessions whose totals haven't been observed by this daemon).
  //   3. DB aggregate (final fallback for sessions without a JSONL).
  router.get('/:id/cost', (req: Request, res: Response) => {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // 1. In-memory totals — preferred when the daemon has observed any usage
    //    for this session this run.
    const agent = agentManager.get(req.params.id);
    if (agent && (agent.tokensIn > 0 || agent.tokensOut > 0 || agent.totalCostUsd > 0)) {
      return res.json({
        tokensIn: agent.tokensIn,
        tokensOut: agent.tokensOut,
        cacheCreationTokens: agent.cacheCreationTokens,
        cacheReadTokens: agent.cacheReadTokens,
        costUsd: agent.totalCostUsd,
        model: '', // model isn't tracked at session level today
        messageCount: 0,
      });
    }

    // 2. JSONL fallback — covers cold-start / pre-Phase-2 sessions.
    if (session.claudeSessionId && session.workingDirectory) {
      try {
        const jsonlCost = parseSessionCost(session.workingDirectory, session.claudeSessionId);
        if (jsonlCost) {
          return res.json({
            tokensIn: jsonlCost.tokensIn,
            tokensOut: jsonlCost.tokensOut,
            cacheCreationTokens: jsonlCost.cacheCreationTokens,
            cacheReadTokens: jsonlCost.cacheReadTokens,
            costUsd: jsonlCost.costUsd,
            model: jsonlCost.model,
            messageCount: jsonlCost.messageCount,
          });
        }
      } catch {}
    }

    // 3. DB aggregate.
    const cost = getSessionCostAggregate(req.params.id);
    res.json({ ...cost, cacheCreationTokens: 0, cacheReadTokens: 0, model: '', messageCount: 0 });
  });

  // GET /api/sessions/:id/prompts — all user prompts in the session.
  // Three-tier lookup:
  //   1. The session's own JSONL by claudeSessionId (exact match).
  //   2. Scan every JSONL in the project's encoded Claude projects dir,
  //      filtered to entries whose cwd matches the session's workingDir.
  //      Picks up ancestors and resumed-from sessions whose prompts live
  //      in a different file than the current claudeSessionId.
  //   3. In-memory userMessages (fallback for brand-new sessions).
  router.get('/:id/prompts', (req: Request, res: Response) => {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (session.agentProvider === 'codex') {
      const agent = agentManager.get(req.params.id);
      const fallback = (agent?.userMessages ?? []).map((text) => ({ text, timestamp: null }));
      return res.json({ prompts: fallback, source: 'memory' });
    }

    if (session.claudeSessionId && session.workingDirectory) {
      try {
        const prompts = parseSessionPrompts(session.workingDirectory, session.claudeSessionId);
        if (prompts.length > 0) {
          return res.json({ prompts, source: 'jsonl' });
        }
      } catch {}
    }

    if (session.workingDirectory) {
      try {
        const prompts = parseAllProjectPrompts(session.workingDirectory);
        if (prompts.length > 0) {
          return res.json({ prompts, source: 'jsonl-project' });
        }
      } catch {}
    }

    const agent = agentManager.get(req.params.id);
    const fallback = (agent?.userMessages ?? []).map((text) => ({ text, timestamp: null }));
    res.json({ prompts: fallback, source: 'memory' });
  });

  // GET /api/sessions/:id/messages — full parsed conversation from JSONL(s).
  //
  // Reads every JSONL in the session's claudeSessionId chain (history first,
  // current id last) and merges them, deduped by raw entry uuid. Required
  // because the SDK assigns a new claudeSessionId on certain resume paths
  // (claude-code#8069, closed not-planned) — without chain reads, a forked
  // session shows no scrollback even though the agent has full context.
  //
  // For sessions whose chain wasn't tracked (rows that predate the chain
  // column), falls back to walking the JSONL parentUuid chain across sibling
  // files in the same encoded-cwd directory. This is best-effort; a warning
  // is logged when the lookup yields zero messages despite a valid id.
  router.get('/:id/messages', (req: Request, res: Response) => {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.agentProvider === 'codex') {
      const agent = agentManager.get(req.params.id);
      let messages = agent?.messages ?? [];
      // Re-hydrate from disk if the in-memory cache is empty but a thread id
      // exists. Covers the case where register() ran before the codex CLI had
      // written its first turn, or where the parse failed at register time.
      if (messages.length === 0 && session.agentSessionId) {
        try {
          const hydrated = parseCodexThread(session.agentSessionId);
          if (hydrated.length > 0) {
            if (agent) agent.messages = hydrated;
            messages = hydrated;
          }
        } catch (err) {
          console.error('[sessions] codex re-hydration failed for', session.id, err);
        }
      }
      return res.json({ messages, endOffset: 0 });
    }
    if (!session.claudeSessionId || !session.workingDirectory) {
      return res.json({ messages: [], endOffset: 0 });
    }

    const workingDir = session.workingDirectory;
    const currentSid = session.claudeSessionId;
    const trackedChain = [...session.claudeSessionIdHistory, currentSid];

    try {
      let { messages, endOffset } = parseTranscriptChain(workingDir, trackedChain);

      if (messages.length === 0 && session.claudeSessionIdHistory.length === 0) {
        // Legacy fallback: this row never had its chain tracked, so try
        // discovering ancestors by walking parentUuid across sibling JSONLs.
        const discovered = walkParentUuidChain(workingDir, currentSid);
        if (discovered.length > 0) {
          const fullChain = [...discovered, currentSid];
          ({ messages, endOffset } = parseTranscriptChain(workingDir, fullChain));
        }
      }

      if (messages.length === 0) {
        const attempted = trackedChain
          .map((sid) => getSessionJsonlPath(workingDir, sid))
          .join(', ');
        console.warn(
          `[sessions] /messages returned empty for ${session.id} ` +
            `(claudeSessionId=${currentSid}); tried: ${attempted}`
        );
      }

      res.json({ messages, endOffset });
    } catch (err) {
      console.error(`[sessions] /messages failed for ${session.id}:`, err);
      res.json({ messages: [], endOffset: 0 });
    }
  });

  // POST /api/sessions/:id/stop
  //
  // Canonical lifecycle endpoint: aborts any in-flight turn for the session.
  // There is no PTY to kill; this is purely a cancel for the current query()
  // call. Sending a new turn (POST .../turn or ws session:send) re-engages the
  // SDK; there is no separate "start" or "restart" action.
  router.post('/:id/stop', (req: Request, res: Response) => {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    agentManager.abortTurn(req.params.id);
    res.json({ ok: true });
  });

  // POST /api/sessions/:id/mode
  //
  // Set the operating mode for the session (default / plan / accept-edits /
  // auto / chat / read-only). Takes effect on the NEXT turn — the adapter
  // assembles SDK options from session.mode at runTurn time. Validated against
  // the current provider's declared capabilities.modes; rejects modes the
  // provider doesn't implement.
  router.post('/:id/mode', (req: Request, res: Response) => {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const mode = req.body?.mode;
    const VALID = ['default', 'plan', 'accept-edits', 'auto', 'chat', 'read-only'];
    if (typeof mode !== 'string' || !VALID.includes(mode)) {
      return res.status(400).json({
        error: `Invalid mode. Must be one of: ${VALID.join(', ')}`,
      });
    }
    try {
      agentManager.setMode(req.params.id, mode as 'default' | 'plan' | 'accept-edits' | 'auto' | 'chat' | 'read-only');
      res.json({ ok: true, mode });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/sessions/:id/reset
  //
  // Native handler for the `/clear` slash command. Cancels any in-flight turn,
  // nulls the linked claudeSessionId in the DB and the agent manager, and
  // resets per-session in-memory stats. The next user turn starts a fresh SDK
  // conversation (no `resume`), so the SDK creates a new claudeSessionId at
  // first SystemInit.
  router.post('/:id/reset', (req: Request, res: Response) => {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    agentManager.resetSession(req.params.id);
    updateSession(req.params.id, {
      agentSessionId: null,
      agentSessionIdHistory: [],
      claudeSessionId: null,
      claudeSessionIdHistory: [],
    });
    const updated = getSessionById(req.params.id);
    res.json({ ok: true, session: updated });
  });

  // POST /api/sessions/:id/rename-ai
  //
  // Generates a short title from the session's user prompts via Haiku and
  // overwrites session.name. Mirrors the prompt-lookup chain of
  // /api/sessions/:id/prompts (current JSONL → all project JSONLs →
  // in-memory userMessages) so resumed and brand-new sessions both work.
  // Emits `session-renamed` so subscribers see `session:updated`.
  router.post('/:id/rename-ai', async (req: Request, res: Response) => {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    let prompts: string[] = [];
    if (session.agentProvider === 'codex') {
      prompts = agentManager.get(req.params.id)?.userMessages ?? [];
    }
    if (prompts.length === 0 && session.claudeSessionId && session.workingDirectory) {
      try {
        prompts = parseSessionPrompts(session.workingDirectory, session.claudeSessionId).map((p) => p.text);
      } catch {}
    }
    if (prompts.length === 0 && session.workingDirectory) {
      try {
        prompts = parseAllProjectPrompts(session.workingDirectory).map((p) => p.text);
      } catch {}
    }
    if (prompts.length === 0) {
      const agent = agentManager.get(req.params.id);
      prompts = agent?.userMessages ?? [];
    }

    if (prompts.length === 0) {
      return res.status(400).json({ error: 'No prompts yet — send a message first' });
    }

    const result = await generateSessionLabel(prompts);
    if (!result.ok) {
      console.error('[rename-ai] labeler failed:', result.error);
      return res.status(502).json({ error: result.error });
    }
    // Strip wrapping quotes, normalize whitespace, drop trailing punctuation,
    // and keep only the first line — Haiku occasionally adds an explanatory
    // second line despite the system prompt.
    const firstLine = result.title.split('\n', 1)[0] ?? result.title;
    const cleaned = firstLine
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/[.!?]+$/, '')
      .trim();
    const name = cleaned.length > 60 ? cleaned.slice(0, 59).trimEnd() + '…' : cleaned;
    if (!name) {
      return res.status(502).json({ error: 'AI returned an empty title' });
    }

    const updated = updateSession(req.params.id, { name });
    if (!updated) return res.status(500).json({ error: 'Failed to persist new name' });
    agentManager.emit('session-renamed', { sessionId: req.params.id });
    res.json({ session: updated, name });
  });

  // GET /api/sessions/:id/diff
  // When the session has a captured baseline commit, returns the diff between
  // that commit and the current working tree (everything the agent has
  // touched since it was created). Falls back to a project-level working-tree
  // diff when no baseline is recorded, preserving backwards compatibility.
  router.get('/:id/diff', async (req: Request, res: Response) => {
    const session = getSessionById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const project = getProjectById(session.projectId);
    const repoPath = (project && isGitRepo(project.path) ? project.path : null)
      ?? (session.workingDirectory && isGitRepo(session.workingDirectory) ? session.workingDirectory : null);
    if (!repoPath) {
      return res.status(400).json({ error: 'Not a git repository', code: 'not-a-repo' });
    }

    try {
      const diff = await simpleGit(repoPath).diff();
      res.json({ diff });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get diff' });
    }
  });

  return router;
}
