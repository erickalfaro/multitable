import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getConfigDir } from '../config/loader.js';
import { pickLoaderVariant } from '../loaders.js';
import type { Project, ManagedProcess } from '../types.js';

let db: Database.Database;

export function initDb(): void {
  const dbDir = getConfigDir();
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'multitable.db');
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent reads
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run schema — try both compiled dist path and source path (for tsx dev mode)
  const schemaPath = fs.existsSync(path.join(__dirname, 'schema.sql'))
    ? path.join(__dirname, 'schema.sql')
    : path.join(__dirname, '../../src/db/schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);

  // Idempotent column add for DBs that predate claude_session_id_history.
  // SQLite throws "duplicate column" when re-run; that's the no-op signal.
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN claude_session_id_history TEXT DEFAULT '[]'");
  } catch {}
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN agent_provider TEXT DEFAULT 'claude'");
  } catch {}
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN agent_session_id TEXT');
  } catch {}
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN agent_session_id_history TEXT DEFAULT '[]'");
  } catch {}
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN loader_variant TEXT');
  } catch {}
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN git_baseline_commit TEXT');
  } catch {}
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN model TEXT');
  } catch {}
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN tags TEXT DEFAULT '[]'");
  } catch {}
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN mode TEXT DEFAULT 'default'");
  } catch {}

  // Sessions no longer use a PTY (they go through the Claude/Codex SDK). The
  // pre-SDK PTY scrollback column accumulated stale BLOBs that ballooned
  // /api/sessions responses to several MB on the wire. Free the rows first,
  // then drop the column. Both wrapped in try/catch — the first nullifies
  // existing data on every boot until the schema migration sticks; the second
  // is a no-op once the column is gone.
  try {
    db.exec('UPDATE sessions SET scrollback_data = NULL WHERE scrollback_data IS NOT NULL');
  } catch {}
  try {
    db.exec('ALTER TABLE sessions DROP COLUMN scrollback_data');
  } catch {}

  // Backfill loader_variant for any session missing one. Runs once per process
  // start; cheap (single SELECT + at most N UPDATEs). Each session gets a
  // unique variant from the unused pool until all 60 are taken; further
  // assignments fall back to uniform random reuse.
  backfillSessionLoaderVariants();
}

function backfillSessionLoaderVariants(): void {
  const usedRows = db
    .prepare('SELECT loader_variant FROM sessions WHERE loader_variant IS NOT NULL')
    .all() as Array<{ loader_variant: string }>;
  const used = new Set(usedRows.map((r) => r.loader_variant));
  const missing = db
    .prepare('SELECT id FROM sessions WHERE loader_variant IS NULL ORDER BY created_at ASC')
    .all() as Array<{ id: string }>;
  if (missing.length > 0) {
    const update = db.prepare('UPDATE sessions SET loader_variant = ? WHERE id = ?');
    for (const { id } of missing) {
      const variant = pickLoaderVariant(used);
      update.run(variant, id);
      used.add(variant);
    }
  }

  // Walk every existing session and ensure every claudeSessionId it has ever
  // touched (current + history) is recorded in claude_session_loaders. This
  // means deleting a session and resuming its transcript later will pick up
  // the same loader. INSERT OR IGNORE preserves the first recorded mapping,
  // so a freshly-recreated session never overwrites historical bindings.
  const sessions = db
    .prepare(
      'SELECT id, loader_variant, claude_session_id, claude_session_id_history FROM sessions WHERE loader_variant IS NOT NULL',
    )
    .all() as Array<{
    id: string;
    loader_variant: string;
    claude_session_id: string | null;
    claude_session_id_history: string | null;
  }>;
  const recordStmt = db.prepare(
    'INSERT OR IGNORE INTO claude_session_loaders (claude_session_id, loader_variant, created_at) VALUES (?, ?, ?)',
  );
  const now = Date.now();
  for (const s of sessions) {
    const ids = new Set<string>();
    if (s.claude_session_id) ids.add(s.claude_session_id);
    if (s.claude_session_id_history) {
      try {
        const arr = JSON.parse(s.claude_session_id_history);
        if (Array.isArray(arr)) {
          for (const id of arr) if (typeof id === 'string') ids.add(id);
        }
      } catch {}
    }
    for (const cid of ids) recordStmt.run(cid, s.loader_variant, now);
  }
}

