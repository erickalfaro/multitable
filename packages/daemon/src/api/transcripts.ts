import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import {
  getAllProjects,
  getAllSessions,
  getProjectByPath,
  createProject,
  createSession,
  getSessionById,
  updateSession,
  insertSessionEvent,
  getClaudeSessionLoader,
} from '../db/store.js';
import type { AgentSessionManager } from '../agent/manager.js';
import { listCodexThreads, parseCodexThread, findCodexSessionFile } from '../transcripts/codexParser.js';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

interface TranscriptHeader {
  cwd: string;
  gitBranch: string | null;
  firstUserPrompt: string | null;
}

// Cache: jsonl path → { mtime, header }. Invalidated when mtime changes.
const headerCache = new Map<string, { mtime: number; header: TranscriptHeader }>();

// Read up to maxLines from a JSONL file. Cheap on small files; for our purposes
// we only need the first few entries to extract metadata.
function readFirstLines(filePath: string, maxLines: number): string[] {
  const lines: string[] = [];
  const fd = fs.openSync(filePath, 'r');
  try {
    const bufSize = 16 * 1024;
    const buf = Buffer.alloc(bufSize);
    let leftover = '';
    let pos = 0;
    while (lines.length < maxLines) {
      const n = fs.readSync(fd, buf, 0, bufSize, pos);
      if (n === 0) break;
      pos += n;
      const chunk = leftover + buf.slice(0, n).toString('utf8');
      const parts = chunk.split('\n');
      leftover = parts.pop() ?? '';
      for (const p of parts) {
        if (p.trim()) lines.push(p);
        if (lines.length >= maxLines) break;
      }
    }
    if (leftover.trim() && lines.length < maxLines) lines.push(leftover);
  } finally {
    fs.closeSync(fd);
  }
  return lines;
}

// Strip claude's injected context wrappers (ide_selection, ide_opened_file,
// local-command-caveat/stdout/stderr, command-name, system-reminder, etc.)
// so the returned preview is the user's real prompt.
function stripContextWrappers(text: string): string {
  let t = text;
  // Remove paired XML-like blocks: <tag>...</tag>
  t = t.replace(/<[a-z][a-z0-9_-]*>[\s\S]*?<\/[a-z][a-z0-9_-]*>/gi, '');
  // Remove self-closing tags: <tag ... />
  t = t.replace(/<[a-z][a-z0-9_-]*[^>]*\/>/gi, '');
  return t.replace(/\s+/g, ' ').trim();
}

function extractFirstUserText(message: any): string | null {
  if (!message) return null;
  const content = message.content;
  let raw = '';
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  if (!raw) return null;
  const stripped = stripContextWrappers(raw);
  // If stripping produced nothing, this user message was entirely synthetic
  // (e.g. a <local-command-caveat> injection) — return null so the caller
  // moves on to the next user message.
  return stripped || null;
}

function parseHeader(filePath: string): TranscriptHeader | null {
  try {
    const stat = fs.statSync(filePath);
    const cached = headerCache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs) return cached.header;

    const lines = readFirstLines(filePath, 30);
    let cwd = '';
    let gitBranch: string | null = null;
    let firstUserPrompt: string | null = null;

    for (const line of lines) {
      let j: any;
      try { j = JSON.parse(line); } catch { continue; }
      if (!cwd && typeof j.cwd === 'string') cwd = j.cwd;
      if (gitBranch === null && typeof j.gitBranch === 'string') gitBranch = j.gitBranch;
      if (!firstUserPrompt && j.type === 'user') {
        const text = extractFirstUserText(j.message);
        if (text) firstUserPrompt = text;
      }
      if (cwd && firstUserPrompt) break;
    }

    if (!cwd) return null;
    const header: TranscriptHeader = { cwd, gitBranch, firstUserPrompt };
    headerCache.set(filePath, { mtime: stat.mtimeMs, header });
    return header;
  } catch {
    return null;
  }
}

interface TranscriptListing {
  sessionId: string;
  jsonlPath: string;
  cwd: string;
  gitBranch: string | null;
  firstPrompt: string | null;
  mtime: number;
  pinnedSessionId: string | null;
}

function listAllTranscriptFiles(scopeCwd?: string): string[] {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }

  const dirs: string[] = [];
  for (const e of entries) {
    const full = path.join(CLAUDE_PROJECTS_DIR, e);
    try {
      if (fs.statSync(full).isDirectory()) dirs.push(full);
    } catch {}
  }

  const files: string[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      if (scopeCwd) {
        // Lazy scope filter — read header to check cwd. We cache so repeated
        // calls are fast. Skip files whose cwd doesn't match.
        const h = parseHeader(full);
        if (!h || h.cwd !== scopeCwd) continue;
      }
      files.push(full);
    }
  }
  return files;
}

