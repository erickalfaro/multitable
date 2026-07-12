export type ProcessType = 'session' | 'terminal' | 'command';
export type ProcessState = 'running' | 'idle' | 'stopped' | 'errored';

export interface ProcessConfig {
  autostart: boolean;
  autorestart: boolean;
  autorestartMax: number;        // default 5
  autorestartDelayMs: number;    // default 2000
  autorestartWindowSecs: number; // reset restartCount after this (default 60)
  autorespawn: boolean;          // respawn PTY on subscribe if dead
  terminalAlerts: boolean;
  fileWatchPatterns: string[];
}

export interface ProcessMetrics {
  cpuPercent: number;
  memoryBytes: number;
  detectedPort: number | null;
}

export interface ManagedProcess {
  id: string;
  name: string;
  command: string;
  workingDir: string;
  type: ProcessType;
  projectId: string;
  config: ProcessConfig;
  state: ProcessState;
  pty: any | null;  // IPty from node-pty
  pid: number | null;
  startedAt: Date | null;
  restartCount: number;
  lastRestartAt: number; // unix ms
  outputBuffer: any;  // RingBuffer
  metrics: ProcessMetrics;
}

export interface WsMessage {
  type: string;
  processId?: string;
  payload: any;
}

export interface WsClientState {
  subscribedProcess: string | null;
  cleanups: Array<() => void>;
  alive: boolean;
}

export interface AskQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: AskQuestionOption[];
  multiSelect?: boolean;
}

export interface ElicitationPrompt {
  id: string;                       // multitable-generated uuid
  sessionId: string;
  serverName: string;               // MCP server requesting input
  message: string;
  mode: 'form' | 'url';
  url?: string;                     // 'url' mode only
  elicitationId?: string;           // SDK-side id (URL-mode correlation)
  requestedSchema?: Record<string, unknown>; // 'form' mode only
  title?: string;
  displayName?: string;
  description?: string;
  createdAt: number;
}

export interface PermissionPrompt {
  id: string;
  sessionId: string;
  claudeSessionId: string;
  toolName: string;
  toolInput: Record<string, any>;
  createdAt: number;
  // When set, this prompt is a structured AskUserQuestion payload rather
  // than a generic tool-permission gate. The frontend should render a
  // question UI instead of an Allow/Deny card.
  kind?: 'permission' | 'ask-question';
  questions?: AskQuestion[];
  // Phase 5 SDK extras: when the SDK's canUseTool callback fires, the
  // options bag carries Claude-rendered labels for the permission card
  // (title/displayName/subtitle) plus blockedPath when the gate fired
  // because of a path-scope check. Plumbed through the WS so future UI
  // work can render Claude's own strings instead of re-deriving from
  // toolName.
  title?: string;
  displayName?: string;
  subtitle?: string;
  blockedPath?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  shortcut: number | null;
  icon: string | null;
  isActive: boolean;
  createdAt: number;
}

export interface TelegramIntegrationConfig {
  enabled?: boolean;
  chatIds?: number[];
  sendNotifications?: boolean;
  sendAlerts?: boolean;
  // Public base URL the user's phone can reach (e.g. via Tailscale).
  // When set, Telegram messages include an "Open in dashboard" deep link
  // pointing at <dashboardUrl>/#permission=<id> for rich interaction.
  dashboardUrl?: string;
}

export interface IntegrationsConfig {
  telegram?: TelegramIntegrationConfig;
}

export interface GlobalConfig {
  theme: 'light' | 'dark' | 'system';
  defaultEditor: string;
  defaultShell: string;
  terminalFontSize: number;
  terminalScrollback: number;
  notifications: boolean;
  port: number;
  host: string;
  projects: Array<{ path: string; shortcut?: number }>;
  integrations?: IntegrationsConfig;
  // Sticky default for the per-session thinking-effort badge. Updated every
  // time the user flips the toggle on any session so the next new session
  // inherits their last choice. 'medium' is the seed value. The two higher
  // tiers (xhigh / max) are honored if the user lands here from a Claude
  // Opus session; new sessions on models that don't support them are clamped
  // to the model's max at session-create time by the UI.
  lastThinkingEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  // Zen redesign — Pinned Session Wall (plan §5.4). The user pins individual
  // sessions across projects; the no-selection homepage renders them as live
  // mini-chats in a responsive grid (desktop) or vertical feed (mobile).
  // Server-persisted so a browser swap or fresh load preserves the wall.
  pinnedSessionIds?: string[];

  ui?: {
    // Active theme id; mirrored to localStorage `mt:activeThemeId` for
    // instant pre-fetch on cold load, but this is the source of truth for
    // cross-browser sync.
    themeId?: string;
    // Chrome-on-intent toggle. When false, header bar / status bar render
    // at full opacity always (accessibility / preference). Default true.
    chromeAutoHide?: boolean;
    // Wall tile size preference. Cozy = larger tiles, more chat visible per
    // tile, fewer per row. Compact = denser grid.
    wallDensity?: 'cozy' | 'compact';
    // Region-aware wall layout (v2). The daemon persists it opaquely; the web
    // client owns the shape (see packages/web/src/lib/types.ts WallLayout).
    wallLayout?: WallLayout;
    // Lock toggle — when true tiles can't be dragged/resized.
    wallLayoutLocked?: boolean;
    // Left-nav preferences (project order + user dividers + manual hue
    // overrides). Persisted opaquely, like wallLayout; the web client owns
    // the shape (see packages/web/src/lib/types.ts ProjectNavPrefs).
    projectNav?: {
      entries: Array<{ kind: 'project' | 'divider'; id: string }>;
      colors?: Record<string, string>;
    };
  };
}

// Wall layout v2 — a vertical stack of regions, each a free-float grid.
// Mirrors packages/web/src/lib/types.ts; stored opaquely by the daemon.
export interface WallTile {
  sessionId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WallRegion {
  id: string;
  cols: number;
  tiles: WallTile[];
}

export interface WallLayout {
  version: 2;
  regions: WallRegion[];
}

export interface ProjectConfig {
  name?: string;
  sessions?: Array<{
    name: string;
    command: string;
    autostart?: boolean;
    working_directory?: string;
  }>;
  commands?: Array<{
    name: string;
    command: string;
    autostart?: boolean;
    autorestart?: boolean;
    terminal_alerts?: boolean;
    file_watching?: string[];
    working_directory?: string;
  }>;
  permissions?: {
    auto_defer?: string[];
  };
}

export interface SpawnConfig {
  id: string;
  name: string;
  command: string;
  workingDir: string;
  type: ProcessType;
  projectId: string;
  config: ProcessConfig;
  cols?: number;
  rows?: number;
}

// ─── Git ──────────────────────────────────────────────────────────────────────

export type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted';

export interface GitFileEntry {
  path: string;
  oldPath?: string; // set on rename / copy
  status: GitFileStatus;
}

export interface GitStatusSummary {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
  conflicted: GitFileEntry[];
  head: string | null; // current commit sha
}

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: number; // unix ms
  subject: string;
  body: string;
}

export interface GitBranchList {
  current: string | null;
  local: string[];
  remotes: string[];
}