/**
 * Bind a claudeSessionId to a loader variant permanently. INSERT OR IGNORE
 * means the first binding wins — a claudeSessionId is "owned" by whichever
 * loader was assigned to the session that first saw it. Survives session-row
 * deletion, so resuming a transcript reuses the prior loader.
 */
export function recordClaudeSessionLoader(claudeSessionId: string, loaderVariant: string): void {
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO claude_session_loaders (claude_session_id, loader_variant, created_at) VALUES (?, ?, ?)',
    )
    .run(claudeSessionId, loaderVariant, Date.now());
}

export function getClaudeSessionLoader(claudeSessionId: string): string | null {
  const row = getDb()
    .prepare('SELECT loader_variant FROM claude_session_loaders WHERE claude_session_id = ?')
    .get(claudeSessionId) as { loader_variant: string } | undefined;
  return row?.loader_variant ?? null;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

// ─── Projects ────────────────────────────────────────────────────────────────

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  shortcut: number | null;
  icon: string | null;
  is_active: number;
  created_at: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    shortcut: row.shortcut,
    icon: row.icon,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
  };
}

export function getAllProjects(): Project[] {
  const rows = getDb().prepare('SELECT * FROM projects ORDER BY created_at ASC').all() as ProjectRow[];
  return rows.map(rowToProject);
}