function buildPinnedIndex(): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of getAllSessions()) {
    if (s.claudeSessionId) map.set(s.claudeSessionId, s.id);
  }
  return map;
}

function buildListing(filePath: string, pinnedIndex: Map<string, string>): TranscriptListing | null {
  const sessionId = path.basename(filePath, '.jsonl');
  let mtime = 0;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch { return null; }
  const header = parseHeader(filePath);
  if (!header) return null;
  return {
    sessionId,
    jsonlPath: filePath,
    cwd: header.cwd,
    gitBranch: header.gitBranch,
    firstPrompt: header.firstUserPrompt,
    mtime,
    pinnedSessionId: pinnedIndex.get(sessionId) ?? null,
  };
}

// Spawn ripgrep (or grep fallback) to find JSONL files containing the query.
// Returns a list of matching file paths.
function searchTranscripts(query: string, scopeDir?: string): Promise<string[]> {
  return new Promise((resolve) => {
    const dir = scopeDir || CLAUDE_PROJECTS_DIR;
    if (!fs.existsSync(dir)) return resolve([]);

    // Try ripgrep first
    const rg = spawn('rg', ['-l', '--no-messages', '-g', '*.jsonl', '--', query, dir], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    let resolved = false;
    rg.stdout.on('data', (d) => { out += d.toString('utf8'); });
    rg.on('error', () => {
      if (resolved) return;
      resolved = true;
      // Fallback to grep
      const gr = spawn('grep', ['-rlF', '--include=*.jsonl', query, dir], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out2 = '';
      gr.stdout.on('data', (d) => { out2 += d.toString('utf8'); });
      gr.on('close', () => {
        resolve(out2.split('\n').map(s => s.trim()).filter(Boolean));
      });
      gr.on('error', () => resolve([]));
    });
    rg.on('close', () => {
      if (resolved) return;
      resolved = true;
      resolve(out.split('\n').map(s => s.trim()).filter(Boolean));
    });
  });
}

// Encode an absolute cwd to claude's project directory name format.
// (Replaces every non-alphanumeric character with a dash.)
function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function createTranscriptsRouter(agentManager: AgentSessionManager): Router {
  const router = Router();

  // GET /api/transcripts?q=&cwd=&limit=
  router.get('/', async (req: Request, res: Response) => {
    const q = (req.query.q as string | undefined)?.trim() || '';
    const cwd = (req.query.cwd as string | undefined)?.trim() || '';
    const limit = Math.min(500, Math.max(1, parseInt((req.query.limit as string) || '100', 10)));

    try {
      const pinnedIndex = buildPinnedIndex();
      const projects = getAllProjects();
      const projectByPath = new Map(projects.map(p => [p.path.replace(/\/+$/, ''), p]));

      let files: string[];
      if (q) {
        // Scope grep to one project dir if cwd provided
        const scopeDir = cwd ? path.join(CLAUDE_PROJECTS_DIR, encodeCwd(cwd)) : undefined;
        files = await searchTranscripts(q, scopeDir);
        if (cwd) {
          // Verify each match's cwd actually equals the requested cwd
          // (encodeCwd is lossy: _ and / both → -)
          files = files.filter(f => {
            const h = parseHeader(f);
            return h?.cwd === cwd;
          });
        }
      } else {
        files = listAllTranscriptFiles(cwd || undefined);
      }

      // Sort by mtime desc, take up to limit*1.5 then build listings (some may
      // fail to parse; we'll trim to limit at the end).
      const withStat: { path: string; mtime: number }[] = [];
      for (const f of files) {
        try { withStat.push({ path: f, mtime: fs.statSync(f).mtimeMs }); } catch {}
      }
      withStat.sort((a, b) => b.mtime - a.mtime);

      const sessions: TranscriptListing[] = [];
      for (const { path: f } of withStat) {
        const listing = buildListing(f, pinnedIndex);
        if (listing) sessions.push(listing);
        if (sessions.length >= limit) break;
      }

      // Build projects summary across ALL files (not just shown ones), so the
      // project filter shows every project even when search narrows results.
      // Cheap-ish: parses each file's header, but headers are cached.
      const allFiles = q ? listAllTranscriptFiles() : files;
      const projectSummary = new Map<string, { cwd: string; projectName: string; sessionCount: number; lastMtime: number }>();
      for (const f of allFiles) {
        const h = parseHeader(f);
        if (!h) continue;
        const normalizedCwd = h.cwd.replace(/\/+$/, '');
        const p = projectByPath.get(normalizedCwd);
        const projectName = p?.name ?? path.basename(normalizedCwd);
        const existing = projectSummary.get(normalizedCwd);
        let mtime = 0;
        try { mtime = fs.statSync(f).mtimeMs; } catch {}
        if (existing) {
          existing.sessionCount++;
          if (mtime > existing.lastMtime) existing.lastMtime = mtime;
        } else {
          projectSummary.set(normalizedCwd, { cwd: normalizedCwd, projectName, sessionCount: 1, lastMtime: mtime });
        }
      }

      const projectsList = Array.from(projectSummary.values())
        .sort((a, b) => b.lastMtime - a.lastMtime);

      res.json({
        projects: projectsList.map(p => ({
          cwd: p.cwd,
          projectName: p.projectName,
          sessionCount: p.sessionCount,
        })),
        sessions: sessions.map(s => ({
          sessionId: s.sessionId,
          cwd: s.cwd,
          projectName: projectByPath.get(s.cwd.replace(/\/+$/, ''))?.name ?? path.basename(s.cwd.replace(/\/+$/, '')),
          gitBranch: s.gitBranch,
          firstPrompt: s.firstPrompt,
          mtime: s.mtime,
          pinnedSessionId: s.pinnedSessionId,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list transcripts' });
    }
  });

  // POST /api/transcripts/:sessionId/resume
  router.post('/:sessionId/resume', async (req: Request, res: Response) => {
    const claudeSessionId = req.params.sessionId;

    // Locate the JSONL across all project dirs
    let jsonlPath: string | null = null;
    if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
      const dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR)
        .map(d => path.join(CLAUDE_PROJECTS_DIR, d))
        .filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
      for (const d of dirs) {
        const candidate = path.join(d, `${claudeSessionId}.jsonl`);
        if (fs.existsSync(candidate)) { jsonlPath = candidate; break; }
      }
    }
    if (!jsonlPath) {
      return res.status(404).json({ error: `No transcript found for session ${claudeSessionId}` });
    }

    const header = parseHeader(jsonlPath);
    if (!header || !header.cwd) {
      return res.status(500).json({ error: 'Could not read transcript metadata' });
    }
    const cwd = header.cwd.replace(/\/+$/, '');

    // If a session row already exists for this claudeSessionId, reuse it.
    const existingByClaudeId = getAllSessions().find(s => s.claudeSessionId === claudeSessionId);
    let sessionRecord = existingByClaudeId;

    if (!sessionRecord) {
      // Find or create the project for this cwd
      let project = getProjectByPath(cwd);
      if (!project) {
        // Try with trailing slash variant too
        project = getProjectByPath(cwd + '/');
      }
      if (!project) {
        const name = path.basename(cwd) || cwd;
        project = createProject({ name, path: cwd });
      }

      // Build a friendly name from the first user prompt
      const promptPreview = (header.firstUserPrompt || 'Resumed session')
        .slice(0, 60)
        .replace(/\s+/g, ' ')
        .trim();

      // Reuse the loader the session originally owned, if recorded. Falls
      // through to a fresh pick from the unused pool when the transcript
      // predates loader_variant tracking.
      const recordedVariant = getClaudeSessionLoader(claudeSessionId) ?? undefined;
      sessionRecord = createSession({
        projectId: project.id,
        name: promptPreview || 'Claude Code',
        command: 'claude',
        workingDirectory: cwd,
        type: 'session',
        loaderVariant: recordedVariant,
      });
      updateSession(sessionRecord.id, {
        agentProvider: 'claude',
        agentSessionId: claudeSessionId,
        claudeSessionId,
      });
      sessionRecord = getSessionById(sessionRecord.id) || sessionRecord;
    }

    try {
      const refreshed = updateSession(sessionRecord.id, {
        agentProvider: 'claude',
        agentSessionId: claudeSessionId,
        claudeSessionId,
      }) ?? sessionRecord;

      const existing = agentManager.get(refreshed.id);
      if (existing) agentManager.remove(refreshed.id);

      agentManager.register({
        id: refreshed.id,
        name: refreshed.name,
        projectId: refreshed.projectId,
        workingDir: refreshed.workingDirectory || cwd,
        provider: 'claude',
        model: refreshed.model,
        agentSessionId: refreshed.agentSessionId ?? claudeSessionId,
        agentSessionIdHistory: refreshed.agentSessionIdHistory ?? [],
        claudeSessionId: refreshed.claudeSessionId ?? claudeSessionId,
        claudeSessionIdHistory: refreshed.claudeSessionIdHistory ?? [],
      });
      insertSessionEvent(refreshed.id, 'claude-resumed', { claudeSessionId, fromTranscriptExplorer: true });
      res.json({
        ok: true,
        sessionId: refreshed.id,
        projectId: refreshed.projectId,
        pid: null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to resume transcript' });
    }
  });

  // GET /api/transcripts/codex?cwd=&limit= — list codex threads on disk.
  // Mirrors the Claude transcripts list shape so the AddAgentModal can render
  // them through the same PastAgentsList component.
  router.get('/codex', (req: Request, res: Response) => {
    const cwd = (req.query.cwd as string | undefined)?.trim() || undefined;
    const limit = Math.min(500, Math.max(1, parseInt((req.query.limit as string) || '100', 10)));
    try {
      const headers = listCodexThreads({ cwd, limit });
      const projects = getAllProjects();
      const projectByPath = new Map(projects.map((p) => [p.path.replace(/\/+$/, ''), p]));
      const sessions = headers.map((h) => {
        const normalizedCwd = (h.cwd ?? '').replace(/\/+$/, '');
        // Pull the first user prompt cheaply by re-reading just enough lines.
        const msgs = parseCodexThread(h.threadId);
        const firstUser = msgs.find((m) => m.kind === 'user') as { text?: string } | undefined;
        return {
          sessionId: h.threadId,
          cwd: normalizedCwd,
          projectName: projectByPath.get(normalizedCwd)?.name ?? path.basename(normalizedCwd || '/'),
          gitBranch: null,
          firstPrompt: firstUser?.text ?? '',
          mtime: h.startedAt ?? 0,
          pinnedSessionId: null,
        };
      });
      res.json({ sessions, projects: [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list codex threads' });
    }
  });

  // POST /api/transcripts/codex/:threadId/resume — create a session row bound
  // to an existing codex thread and register it with the agent manager.
  router.post('/codex/:threadId/resume', (req: Request, res: Response) => {
    const threadId = req.params.threadId;
    const file = findCodexSessionFile(threadId);
    if (!file) {
      return res.status(404).json({ error: `No codex thread found for ${threadId}` });
    }
    // The session_meta header carries cwd. parseHeader is Claude-specific, so
    // use parseCodexThread for the messages and listCodexThreads for the
    // header. Single read of either is fine for the modal trigger.
    const headers = listCodexThreads();
    const header = headers.find((h) => h.threadId === threadId);
    if (!header || !header.cwd) {
      return res.status(500).json({ error: 'Could not read codex thread metadata' });
    }
    const cwd = header.cwd.replace(/\/+$/, '');

    const existingByThread = getAllSessions().find(
      (s) => s.agentProvider === 'codex' && s.agentSessionId === threadId,
    );
    let sessionRecord = existingByThread;

    if (!sessionRecord) {
      let project = getProjectByPath(cwd) || getProjectByPath(cwd + '/');
      if (!project) {
        const name = path.basename(cwd) || cwd;
        project = createProject({ name, path: cwd });
      }
      const msgs = parseCodexThread(threadId);
      const firstUser = msgs.find((m) => m.kind === 'user') as { text?: string } | undefined;
      const promptPreview = (firstUser?.text || 'Resumed Codex thread')
        .slice(0, 60)
        .replace(/\s+/g, ' ')
        .trim();
      sessionRecord = createSession({
        projectId: project.id,
        name: promptPreview || 'Codex',
        command: 'codex',
        workingDirectory: cwd,
        type: 'session',
        agentProvider: 'codex',
      });
      updateSession(sessionRecord.id, {
        agentProvider: 'codex',
        agentSessionId: threadId,
        claudeSessionId: threadId,
      });
      sessionRecord = getSessionById(sessionRecord.id) || sessionRecord;
    }

    try {
      const refreshed = updateSession(sessionRecord.id, {
        agentProvider: 'codex',
        agentSessionId: threadId,
        claudeSessionId: threadId,
      }) ?? sessionRecord;

      const existing = agentManager.get(refreshed.id);
      if (existing) agentManager.remove(refreshed.id);

      agentManager.register({
        id: refreshed.id,
        name: refreshed.name,
        projectId: refreshed.projectId,
        workingDir: refreshed.workingDirectory || cwd,
        provider: 'codex',
        model: refreshed.model,
        agentSessionId: refreshed.agentSessionId ?? threadId,
        agentSessionIdHistory: refreshed.agentSessionIdHistory ?? [],
        claudeSessionId: refreshed.claudeSessionId ?? threadId,
        claudeSessionIdHistory: refreshed.claudeSessionIdHistory ?? [],
      });
      insertSessionEvent(refreshed.id, 'codex-resumed', { threadId, fromTranscriptExplorer: true });
      res.json({
        ok: true,
        sessionId: refreshed.id,
        projectId: refreshed.projectId,
        pid: null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to resume codex thread' });
    }
  });

  return router;
}
