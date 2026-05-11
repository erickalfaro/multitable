CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  shortcut INTEGER,
  icon TEXT,
  is_active INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  working_directory TEXT,
  type TEXT NOT NULL DEFAULT 'session',
  autostart INTEGER DEFAULT 0,
  autorestart INTEGER DEFAULT 0,
  autorestart_max INTEGER DEFAULT 5,
  autorestart_delay_ms INTEGER DEFAULT 2000,
  autorestart_window_secs INTEGER DEFAULT 60,
  autorespawn INTEGER DEFAULT 1,
  terminal_alerts INTEGER DEFAULT 0,
  file_watch_patterns TEXT DEFAULT '[]',
  agent_provider TEXT DEFAULT 'claude',
  model TEXT,
  agent_session_id TEXT,
  agent_session_id_history TEXT DEFAULT '[]',
  claude_session_id TEXT,
  claude_session_id_history TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  mode TEXT DEFAULT 'default',
  scratchpad TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  last_active_at INTEGER,
  loader_variant TEXT,
  git_baseline_commit TEXT
);

CREATE TABLE IF NOT EXISTS claude_session_loaders (
  claude_session_id TEXT PRIMARY KEY,
  loader_variant TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  working_directory TEXT,
  autostart INTEGER DEFAULT 0,
  autorestart INTEGER DEFAULT 0,
  autorestart_max INTEGER DEFAULT 5,
  autorestart_delay_ms INTEGER DEFAULT 2000,
  autorestart_window_secs INTEGER DEFAULT 60,
  terminal_alerts INTEGER DEFAULT 0,
  file_watch_patterns TEXT DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  shell TEXT,
  working_directory TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_records (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  timestamp INTEGER NOT NULL,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  model TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('session', 'project')),
  title TEXT DEFAULT '',
  content TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_commands_project ON commands(project_id);
CREATE INDEX IF NOT EXISTS idx_terminals_project ON terminals(project_id);
CREATE INDEX IF NOT EXISTS idx_cost_records_session ON cost_records(session_id);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);
CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(session_id);
