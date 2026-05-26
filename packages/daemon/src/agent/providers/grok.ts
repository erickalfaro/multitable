import { homedir } from 'os';
import type { AgentSession } from '../types.js';
import type { Message } from '../../transcripts/parser.js';
import type { ProviderAdapter, ProviderCapabilities, AdapterCallbacks } from './types.js';
import type { PermissionManager } from '../../hooks/permissionManager.js';
import { GrokAcpClient } from './grok-acp/index.js';
import type {
  RpcNotification,
  GrokAuthState,
  NewSessionOptions,
  AcpPermissionRequest,
  AcpPermissionOutcome,
  AcpAskQuestionRequest,
  AcpAskQuestionOutcome,
} from './grok-acp/index.js';

// GrokAdapter — driven by `grok agent stdio`, xAI's Grok Build CLI run as an
// Agent Client Protocol (ACP) agent over stdio. Architecturally a sibling of
// the Hermes adapter (both speak ACP) but a SEPARATE implementation — see
// .claude/skills/grok-build/.
//
// Auth: Grok reads ~/.grok/auth.json itself (the `cached_token` ACP auth method,
// written by `grok auth login` for SuperGrok / X-Premium subscribers). We don't
// pin an inference provider or wrap the child in a sandbox — Grok is a
// self-contained binary with its own `--sandbox` / workspace-trust model.
//
// Per turn:
//  1. ensureSessionId() — `session/new` for a fresh session (forwarding
//     model / permissionMode / effort, which Grok honors), or `session/load`
//     to re-attach. The cache is keyed by {grokSessionId, mode, effort, model}
//     so a mode/effort/model change re-loads with the new config.
//  2. subscribe(grokSessionId, listener) — every ACP session/update carries
//     `sessionId` so multiplexing is just routing.
//  3. session/prompt with [{type:'text', text}]; drain session/update until the
//     prompt response returns with a stopReason + usage in `_meta`.
//  4. Emit the canonical assistant message from the accumulated chunks.
//
// Streaming model (verified v0.2.2):
//  - `agent_message_chunk` / `agent_thought_chunk` deltas are ADDITIVE — each
//    chunk is a fresh piece. We accumulate and emit cumulative text so the
//    StreamBuffer reducer gets the cumulative shape it expects.
//  - `tool_call` / `tool_call_update` carry per-call lifecycle; a
//    `tool_call_update` with status completed/failed is the canonical result.
//
// Permission scope: like every ACP agent, Grok self-gates — it only emits
// session/request_permission for calls it deems sensitive (driven by the
// session's permissionMode). The host cannot force-prompt every call. See
// .claude/skills/grok-build/multitable/permission-wiring.md.
//
// Modes: Grok's `--permission-mode` enum is identical to Claude's
// PermissionMode (default / acceptEdits / auto / dontAsk / bypassPermissions /
// plan). We forward `s.mode` verbatim as the session's permissionMode.

interface SessionCacheEntry {
  grokSessionId: string;
  mode: string;
  effort: string | null;
  model: string | null;
}

interface ToolCallMeta {
  toolName: string;
  input: Record<string, unknown>;
}

interface TurnBuffers {
  assistantText: string;
  reasoningText: string;
  toolCalls: Map<string, ToolCallMeta>;
}

function makeBuffers(): TurnBuffers {
  return { assistantText: '', reasoningText: '', toolCalls: new Map() };
}

// Extract plain text from an ACP content block.
function extractText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as Record<string, unknown>;
  if (typeof c.text === 'string') return c.text;
  if (c.type === 'text' && typeof c.text === 'string') return c.text;
  return '';
}

// Render a tool_call_update's content + rawOutput into a human-readable string.
function renderToolOutput(update: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = update.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const inner = (item as Record<string, unknown>).content;
      const text = extractText(inner);
      if (text) parts.push(text);
    }
  }
  if (parts.length === 0 && update.rawOutput != null) {
    try {
      parts.push(
        typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput),
      );
    } catch {
      parts.push(String(update.rawOutput));
    }
  }
  return parts.join('\n');
}

export class GrokAdapter implements ProviderAdapter {
  readonly name = 'grok' as const;