export function getProjectById(id: string): Project | null {
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

export function getProjectByPath(projectPath: string): Project | null {
  const row = getDb().prepare('SELECT * FROM projects WHERE path = ?').get(projectPath) as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

export function createProject(data: { name: string; path: string; shortcut?: number | null; icon?: string | null }): Project {
  const id = uuidv4();
  const now = Date.now();
  getDb().prepare(
    'INSERT INTO projects (id, name, path, shortcut, icon, is_active, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
  ).run(id, data.name, data.path, data.shortcut ?? null, data.icon ?? null, now);
  return getProjectById(id)!;
}

export function updateProject(id: string, data: Partial<{ name: string; shortcut: number | null; icon: string | null }>): Project | null {
  const fields: string[] = [];
  const values: any[] = [];
  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.shortcut !== undefined) { fields.push('shortcut = ?'); values.push(data.shortcut); }
  if (data.icon !== undefined) { fields.push('icon = ?'); values.push(data.icon); }
  if (fields.length === 0) return getProjectById(id);
  values.push(id);
  getDb().prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getProjectById(id);
}

export function setProjectActive(id: string, isActive: boolean): void {
  getDb().prepare('UPDATE projects SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id);
}

export function deleteProject(id: string): void {
  getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  project_id: string;
  name: string;
  command: string;
  working_directory: string | null;
  type: string;
  autostart: number;
  autorestart: number;
  autorestart_max: number;
  autorestart_delay_ms: number;
  autorestart_window_secs: number;
  autorespawn: number;
  terminal_alerts: number;
  file_watch_patterns: string;
  agent_provider: string | null;
  model: string | null;
  agent_session_id: string | null;
  agent_session_id_history: string | null;
  claude_session_id: string | null;
  claude_session_id_history: string | null;
  tags: string | null;
  mode: string | null;
  scratchpad: string;
  created_at: number;
  last_active_at: number | null;
  loader_variant: string | null;
  git_baseline_commit: string | null;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  name: string;
  command: string;
  workingDirectory: string | null;
  type: string;
  autostart: boolean;
  autorestart: boolean;
  autorestartMax: number;
  autorestartDelayMs: number;
  autorestartWindowSecs: number;
  autorespawn: boolean;
  terminalAlerts: boolean;
  fileWatchPatterns: string[];
  agentProvider: 'claude' | 'codex' | 'hermes';
  model: string | null;
  agentSessionId: string | null;
  agentSessionIdHistory: string[];
  claudeSessionId: string | null;
  claudeSessionIdHistory: string[];
  tags: string[];
  mode: 'default' | 'plan' | 'accept-edits' | 'auto' | 'chat' | 'read-only';
  scratchpad: string;
  createdAt: number;
  lastActiveAt: number | null;
  loaderVariant: string | null;
  gitBaselineCommit: string | null;
}

// Parse the JSON-encoded chain of prior claude_session_ids the SDK has assigned
// to this session over its lifetime. Tolerates legacy NULL columns and any
// shape that isn't a flat string array (returns []).
function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function parseClaudeSessionIdHistory(raw: string | null): string[] {
  return parseStringArray(raw);
}

const VALID_SESSION_MODES = new Set([
  'default',
  'plan',
  'accept-edits',
  'auto',
  'chat',
  'read-only',
]);

function parseSessionMode(
  raw: string | null,
): 'default' | 'plan' | 'accept-edits' | 'auto' | 'chat' | 'read-only' {
  if (raw && VALID_SESSION_MODES.has(raw)) {
    return raw as 'default' | 'plan' | 'accept-edits' | 'auto' | 'chat' | 'read-only';
  }
  return 'default';
}

function rowToSession(row: SessionRow): SessionRecord {
  const provider: 'claude' | 'codex' | 'hermes' =
    row.agent_provider === 'codex'
      ? 'codex'
      : row.agent_provider === 'hermes'
        ? 'hermes'
        : 'claude';
  const agentSessionId = row.agent_session_id ?? row.claude_session_id;
  const agentSessionIdHistory =
    parseClaudeSessionIdHistory(row.agent_session_id_history).length > 0
      ? parseClaudeSessionIdHistory(row.agent_session_id_history)
      : parseClaudeSessionIdHistory(row.claude_session_id_history);
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    command: row.command,
    workingDirectory: row.working_directory,
    type: row.type,
    autostart: row.autostart === 1,
    autorestart: row.autorestart === 1,
    autorestartMax: row.autorestart_max,
    autorestartDelayMs: row.autorestart_delay_ms,
    autorestartWindowSecs: row.autorestart_window_secs,
    autorespawn: row.autorespawn === 1,
    terminalAlerts: row.terminal_alerts === 1,
    fileWatchPatterns: JSON.parse(row.file_watch_patterns || '[]'),
    agentProvider: provider,
    model: row.model ?? null,
    agentSessionId,
    agentSessionIdHistory,
    claudeSessionId: row.claude_session_id,
    claudeSessionIdHistory: parseClaudeSessionIdHistory(row.claude_session_id_history),
    tags: parseStringArray(row.tags),
    mode: parseSessionMode(row.mode),
    scratchpad: row.scratchpad || '',
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    loaderVariant: row.loader_variant,
    gitBaselineCommit: row.git_baseline_commit,
  };
}

function inferAgentProvider(
  command: string | null | undefined,
): 'claude' | 'codex' | 'hermes' {
  const first = (command ?? '').trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  if (first === 'codex') return 'codex';
  if (first === 'hermes') return 'hermes';
  return 'claude';
}

export function getSessionsByProject(projectId: string): SessionRecord[] {
  const rows = getDb().prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as SessionRow[];
  return rows.map(rowToSession);
}

export function getSessionById(id: string): SessionRecord | null {
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function getAllSessions(): SessionRecord[] {
  const rows = getDb().prepare('SELECT * FROM sessions ORDER BY created_at ASC').all() as SessionRow[];
  return rows.map(rowToSession);
}

export function createSession(data: {
  projectId: string;
  name: string;
  command: string;
  workingDirectory?: string | null;
  type?: string;
  autostart?: boolean;
  autorestart?: boolean;
  autorestartMax?: number;
  autorestartDelayMs?: number;
  autorestartWindowSecs?: number;
  autorespawn?: boolean;
  terminalAlerts?: boolean;
  fileWatchPatterns?: string[];
  agentProvider?: 'claude' | 'codex' | 'hermes';
  model?: string | null;
  /**
   * Optional explicit loader variant. Used by the transcript-resume flow to
   * reattach the same loader to a respawned session. When omitted, a variant
   * is picked from the unused pool (random reuse once all 60 are taken).
   */
  loaderVariant?: string;
  gitBaselineCommit?: string | null;
}): SessionRecord {
  const id = uuidv4();
  const now = Date.now();
  // The "used" set is built only from live session rows. Sessions deleted via
  // the GUI are gone from this query, which immediately frees their loader.
  const usedRows = getDb()
    .prepare('SELECT loader_variant FROM sessions WHERE loader_variant IS NOT NULL')
    .all() as Array<{ loader_variant: string }>;
  const used = new Set(usedRows.map((r) => r.loader_variant));
  // If a specific variant was requested (transcript-resume restoring the
  // session's prior loader) and it isn't currently held by another active
  // session, honor it. Otherwise pick a random unused variant. Avoiding
  // collisions with active sessions takes priority over respawn identity —
  // the recorded binding in claude_session_loaders is preserved either way,
  // so the original loader returns the next time it's free.
  const preferred = data.loaderVariant;
  const loaderVariant =
    preferred && !used.has(preferred) ? preferred : pickLoaderVariant(used);
  getDb().prepare(`
    INSERT INTO sessions (
      id, project_id, name, command, working_directory, type,
      autostart, autorestart, autorestart_max, autorestart_delay_ms,
      autorestart_window_secs, autorespawn, terminal_alerts, file_watch_patterns,
      agent_provider, model, scratchpad, created_at, loader_variant, git_baseline_commit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
  `).run(
    id,
    data.projectId,
    data.name,
    data.command,
    data.workingDirectory ?? null,
    data.type ?? 'session',
    data.autostart ? 1 : 0,
    data.autorestart ? 1 : 0,
    data.autorestartMax ?? 5,
    data.autorestartDelayMs ?? 2000,
    data.autorestartWindowSecs ?? 60,
    data.autorespawn !== false ? 1 : 0,
    data.terminalAlerts ? 1 : 0,
    JSON.stringify(data.fileWatchPatterns ?? []),
    data.agentProvider ?? inferAgentProvider(data.command),
    data.model ?? null,
    now,
    loaderVariant,
    data.gitBaselineCommit ?? null
  );
  return getSessionById(id)!;
}

export function setSessionGitBaseline(id: string, sha: string | null): void {
  getDb()
    .prepare('UPDATE sessions SET git_baseline_commit = ? WHERE id = ?')
    .run(sha, id);
}

export function updateSession(id: string, data: Partial<{
  name: string;
  command: string;
  workingDirectory: string | null;
  autostart: boolean;
  autorestart: boolean;
  autorestartMax: number;
  autorestartDelayMs: number;
  autorestartWindowSecs: number;
  autorespawn: boolean;
  terminalAlerts: boolean;
  fileWatchPatterns: string[];
  agentProvider: 'claude' | 'codex' | 'hermes';
  model: string | null;
  agentSessionId: string | null;
  agentSessionIdHistory: string[];
  claudeSessionId: string | null;
  claudeSessionIdHistory: string[];
  tags: string[];
  mode: 'default' | 'plan' | 'accept-edits' | 'auto' | 'chat' | 'read-only';
  scratchpad: string;
  lastActiveAt: number;
}>): SessionRecord | null {
  const fields: string[] = [];
  const values: any[] = [];

  const fieldMap: Record<string, string> = {
    name: 'name',
    command: 'command',
    workingDirectory: 'working_directory',
    autostart: 'autostart',
    autorestart: 'autorestart',
    autorestartMax: 'autorestart_max',
    autorestartDelayMs: 'autorestart_delay_ms',
    autorestartWindowSecs: 'autorestart_window_secs',
    autorespawn: 'autorespawn',
    terminalAlerts: 'terminal_alerts',
    agentProvider: 'agent_provider',
    model: 'model',
    agentSessionId: 'agent_session_id',
    claudeSessionId: 'claude_session_id',
    scratchpad: 'scratchpad',
    lastActiveAt: 'last_active_at',
    mode: 'mode',
  };

  for (const [key, col] of Object.entries(fieldMap)) {
    if ((data as any)[key] !== undefined) {
      fields.push(`${col} = ?`);
      const val = (data as any)[key];
      if (typeof val === 'boolean') {
        values.push(val ? 1 : 0);
      } else {
        values.push(val);
      }
    }
  }

  if (data.fileWatchPatterns !== undefined) {
    fields.push('file_watch_patterns = ?');
    values.push(JSON.stringify(data.fileWatchPatterns));
  }

  if (data.claudeSessionIdHistory !== undefined) {
    fields.push('claude_session_id_history = ?');
    values.push(JSON.stringify(data.claudeSessionIdHistory));
  }

  if (data.agentSessionIdHistory !== undefined) {
    fields.push('agent_session_id_history = ?');
    values.push(JSON.stringify(data.agentSessionIdHistory));
  }

  if (data.tags !== undefined) {
    fields.push('tags = ?');
    values.push(JSON.stringify(data.tags));
  }

  if (fields.length === 0) return getSessionById(id);
  values.push(id);
  getDb().prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const updated = getSessionById(id);

  // Whenever a claudeSessionId (current or historical) becomes known for a
  // session, bind it to that session's loader variant in the persistence
  // table. The binding survives session-row deletion, so transcript-resume
  // recovers the same loader for the same conversation.
  if (
    updated?.loaderVariant &&
    (data.claudeSessionId !== undefined || data.claudeSessionIdHistory !== undefined)
  ) {
    const ids = new Set<string>();
    if (updated.claudeSessionId) ids.add(updated.claudeSessionId);
    for (const hid of updated.claudeSessionIdHistory) ids.add(hid);
    for (const cid of ids) recordClaudeSessionLoader(cid, updated.loaderVariant);
  }

  return updated;
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function getSessionByClaudeId(claudeSessionId: string): SessionRecord | null {
  const row = getDb().prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(claudeSessionId) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

// ─── Session Events ───────────────────────────────────────────────────────────

export function insertSessionEvent(sessionId: string, eventType: string, payload?: any): void {
  const id = uuidv4();
  const now = Date.now();
  getDb().prepare(
    'INSERT INTO session_events (id, session_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, sessionId, eventType, payload ? JSON.stringify(payload) : null, now);
}

export function getSessionEvents(sessionId: string): Array<{ id: string; eventType: string; payload: any; createdAt: number }> {
  const rows = getDb().prepare(
    'SELECT * FROM session_events WHERE session_id = ? ORDER BY created_at ASC'
  ).all(sessionId) as any[];
  return rows.map(r => ({
    id: r.id,
    eventType: r.event_type,
    payload: r.payload ? JSON.parse(r.payload) : null,
    createdAt: r.created_at,
  }));
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export interface CommandRow {
  id: string;
  project_id: string;
  name: string;
  command: string;
  working_directory: string | null;
  autostart: number;
  autorestart: number;
  autorestart_max: number;
  autorestart_delay_ms: number;
  autorestart_window_secs: number;
  terminal_alerts: number;
  file_watch_patterns: string;
  created_at: number;
}

export interface CommandRecord {
  id: string;
  projectId: string;
  name: string;
  command: string;
  workingDirectory: string | null;
  autostart: boolean;
  autorestart: boolean;
  autorestartMax: number;
  autorestartDelayMs: number;
  autorestartWindowSecs: number;
  terminalAlerts: boolean;
  fileWatchPatterns: string[];
  createdAt: number;
}

function rowToCommand(row: CommandRow): CommandRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    command: row.command,
    workingDirectory: row.working_directory,
    autostart: row.autostart === 1,
    autorestart: row.autorestart === 1,
    autorestartMax: row.autorestart_max,
    autorestartDelayMs: row.autorestart_delay_ms,
    autorestartWindowSecs: row.autorestart_window_secs,
    terminalAlerts: row.terminal_alerts === 1,
    fileWatchPatterns: JSON.parse(row.file_watch_patterns || '[]'),
    createdAt: row.created_at,
  };
}

export function getCommandsByProject(projectId: string): CommandRecord[] {
  const rows = getDb().prepare('SELECT * FROM commands WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as CommandRow[];
  return rows.map(rowToCommand);
}

export function getCommandById(id: string): CommandRecord | null {
  const row = getDb().prepare('SELECT * FROM commands WHERE id = ?').get(id) as CommandRow | undefined;
  return row ? rowToCommand(row) : null;
}

export function getAllCommands(): CommandRecord[] {
  const rows = getDb().prepare('SELECT * FROM commands ORDER BY created_at ASC').all() as CommandRow[];
  return rows.map(rowToCommand);
}

export function createCommand(data: {
  projectId: string;
  name: string;
  command: string;
  workingDirectory?: string | null;
  autostart?: boolean;
  autorestart?: boolean;
  autorestartMax?: number;
  autorestartDelayMs?: number;
  autorestartWindowSecs?: number;
  terminalAlerts?: boolean;
  fileWatchPatterns?: string[];
}): CommandRecord {
  const id = uuidv4();
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO commands (
      id, project_id, name, command, working_directory,
      autostart, autorestart, autorestart_max, autorestart_delay_ms,
      autorestart_window_secs, terminal_alerts, file_watch_patterns, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.projectId,
    data.name,
    data.command,
    data.workingDirectory ?? null,
    data.autostart ? 1 : 0,
    data.autorestart ? 1 : 0,
    data.autorestartMax ?? 5,
    data.autorestartDelayMs ?? 2000,
    data.autorestartWindowSecs ?? 60,
    data.terminalAlerts ? 1 : 0,
    JSON.stringify(data.fileWatchPatterns ?? []),
    now
  );
  return getCommandById(id)!;
}

export function updateCommand(id: string, data: Partial<{
  name: string;
  command: string;
  workingDirectory: string | null;
  autostart: boolean;
  autorestart: boolean;
  autorestartMax: number;
  autorestartDelayMs: number;
  autorestartWindowSecs: number;
  terminalAlerts: boolean;
  fileWatchPatterns: string[];
}>): CommandRecord | null {
  const fields: string[] = [];
  const values: any[] = [];

  const fieldMap: Record<string, string> = {
    name: 'name',
    command: 'command',
    workingDirectory: 'working_directory',
    autostart: 'autostart',
    autorestart: 'autorestart',
    autorestartMax: 'autorestart_max',
    autorestartDelayMs: 'autorestart_delay_ms',
    autorestartWindowSecs: 'autorestart_window_secs',
    terminalAlerts: 'terminal_alerts',
  };

  for (const [key, col] of Object.entries(fieldMap)) {
    if ((data as any)[key] !== undefined) {
      fields.push(`${col} = ?`);
      const val = (data as any)[key];
      if (typeof val === 'boolean') {
        values.push(val ? 1 : 0);
      } else {
        values.push(val);
      }
    }
  }

  if (data.fileWatchPatterns !== undefined) {
    fields.push('file_watch_patterns = ?');
    values.push(JSON.stringify(data.fileWatchPatterns));
  }

  if (fields.length === 0) return getCommandById(id);
  values.push(id);
  getDb().prepare(`UPDATE commands SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getCommandById(id);
}

export function deleteCommand(id: string): void {
  getDb().prepare('DELETE FROM commands WHERE id = ?').run(id);
}

// ─── Terminals ────────────────────────────────────────────────────────────────

export interface TerminalRow {
  id: string;
  project_id: string;
  name: string;
  shell: string | null;
  working_directory: string | null;
  created_at: number;
}

export interface TerminalRecord {
  id: string;
  projectId: string;
  name: string;
  shell: string | null;
  workingDirectory: string | null;
  createdAt: number;
}

function rowToTerminal(row: TerminalRow): TerminalRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    shell: row.shell,
    workingDirectory: row.working_directory,
    createdAt: row.created_at,
  };
}

export function getTerminalsByProject(projectId: string): TerminalRecord[] {
  const rows = getDb().prepare('SELECT * FROM terminals WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as TerminalRow[];
  return rows.map(rowToTerminal);
}

export function getTerminalById(id: string): TerminalRecord | null {
  const row = getDb().prepare('SELECT * FROM terminals WHERE id = ?').get(id) as TerminalRow | undefined;
  return row ? rowToTerminal(row) : null;
}

export function getAllTerminals(): TerminalRecord[] {
  const rows = getDb().prepare('SELECT * FROM terminals ORDER BY created_at ASC').all() as TerminalRow[];
  return rows.map(rowToTerminal);
}

export function createTerminal(data: {
  projectId: string;
  name: string;
  shell?: string | null;
  workingDirectory?: string | null;
}): TerminalRecord {
  const id = uuidv4();
  const now = Date.now();
  getDb().prepare(
    'INSERT INTO terminals (id, project_id, name, shell, working_directory, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, data.projectId, data.name, data.shell ?? null, data.workingDirectory ?? null, now);
  return getTerminalById(id)!;
}

export function updateTerminal(id: string, data: Partial<{
  name: string;
  shell: string | null;
  workingDirectory: string | null;
}>): TerminalRecord | null {
  const fields: string[] = [];
  const values: any[] = [];

  const fieldMap: Record<string, string> = {
    name: 'name',
    shell: 'shell',
    workingDirectory: 'working_directory',
  };

  for (const [key, col] of Object.entries(fieldMap)) {
    if ((data as any)[key] !== undefined) {
      fields.push(`${col} = ?`);
      values.push((data as any)[key]);
    }
  }

  if (fields.length === 0) return getTerminalById(id);
  values.push(id);
  getDb().prepare(`UPDATE terminals SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getTerminalById(id);
}

export function deleteTerminal(id: string): void {
  getDb().prepare('DELETE FROM terminals WHERE id = ?').run(id);
}

// ─── Cost Records ─────────────────────────────────────────────────────────────

export function insertCostRecord(data: {
  sessionId: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model?: string;
}): void {
  const id = uuidv4();
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO cost_records (id, session_id, timestamp, tokens_in, tokens_out, cost_usd, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.sessionId, now, data.tokensIn, data.tokensOut, data.costUsd, data.model ?? null, now);
}

export function getSessionCostAggregate(sessionId: string): { tokensIn: number; tokensOut: number; costUsd: number } {
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(tokens_in), 0) as tokens_in,
           COALESCE(SUM(tokens_out), 0) as tokens_out,
           COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM cost_records WHERE session_id = ?
  `).get(sessionId) as any;
  return {
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
  };
}

export function getCostRecordsBySession(sessionId: string): any[] {
  return getDb().prepare(
    'SELECT * FROM cost_records WHERE session_id = ? ORDER BY timestamp ASC'
  ).all(sessionId);
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export type NoteScope = 'session' | 'project';

export interface Note {
  id: string;
  projectId: string;
  sessionId: string | null;
  scope: NoteScope;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

interface NoteRow {
  id: string;
  project_id: string;
  session_id: string | null;
  scope: NoteScope;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    scope: row.scope,
    title: row.title ?? '',
    content: row.content ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Notes relevant to a session: its own session-scoped notes plus every
// project-scoped note in its project.
export function listNotesForSession(sessionId: string, projectId: string): Note[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM notes
       WHERE (scope = 'session' AND session_id = ?)
          OR (scope = 'project' AND project_id = ?)
       ORDER BY updated_at DESC`
    )
    .all(sessionId, projectId) as NoteRow[];
  return rows.map(rowToNote);
}

export function listProjectNotes(projectId: string): Note[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM notes WHERE project_id = ? AND scope = 'project' ORDER BY updated_at DESC`
    )
    .all(projectId) as NoteRow[];
  return rows.map(rowToNote);
}

export function getNote(id: string): Note | null {
  const row = getDb().prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
  return row ? rowToNote(row) : null;
}

export function createNote(input: {
  projectId: string;
  sessionId: string | null;
  scope: NoteScope;
  title?: string;
  content?: string;
}): Note {
  const id = uuidv4();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO notes (id, project_id, session_id, scope, title, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.projectId,
      input.scope === 'session' ? input.sessionId : null,
      input.scope,
      input.title ?? '',
      input.content ?? '',
      now,
      now,
    );
  return getNote(id)!;
}

export function updateNote(
  id: string,
  patch: { title?: string; content?: string; scope?: NoteScope; sessionId?: string | null }
): Note | null {
  const existing = getNote(id);
  if (!existing) return null;

  const nextScope = patch.scope ?? existing.scope;
  const nextSessionId =
    patch.sessionId !== undefined
      ? patch.sessionId
      : nextScope === 'project'
        ? null
        : existing.sessionId;

  getDb()
    .prepare(
      `UPDATE notes
         SET title = COALESCE(?, title),
             content = COALESCE(?, content),
             scope = ?,
             session_id = ?,
             updated_at = ?
       WHERE id = ?`
    )
    .run(
      patch.title ?? null,
      patch.content ?? null,
      nextScope,
      nextSessionId,
      Date.now(),
      id,
    );

  return getNote(id);
}

export function deleteNote(id: string): void {
  getDb().prepare('DELETE FROM notes WHERE id = ?').run(id);
}

// ─── Search ───────────────────────────────────────────────────────────────────

export function searchSessions(query: string): SessionRecord[] {
  const pattern = `%${query}%`;
  const rows = getDb().prepare(
    'SELECT * FROM sessions WHERE name LIKE ? OR command LIKE ? ORDER BY created_at DESC LIMIT 50'
  ).all(pattern, pattern) as SessionRow[];
  return rows.map(rowToSession);
}

export function searchCommands(query: string): CommandRecord[] {
  const pattern = `%${query}%`;
  const rows = getDb().prepare(
    'SELECT * FROM commands WHERE name LIKE ? OR command LIKE ? ORDER BY created_at DESC LIMIT 50'
  ).all(pattern, pattern) as CommandRow[];
  return rows.map(rowToCommand);
}
