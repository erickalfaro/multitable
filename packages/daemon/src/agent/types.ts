import type { ProcessState } from '../types.js';
import type { SessionMode } from './providers/types.js';

export type AgentProvider = 'claude' | 'codex';

export type { SessionMode };

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
  // Operating mode for this session. Translates to provider-specific knobs
  // (Claude permissionMode, Codex sandboxMode, etc.) inside the adapter.
  // Defaults to 'default'. Persisted across daemon restarts.
  mode: SessionMode;
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
  activeSubagents: number;
  lastActivity: number;
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
