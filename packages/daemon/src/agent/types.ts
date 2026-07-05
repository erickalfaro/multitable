import type { ProcessState } from '../types.js';

export type AgentProvider = 'claude' | 'codex' | 'copilot' | 'hermes' | 'grok' | 'cursor';

// Cross-provider reasoning-effort level. Mirrors Claude SDK's full `EffortLevel`
// enum (sdk.d.ts:465): low / medium / high / xhigh / max. The two highest tiers
// have model gating —
//   • `xhigh` — Opus 4.7 only on the Claude side; falls back to `high` on
//     unsupported models. Codex accepts `xhigh` on every reasoning-capable model.
//   • `max`   — Opus 4.6/4.7 only on the Claude side. Codex's enum has no
//     `max` — the Codex adapter skips sending effort when this is set so the
//     server's default reasoning level kicks in instead of erroring.
// Each model declares which levels it actually supports via
// DiscoveredModel.effortLevels — the badge filters its dropdown to that subset.
// The capability flag 'unsupported' is reserved for future providers that
// can't surface a reasoning knob at all (both active providers — Claude and
// Codex — declare 'native').
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// ─── Usage limits ──────────────────────────────────────────────────────────
//
// Normalized, provider-agnostic snapshot of the active provider/model's current
// usage limits, feeding the always-present per-session indicator. Each provider
// reports limits in a different shape (Claude: a single rate_limit_info; Codex:
// primary/secondary windows + credits; Hermes/Grok: nothing live today); the
// adapter collapses its native shape into this. Cross-provider feature spec:
// docs/reference/USAGE_LIMITS.md.

export interface UsageLimitWindow {
  // Display label for the window, e.g. 'Session', 'Weekly', 'Primary', or a
  // provider-specific rate-limit type.
  label: string;
  // 0..100 — fraction of this window consumed.
  usedPercent: number;
  // ms-epoch when this window resets, or null if unknown.
  resetsAt: number | null;
  // Rolling-window length in minutes (Codex windowDurationMins), or null.
  windowDurationMins?: number | null;
}

export interface UsageLimitSnapshot {
  // 'live' = real data from the provider; 'unavailable' = provider has no live
  // limit feed (Hermes/Grok today); 'stale' = last-known but possibly old.
  status: 'live' | 'unavailable' | 'stale';
  // Which provider produced it (audit/debug; the UI stays provider-agnostic).
  source: AgentProvider;
  // Ordered windows. The collapsed badge shows the most-constraining (max
  // usedPercent); the popover lists all.
  windows: UsageLimitWindow[];
  // Optional plan label (Codex planType) for the popover header.
  planType?: string | null;
  // Optional remaining credits, when the provider reports them (Codex credits).
  creditsRemaining?: number | null;
  // ms-epoch when this snapshot was captured (drives "stale" UI + countdowns).
  capturedAt: number;
}

// What we emit on the WS for the session view.
export type AgentMessageOut =
  | { kind: 'assistant'; text: string; model?: string; ts: number }
  | { kind: 'tool_use'; toolUseId: string; toolName: string; input: unknown; ts: number }
  | { kind: 'tool_result'; toolUseId: string; output: string; isError?: boolean; ts: number }
  | { kind: 'user'; text: string; ts: number }
  | { kind: 'system'; text: string; ts: number }
  | { kind: 'reasoning'; text: string; ts: number };

export interface AgentSession {
  // === identity ===
  id: string; // multitable session id (DB primary key)
  projectId: string;
  name: string;
  workingDir: string;
  provider: AgentProvider;
  // Model id picked at session-create time. Passed through to the SDK on every
  // turn (Claude `query()` options.model, Codex `Thread` options.model). Null
  // means "let the provider use its own default".
  model: string | null;
  // Native operating mode for this session. The string is whatever the
  // adapter declared in `capabilities.modes` — passed straight through to
  // the SDK (Claude's PermissionMode for `claude`, Codex's SandboxMode for
  // `codex`). MultiTable does not invent values or translate between them.
  // Persisted across daemon restarts.
  mode: string;
  // Reasoning-effort level for this session. Persisted across restarts and
  // initialised from GlobalConfig.lastThinkingEffort on session create. Null
  // means "use provider default" (no `effort` field sent to the SDK).
  thinkingEffort: ThinkingEffort | null;
  // === provider link ===
  agentSessionId: string | null; // mirrored to DB; Claude session id or Codex thread id
  agentSessionIdHistory: string[];
  // Back-compat aliases used by the existing Claude-specific code paths and
  // frontend response shape during the provider migration.
  claudeSessionId: string | null;
  claudeSessionIdHistory: string[];
  // === lifecycle ===
  state: ProcessState; // 'running' while a turn is in-flight, else 'idle'/'stopped'/'errored'
  startedAt: Date | null;
  // === current turn ===
  currentTurn: {
    abortController: AbortController;
    startedAt: number;
    promptPreview: string;
    userMessageId: string;
  } | null;
  // === stats (replaces the in-memory ClaudeSessionState) ===
  totalCostUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  toolCount: number;
  currentTool: string | null;
  // Wall-clock ms when currentTool last transitioned to a non-null value
  // (null when no tool is running). The turn watchdog treats an in-flight
  // tool as a legitimate quiet window — providers like Hermes run long
  // terminal commands (builds, test suites, installs) with NO incremental
  // ACP output — but only up to a generous cap so a genuinely wedged tool
  // still trips the watchdog.
  currentToolStartedAt: number | null;
  activeSubagents: number;
  lastActivity: number;
  // Latest normalized usage-limit snapshot for the active provider/model. null
  // until the provider reports one (or for providers with no live feed).
  // In-memory only — not persisted to SQLite (limits are live/ephemeral); a
  // refreshed client re-hydrates via GET /api/sessions/:id/usage-limits.
  usageLimits: UsageLimitSnapshot | null;
  // Numbered-list options detected from the last completed turn's assistant
  // message (Claude only). Held in memory so a browser refresh can re-fetch
  // them via GET /api/pending-prompts; cleared when a new turn starts or the
  // user dismisses the selector.
  lastDetectedOptions: { question: string; options: string[] } | null;
  userMessages: string[]; // accumulated user prompts (used by AI rename)
  messages: import('../transcripts/parser.js').Message[]; // in-memory history for providers without JSONL parser support
  // === streaming (in-flight assistant text) ===
  // Accumulated text of the current text content block as it arrives via
  // stream_event deltas. Reset to '' on each content_block_start of type=text;
  // cleared on message_stop or turn-complete.
  streamingText: string;
  streamingBlockIndex: number | null;
}

export interface SendTurnInput {
  sessionId: string;
  text: string; // user prompt; may contain @file mentions, attachment paths
}

// ─── Alert envelope ────────────────────────────────────────────────────────
//
// Unified shape every notification-class signal funnels into. The frontend
// routes one event (`session:alert`) by severity → toast / chime / OS notif /
// NotificationCenter entry, instead of subscribing to N bespoke events.

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
