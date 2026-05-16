export type ProcessType = 'session' | 'terminal' | 'command';
export type ProcessState = 'running' | 'idle' | 'stopped' | 'errored';
export type AgentProvider = 'claude' | 'codex' | 'hermes' | 'copilot';

// Mirrors the daemon's `/api/providers/:provider/models` row shape. Lives here
// so both AddAgentModal (one-shot fetch on session create) and the appStore
// catalog cache (long-lived, used by ModelChip) can consume the same type.
export interface DiscoveredModel {
  id: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  // Per-model reasoning-effort support. The badge gates its dropdown by
  // these fields: `supportsEffort=false` disables the badge entirely; an
  // `effortLevels` array filters which levels are shown.
  supportsEffort?: boolean;
  effortLevels?: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

// Single entry in `ProviderCapabilities.modes`. The `value` is the literal
// native SDK string the adapter declared (Claude `PermissionMode`, Codex
// `SandboxMode`, etc.) — UI renders it verbatim, API/store passes it back
// to the adapter unchanged. There is no MultiTable-side translation layer.
export interface ModeOption {
  value: string;
  label: string;
  description: string;
}

// Cross-provider reasoning-effort level. Mirrors daemon's ThinkingEffort and
// the Claude SDK's EffortLevel enum (low / medium / high / xhigh / max).
// Each model exposes the subset it supports via DiscoveredModel.effortLevels;
// the badge filters its dropdown to that subset.
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// Mirrors daemon's ProviderCapabilities — what the adapter can do, used by the
// React layer to gate UI without provider-name branching.
export interface ProviderCapabilities {
  costUsd: boolean;
  planMode: 'native' | 'simulated' | 'none';
  perCallApproval: 'callback' | 'sandbox' | 'callback+kind';
  userQuestion: 'tool' | 'callback' | 'unsupported';
  elicitation: boolean;
  subagents: 'manual' | 'auto' | 'none';
  midTurnInput: boolean;
  byok: boolean;
  hardSandbox: boolean;
  hooks: 'rich' | 'six' | 'none';
  streamingDeltaSemantics: 'additive' | 'cumulative';
  modelSwitchScope: 'per-turn' | 'per-thread' | 'per-session';
  modes: ModeOption[];
  // Cross-provider reasoning-effort toggle. 'native' = adapter passes the
  // value through to the SDK; 'unsupported' = UI renders the badge disabled.
  thinkingEffort: 'native' | 'unsupported';
}

export interface ProcessConfig {
  autostart: boolean;
  autorestart: boolean;
  autorestartMax: number;
  autorestartDelayMs: number;
  autorestartWindowSecs: number;
  autorespawn: boolean;
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
  pid: number | null;
  startedAt: string | null;
  restartCount: number;
  metrics: ProcessMetrics;
}

export interface ClaudeSessionState {
  agentProvider: AgentProvider;
  agentSessionId: string | null;
  // Mirror the agent session id under the legacy name for back-compat with any
  // older code path that still reads `claudeSessionId`. New code should read
  // `agentSessionId`.
  claudeSessionId: string | null;
  currentTool: string | null;
  toolCount: number;
  tokenCount: number;
  costUsd: number;
  lastActivity: number;
  activeSubagents: number;
  userMessages: string[];
}

export interface Session extends ManagedProcess {
  type: 'session';
  agentProvider: AgentProvider;
  // Provider model id selected when the session was created. Null when the
  // user accepted the provider default. Sent on every turn so the daemon
  // pins the same model across resumes.
  model: string | null;
  // Native operating mode for this session. The string is whatever the
  // adapter declared in `capabilities.modes` (Claude `PermissionMode`, Codex
  // `SandboxMode`) — passed straight through to the SDK by the daemon. The
  // UI looks the value up in `capabilities.modes` for its label/description.
  mode: string;
  // Reasoning-effort level (low / medium / high / xhigh / max). Null means
  // "use provider default". Persisted; flows through to the SDK on the next
  // turn for providers that support it. The two highest tiers are gated
  // per-model via DiscoveredModel.effortLevels.
  thinkingEffort?: ThinkingEffort | null;
  // Adapter-declared capability bag. UI gates features on this rather than
  // branching on provider name. Null until the daemon attaches it.
  capabilities?: ProviderCapabilities | null;
  agentSessionId: string | null;
  agentSessionIdHistory: string[];
  // Legacy alias of agentSessionId — the daemon still emits both during the
  // back-compat window. Prefer agentSessionId for new code.
  claudeSessionId?: string | null;
  claudeState?: ClaudeSessionState; // in-memory — lost on daemon restart
  scratchpad?: string;
  loaderVariant?: string | null; // dot-matrix loader assigned at session creation
  createdAt?: number;
  lastActiveAt?: number | null; // bumped per turn boundary so the sidebar can sort by recency
}

export interface Command extends ManagedProcess {
  type: 'command';
}

export interface Terminal extends ManagedProcess {
  type: 'terminal';
}

export interface Project {
  id: string;
  name: string;
  path: string;
  shortcut: number | null;
  icon: string | null;
  isActive: boolean;
  createdAt: number;
  sessions?: Session[];
  commands?: Command[];
  terminals?: Terminal[];
}

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

export interface PermissionPrompt {
  id: string;
  sessionId: string;
  claudeSessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  createdAt: number;
  kind?: 'permission' | 'ask-question';
  questions?: AskQuestion[];
  // Phase 5 SDK extras (optional). The existing UI doesn't render these
  // yet — they're plumbed through the wire so future work can use the
  // SDK's pre-rendered strings instead of re-deriving from toolName.
  title?: string;
  displayName?: string;
  subtitle?: string;
  blockedPath?: string;
}

export interface OptionPrompt {
  sessionId: string;
  question: string;
  options: string[];
}

// ─── Alerts (mirrors daemon agent/types.ts) ────────────────────────────────

export type AlertSeverity = 'info' | 'success' | 'warning' | 'error' | 'attention';

export type AlertCategory =
  | 'turn'
  | 'tool'
  | 'permission'
  | 'elicitation'
  | 'rate-limit'
  | 'auth'
  | 'task'
  | 'compaction'
  | 'sync'
  | 'budget'
  | 'status';

export interface SessionAlert {
  alertId: string;
  sessionId: string;
  category: AlertCategory;
  severity: AlertSeverity;
  title: string;
  body?: string;
  needsAttention: boolean;
  persistent: boolean;
  ttlMs?: number;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface ElicitationPrompt {
  id: string;
  sessionId: string;
  serverName: string;
  message: string;
  mode: 'form' | 'url';
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  createdAt: number;
}

export interface WsMessage {
  type: string;
  processId?: string;
  payload: unknown;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export type Message =
  | { id: string; ts: number; kind: 'user'; text: string }
  | { id: string; ts: number; kind: 'assistant'; text: string; model: string; usage?: Usage }
  | {
      id: string;
      ts: number;
      kind: 'tool_use';
      parentId: string;
      toolUseId: string;
      toolName: string;
      input: unknown;
    }
  | {
      id: string;
      ts: number;
      kind: 'tool_result';
      toolUseId: string;
      output: string;
      isError?: boolean;
    }
  | { id: string; ts: number; kind: 'system'; text: string }
  | { id: string; ts: number; kind: 'reasoning'; text: string };

export interface GlobalConfig {
  theme: 'light' | 'dark' | 'system';
  defaultEditor: string;
  defaultShell: string;
  terminalFontSize: number;
  terminalScrollback: number;
  notifications: boolean;
  port: number;
  host: string;
}

export interface TelegramIntegrationView {
  hasToken: boolean;
  tokenSource: 'env' | 'file' | 'none';
  chatIds: number[];
  sendNotifications: boolean;
  sendAlerts: boolean;
  dashboardUrl: string;
  running: boolean;
}

export interface TelegramIntegrationUpdate {
  token?: string | null;
  chatIds?: number[];
  sendNotifications?: boolean;
  sendAlerts?: boolean;
  dashboardUrl?: string;
}

// ─── Git ────────────────────────────────────────────────────────────────────

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
  oldPath?: string;
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
  head: string | null;
}

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  date: number;
  subject: string;
  body: string;
}

export interface GitBranchList {
  current: string | null;
  local: string[];
  remotes: string[];
}