  readonly capabilities: ProviderCapabilities = {
    // Grok exposes account usage via x.ai/billing, but it's TUI-only over
    // agent-stdio and isn't a per-turn USD figure. Hide the dollar row.
    costUsd: false,
    // Grok has a real `plan` permission-mode (shows diffs, requires approval).
    planMode: 'native',
    // ACP session/request_permission → PermissionManager (same flow as Claude).
    perCallApproval: 'callback',
    // Grok's `ask_user_question` tool delegates to the client via the
    // `_x.ai/ask_user_question` server-request; we route it through the same
    // interactive question UI Claude's AskUserQuestion uses.
    userQuestion: 'tool',
    elicitation: false,
    // Grok runs up to 8 parallel subagents, but we don't surface subagent
    // lifecycle events yet — keep 'none' until the session/update kinds are
    // wired into emitTaskEvent/incrementSubagents.
    subagents: 'none',
    midTurnInput: false,
    // Machine-wide ~/.grok/auth.json (or GROK_CODE_XAI_API_KEY) — no per-session BYOK.
    byok: false,
    // v1 leaves `--sandbox` at Grok's default and gates via permission-mode;
    // we don't enforce an OS sandbox ourselves.
    hardSandbox: false,
    hooks: 'none',
    // ACP chunk semantics are additive (each chunk is a piece).
    streamingDeltaSemantics: 'additive',
    modelSwitchScope: 'per-session',
    // Grok's --permission-mode enum is identical to Claude's PermissionMode.
    // Forwarded verbatim as the session's permissionMode on session/new.
    modes: [
      {
        value: 'default',
        label: 'Ask first',
        description: 'Standard — Grok prompts before running sensitive tools.',
        tone: 'standard',
      },
      {
        value: 'acceptEdits',
        label: 'Accept edits',
        description: 'Auto-accept file edits; still prompts for other sensitive actions.',
        tone: 'elevated',
      },
      {
        value: 'auto',
        label: 'Auto',
        description: 'Grok proceeds autonomously, prompting only when necessary.',
        tone: 'elevated',
      },
      {
        value: 'plan',
        label: 'Plan',
        description: 'Plan first — Grok proposes changes and shows diffs before applying.',
        tone: 'safe',
      },
      {
        value: 'dontAsk',
        label: "Don't ask",
        description: 'Suppress permission prompts for this session.',
        tone: 'danger',
      },
      {
        value: 'bypassPermissions',
        label: 'Bypass',
        description: 'Bypass all permission prompts — Grok runs every tool without asking.',
        tone: 'danger',
      },
    ],
    // Grok supports --effort low|medium|high|xhigh|max natively (exact
    // MultiTable tiers), forwarded as the session's `effort` on session/new.
    thinkingEffort: 'native',
  };

  private permManager: PermissionManager;
  // Per-project-cwd pool of `grok agent stdio` children. Empty when an injected
  // client is supplied for tests.
  private clients = new Map<string, GrokAcpClient>();
  private injectedClient: GrokAcpClient | null = null;
  private sessions = new Map<string, SessionCacheEntry>();
  // Reverse map (Grok ACP session id → MultiTable session id) so the permission
  // handler — which only knows the ACP id — can resolve back to the host session.
  private acpToMt = new Map<string, string>();
  // Per-MT-session prior ACP `plan` snapshot, used to diff successive plan
  // session/update notifications into synthetic Tasks-panel events.
  private planState = new Map<
    string,
    { turnSeq: number; entries: Array<{ status: string }>; logged: boolean }
  >();

  constructor(permManager: PermissionManager, client?: GrokAcpClient) {
    this.permManager = permManager;
    this.injectedClient = client ?? null;
  }

  // One `grok agent stdio` child per project working directory. Grok honors the
  // per-session cwd on session/new (verified), so a singleton could work, but
  // we pool per-cwd for parity with the other ACP provider and to keep each
  // project's child cleanly scoped.
  private clientFor(cwd: string): GrokAcpClient {
    if (this.injectedClient) return this.injectedClient;
    const existing = this.clients.get(cwd);
    if (existing) return existing;
    const created = new GrokAcpClient({
      permissionHandler: (req) => this.handleAcpPermission(req),
      askQuestionHandler: (req) => this.handleAskQuestion(req),
      cwd,
    });
    this.clients.set(cwd, created);
    return created;
  }

  reset(s: AgentSession): void {
    const existing = this.sessions.get(s.id);
    if (existing) this.acpToMt.delete(existing.grokSessionId);
    this.sessions.delete(s.id);
    this.planState.delete(s.id);
  }

  /** Daemon shutdown hook. Closes every per-project grok child. */
  shutdown(): void {
    if (this.injectedClient) this.injectedClient.close();
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }

  async runTurn(
    s: AgentSession,
    text: string,
    ctrl: AbortController,
    cb: AdapterCallbacks,
  ): Promise<void> {
    if (s.userMessages.length === 1) cb.maybeRenameFromFirstPrompt(text);

    const cwd = this.resolveCwd(s);
    const client = this.clientFor(cwd);

    // 1. Make sure the long-lived child is up and authenticated.
    let authState: GrokAuthState;
    try {
      authState = await client.ensureReady();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cb.emitAlert({
        category: 'auth',
        severity: 'error',
        title: 'Could not start grok agent stdio',
        body:
          `Failed to spawn or initialise \`grok agent stdio\`. Is Grok Build installed and on PATH? ` +
          `Install: curl -fsSL https://x.ai/cli/install.sh | bash` +
          `\n\nUnderlying error: ${message}`,
        persistent: true,
      });
      throw err;
    }

    if (authState.kind === 'needsSetup') {
      cb.emitAlert({
        category: 'auth',
        severity: 'error',
        title: 'Sign in to Grok',
        body:
          'No usable Grok credentials found. Run `grok auth login` (SuperGrok / X Premium+ ' +
          'required) or set GROK_CODE_XAI_API_KEY, then retry.',
        persistent: true,
      });
      throw new Error('grok agent stdio: no provider credentials configured');
    }

    // 2. Mint or load the ACP session id.
    const grokSessionId = await this.ensureSessionId(s, cb, client, cwd);

    // 3. Wire streaming. Subscribe BEFORE prompt so we can't miss early chunks.
    const buffers = makeBuffers();

    const prevPlan = this.planState.get(s.id);
    if (prevPlan) {
      prevPlan.turnSeq += 1;
      prevPlan.entries = [];
    } else {
      this.planState.set(s.id, { turnSeq: 0, entries: [], logged: false });
    }

    const off = client.subscribe(grokSessionId, (n) => {
      try {
        this.handleNotification(s, n, cb, buffers);
      } catch (err) {
        console.error('[grok] notification handler threw', {
          sessionId: s.id,
          grokSessionId,
          method: n.method,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    const onAbort = () => client.cancel(grokSessionId);
    ctrl.signal.addEventListener('abort', onAbort, { once: true });

    console.info('[grok] starting turn', {
      sessionId: s.id,
      grokSessionId,
      promptLength: text.length,
    });

    try {
      const result = await client.prompt({ sessionId: grokSessionId, text });

      console.info('[grok] turn completed', {
        sessionId: s.id,
        grokSessionId,
        stopReason: result.stopReason,
      });

      // Finalize the turn's messages. The reasoning + assistant text streamed
      // live as previews (emitReasoningDelta / emitAssistantDelta); turn-complete
      // clears those previews, so we MUST emit canonical messages to replace
      // them or the thinking + answer vanish. Reasoning first so it renders
      // above the answer (matches grokParser's on-disk ordering). Emitting both
      // in one assistant-message broadcast keeps the swap atomic on the client.
      const now = Date.now();
      const finalMessages: Message[] = [];

      if (buffers.reasoningText.trim().length > 0) {
        finalMessages.push({
          id: `grok:${grokSessionId}:reasoning:${now}`,
          ts: now,
          kind: 'reasoning',
          text: buffers.reasoningText,
        });
        cb.emitReasoningDelta('');
      }

      if (buffers.assistantText.trim().length > 0) {
        finalMessages.push({
          id: `grok:${grokSessionId}:assistant:${now}`,
          ts: now + 1,
          kind: 'assistant',
          text: buffers.assistantText,
          model: s.model ?? 'grok-build',
        });
        cb.emitAssistantDelta('');
      }

      if (finalMessages.length > 0) {
        cb.pushMessages(finalMessages);
        cb.emitAssistantMessage(finalMessages);
      }

      // Usage comes back in the prompt response `_meta` (no USD).
      const meta = result._meta ?? {};
      const tokensIn = numberOr(meta.inputTokens, 0);
      const tokensOut = numberOr(meta.outputTokens, 0);
      const cacheReadTokens = numberOr(meta.cachedReadTokens, 0);
      const cacheCreationTokens = numberOr(meta.cacheCreationTokens, 0);

      cb.applyUsage({
        tokensIn,
        tokensOut,
        cacheCreationTokens,
        cacheReadTokens,
        costUsd: 0,
      });

      cb.emitTurnResult({
        subtype: result.stopReason ?? 'end_turn',
        totalCostUsd: 0,
        usage: {
          inputTokens: tokensIn,
          outputTokens: tokensOut,
          cacheCreationInputTokens: cacheCreationTokens,
          cacheReadInputTokens: cacheReadTokens,
        },
        text: buffers.assistantText || null,
      });
      cb.emitStateSnapshot();
    } catch (err) {
      console.error('[grok] turn failed', {
        sessionId: s.id,
        grokSessionId,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      // Drop the cached session so the next turn re-loads. The ACP session
      // persists in ~/.grok regardless.
      this.acpToMt.delete(grokSessionId);
      this.sessions.delete(s.id);
      throw err;
    } finally {
      ctrl.signal.removeEventListener('abort', onAbort);
      off();
    }
  }

  // Resolve a session's project cwd, never empty.
  private resolveCwd(s: AgentSession): string {
    if (!s.workingDir) {
      console.warn('[grok] session has empty workingDir; falling back to homedir', {
        sessionId: s.id,
        projectId: s.projectId,
      });
      return homedir();
    }
    return s.workingDir;
  }

  private async ensureSessionId(
    s: AgentSession,
    cb: AdapterCallbacks,
    client: GrokAcpClient,
    cwd: string,
  ): Promise<string> {
    const effort = s.thinkingEffort ?? null;
    const model = s.model ?? null;
    const existing = this.sessions.get(s.id);
    if (
      existing &&
      existing.mode === s.mode &&
      existing.effort === effort &&
      existing.model === model
    ) {
      return existing.grokSessionId;
    }

    const opts: NewSessionOptions = {
      cwd,
      model,
      permissionMode: s.mode,
      effort,
    };

    let grokSessionId: string;
    let loaded = false;
    if (s.agentSessionId) {
      try {
        grokSessionId = await client.loadSession(s.agentSessionId, opts);
        loaded = true;
      } catch (err) {
        console.warn('[grok] session/load failed, creating fresh', {
          sessionId: s.id,
          grokSessionId: s.agentSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        grokSessionId = await client.newSession(opts);
      }
    } else {
      grokSessionId = await client.newSession(opts);
    }

    // If Grok replays history as session/update after load (Zed-style), it would
    // duplicate what we already hydrated from disk. Wait briefly before the
    // caller subscribes so most replay lands with no listener; tool-id dedup in
    // handleNotification catches the tail.
    if (loaded) await new Promise<void>((r) => setTimeout(r, 500));

    if (grokSessionId !== s.agentSessionId) {
      const previous = s.agentSessionId;
      const nextHistory =
        previous && !s.agentSessionIdHistory.includes(previous)
          ? [...s.agentSessionIdHistory, previous]
          : s.agentSessionIdHistory;
      cb.onSessionIdAssigned(grokSessionId, nextHistory);
      cb.emitStateSnapshot();
    }

    this.sessions.set(s.id, { grokSessionId, mode: s.mode, effort, model });
    this.acpToMt.set(grokSessionId, s.id);
    return grokSessionId;
  }

  // ACP session/request_permission → PermissionManager. Same prompt card Claude
  // tool calls use; the user's Allow/Deny becomes the optionId we return.
  // "Always Allow" is handled inside PermissionManager (sessionAllowList), so we
  // always return `allow_once` to Grok.
  private async handleAcpPermission(req: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    const mtSessionId = this.acpToMt.get(req.sessionId);
    if (!mtSessionId) {
      console.warn('[grok] permission request for unknown acp session', req.sessionId);
      return { outcome: { outcome: 'cancelled' } };
    }

    const tc = req.toolCall ?? {};
    const toolName =
      (typeof tc.kind === 'string' && tc.kind) ||
      (typeof tc.title === 'string' && tc.title) ||
      'grok_tool';
    const toolInput =
      tc.rawInput && typeof tc.rawInput === 'object'
        ? (tc.rawInput as Record<string, unknown>)
        : {};
    const firstLoc =
      Array.isArray(tc.locations) && tc.locations[0]?.path ? String(tc.locations[0].path) : undefined;

    const controller = new AbortController();
    const result = await this.permManager.requestFromSdk(
      mtSessionId,
      '',
      toolName,
      toolInput as Record<string, any>,
      controller.signal,
      {
        title: typeof tc.title === 'string' ? tc.title : undefined,
        displayName: typeof tc.kind === 'string' ? tc.kind : undefined,
        blockedPath: firstLoc,
      },
    );

    if (result.behavior !== 'allow') {
      return { outcome: { outcome: 'cancelled' } };
    }

    const allowOption =
      req.options.find((o) => o.kind === 'allow_once') ??
      req.options.find((o) => o.kind === 'allow_always') ??
      req.options.find((o) => o.optionId === 'allow_once') ??
      req.options.find((o) => o.optionId === 'allow_session') ??
      req.options.find((o) => o.optionId === 'allow_always') ??
      req.options.find((o) => o.kind !== 'reject_once' && o.kind !== 'reject_always');
    if (!allowOption?.optionId) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
  }

  // Grok's `ask_user_question` tool → MultiTable's interactive question UI.
  // Bridges the ACP `_x.ai/ask_user_question` request to
  // PermissionManager.requestFromSdk with toolName 'AskUserQuestion' (the exact
  // path Claude's AskUserQuestion uses, rendered by PermissionBar), then maps
  // the user's selections back into Grok's answers-by-index response shape.
  private async handleAskQuestion(req: AcpAskQuestionRequest): Promise<AcpAskQuestionOutcome> {
    const mtSessionId = this.acpToMt.get(req.sessionId);
    if (!mtSessionId) {
      console.warn('[grok] ask_user_question for unknown acp session', req.sessionId);
      return { outcome: 'cancelled' };
    }

    const controller = new AbortController();
    const result = await this.permManager.requestFromSdk(
      mtSessionId,
      '',
      'AskUserQuestion',
      { questions: req.questions },
      controller.signal,
    );

    // AskUserQuestion answers come back as a 'deny' whose message is JSON:
    // { questions: [{ question, header, answer: string[] }] } (the Claude
    // convention PermissionManager reuses). A 'Cancelled' / 'Session cleared'
    // message (or any non-answer) maps to cancelled.
    if (result.behavior !== 'deny' || !result.message) {
      return { outcome: 'cancelled' };
    }
    let parsed: { questions?: Array<{ answer?: unknown }> };
    try {
      parsed = JSON.parse(result.message);
    } catch {
      return { outcome: 'cancelled' };
    }
    const qs = Array.isArray(parsed.questions) ? parsed.questions : [];
    const answers: Record<string, string[]> = {};
    let anyPicked = false;
    qs.forEach((q, i) => {
      const picked = Array.isArray(q.answer)
        ? q.answer.filter((a): a is string => typeof a === 'string')
        : [];
      answers[String(i)] = picked;
      if (picked.length > 0) anyPicked = true;
    });
    // Empty selection across all questions = the user cancelled the picker.
    if (!anyPicked) return { outcome: 'cancelled' };
    return { outcome: 'accepted', answers };
  }

  private handleNotification(
    s: AgentSession,
    n: RpcNotification,
    cb: AdapterCallbacks,
    buffers: TurnBuffers,
  ): void {
    // Grok pushes everything through `session/update`. Other notification
    // methods (available_commands, x.ai-namespaced extensions) are ignored.
    if (n.method !== 'session/update') return;
    const params = n.params as { sessionId?: string; update?: Record<string, unknown> } | null;
    const update = params?.update;
    if (!update || typeof update !== 'object') return;

    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
    switch (kind) {
      case 'agent_message_chunk': {
        const text = extractText(update.content);
        if (!text) return;
        buffers.assistantText += text;
        cb.emitAssistantDelta(buffers.assistantText);
        cb.bumpActivity();
        return;
      }

      case 'agent_thought_chunk': {
        const text = extractText(update.content);
        if (!text) return;
        buffers.reasoningText += text;
        cb.emitReasoningDelta(buffers.reasoningText);
        cb.bumpActivity();
        return;
      }

      case 'user_message_chunk': {
        // Fired during session/load history replay — manager already has it.
        return;
      }

      case 'tool_call': {
        const toolUseId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
        if (!toolUseId) return;
        if (isHistoricalToolId(s, toolUseId)) return;
        const toolName =
          (typeof update.title === 'string' && update.title) ||
          (typeof update.kind === 'string' && update.kind) ||
          'tool';
        const input =
          update.rawInput && typeof update.rawInput === 'object'
            ? (update.rawInput as Record<string, unknown>)
            : {};
        buffers.toolCalls.set(toolUseId, { toolName, input });
        const msg: Message = {
          id: `grok:${s.agentSessionId ?? 'pending'}:tool_use:${toolUseId}`,
          ts: Date.now(),
          kind: 'tool_use',
          parentId: `grok:${s.agentSessionId ?? 'pending'}:assistant:pending`,
          toolUseId,
          toolName,
          input,
        };
        cb.pushMessages([msg]);
        cb.emitToolEvent([msg]);
        cb.setCurrentTool(toolName);
        cb.bumpActivity();
        return;
      }

      case 'tool_call_update': {
        const toolUseId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
        if (!toolUseId) return;
        if (isHistoricalToolId(s, toolUseId)) return;
        const meta = buffers.toolCalls.get(toolUseId);
        const status = typeof update.status === 'string' ? update.status : '';
        const finished = status === 'completed' || status === 'failed';
        if (finished) {
          const output = renderToolOutput(update);
          const msg: Message = {
            id: `grok:${s.agentSessionId ?? 'pending'}:tool_result:${toolUseId}`,
            ts: Date.now(),
            kind: 'tool_result',
            toolUseId,
            output,
            isError: status === 'failed',
          };
          cb.pushMessages([msg]);
          cb.emitToolEvent([msg]);
          cb.incrementToolCount();
          cb.setCurrentTool(null);
          cb.emitToolDelta(null);
          buffers.toolCalls.delete(toolUseId);
        } else if (meta) {
          const output = renderToolOutput(update);
          cb.emitToolDelta({
            toolName: meta.toolName,
            input: meta.input,
            output,
            isError: false,
          });
        }
        cb.bumpActivity();
        return;
      }

      // ACP `plan`: Grok maps todo/plan-tool results here. Each entry is a step
      // `{ content, status }` with status pending|in_progress|completed. Diff
      // against the prior snapshot and normalize into the Claude-shaped
      // task_started/task_updated events the frontend reducer consumes.
      case 'plan': {
        const entries = Array.isArray(update.entries)
          ? (update.entries as Array<Record<string, unknown>>)
          : [];
        let st = this.planState.get(s.id);
        if (!st) {
          st = { turnSeq: 0, entries: [], logged: false };
          this.planState.set(s.id, st);
        }
        if (!st.logged) {
          st.logged = true;
          console.info('[grok] plan update (shape probe)', JSON.stringify(update).slice(0, 500));
        }
        const turnSeq = st.turnSeq;
        const prior = st.entries;
        const next: Array<{ status: string }> = [];
        entries.forEach((e, i) => {
          const content = typeof e.content === 'string' && e.content ? e.content : `Step ${i + 1}`;
          const status = mapAcpPlanStatus(e.status);
          const taskId = `grok-plan-t${turnSeq}-${i}`;
          next.push({ status });
          const before = prior[i];
          if (!before) {
            cb.emitTaskEvent('task_started', {
              task_id: taskId,
              description: content,
              task_type: 'plan',
              skip_transcript: true,
            });
            if (status !== 'pending') {
              cb.emitTaskEvent('task_updated', {
                task_id: taskId,
                patch: { status, description: content },
              });
            }
          } else if (before.status !== status) {
            cb.emitTaskEvent('task_updated', {
              task_id: taskId,
              patch: { status, description: content },
            });
          }
        });
        st.entries = next;
        cb.bumpActivity();
        return;
      }

      case 'available_commands_update':
      case 'config_option_update':
      case 'current_mode_update':
      case 'usage_update':
      default:
        return;
    }
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function mapAcpPlanStatus(s: unknown): 'pending' | 'running' | 'completed' {
  if (s === 'in_progress') return 'running';
  if (s === 'completed') return 'completed';
  return 'pending';
}

function isHistoricalToolId(s: AgentSession, toolUseId: string): boolean {
  if (!toolUseId) return false;
  for (const m of s.messages) {
    if (m.kind === 'tool_use' && m.toolUseId === toolUseId) return true;
  }
  return false;
}
