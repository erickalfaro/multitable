import type { AgentSession } from '../types.js';
import type { Message } from '../../transcripts/parser.js';

// What a provider adapter calls back into when it produces output. The
// AgentSessionManager owns the EventEmitter surface and the lifecycle state
// machine; adapters only translate SDK events into this shape.
export interface AdapterCallbacks {
  // Final assistant or tool messages — drive the chat UI.
  emitAssistantMessage(messages: Message[]): void;
  // In-flight assistant text — drives the live streaming preview.
  emitAssistantDelta(text: string): void;
  emitToolEvent(messages: Message[]): void;
  emitUserMessage(messages: Message[]): void;
  // Provider learned (or re-learned) the canonical session id for this
  // conversation. Manager updates AgentSession + DB.
  onSessionIdAssigned(newId: string, history: string[]): void;
  // Snapshot of cumulative cost / token / currentTool for the live state pane.
  emitStateSnapshot(): void;
  // Append the message list to AgentSession.messages — manager owns the
  // dedupe/persistence policy.
  pushMessages(messages: Message[]): void;
  // Cumulative usage updates (tokens/cost) for the result row.
  applyUsage(input: {
    tokensIn: number;
    tokensOut: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  }): void;
  // Surface a successful turn-result for toast / cost / `/cost`.
  emitTurnResult(input: {
    subtype: string;
    totalCostUsd: number;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
    };
    text: string | null;
  }): void;
  // Tool name shown in the live state pane while a tool is running.
  setCurrentTool(name: string | null): void;
  // Bump the activity clock — drives the "running for ___" badge.
  bumpActivity(): void;
  // First-prompt detection for AI rename.
  maybeRenameFromFirstPrompt(prompt: string): void;
  // Daemon-side guarantee tick: the adapter has just diffed in-memory state
  // against its authoritative on-disk log and broadcast any missing items.
  // Manager re-emits as `session:reconciled` so the frontend can do a no-op
  // REST sync to confirm consistency.
  emitReconciled(addedMessageIds: string[]): void;
  // Live in-progress tool execution snapshot — fires on every item.updated
  // for command_execution / file_change / mcp_tool_call / web_search items
  // so the chat UI can render the cumulative output as it arrives, before
  // the canonical tool_use/tool_result messages land at item.completed. Pass
  // `null` to clear the live slot (tool finished, switched, or turn ended).
  emitToolDelta(payload: ToolDeltaPayload | null): void;
  // Live reasoning text — codex emits a stream of model thinking that we
  // surface as an italic preview while the agent is mid-turn. Empty string
  // clears.
  emitReasoningDelta(text: string): void;
  // The optimistic message that was broadcast with `oldId` is now known to
  // be the same logical message as the one with the canonical `newId` (e.g.
  // the user's prompt that was pushed with a temp id, then matched against
  // the codex JSONL after the turn). Frontend updates its store id in place.
  // This is the SOTA pattern for optimistic-UI reconciliation — the same
  // shape Linear/Figma/Slack use for client-temp-id → server-canonical-id.
  emitMessageRekey(oldId: string, newId: string): void;
  // Surface a unified alert envelope (toast / chime / NotificationCenter).
  // Adapters call this for provider-side notifications, errors, etc. that
  // don't fit the message stream — e.g. rate-limit, auth, compaction.
  emitAlert(input: {
    category:
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
    severity: 'info' | 'success' | 'warning' | 'error' | 'attention';
    title: string;
    body?: string;
    needsAttention?: boolean;
    persistent?: boolean;
    ttlMs?: number;
    metadata?: Record<string, unknown>;
  }): void;
  // Update s.toolCount and s.activeSubagents counters (subagent lifecycle).
  incrementToolCount(): void;
  incrementSubagents(delta: 1 | -1): void;
  // Mark session as "needs attention" via SDK Notification hook.
  emitNotification(payload: unknown): void;
  // Session-end signal from the SDK (SessionEnd hook fired). Distinct from
  // turn-complete: the agent itself is done, not just the current turn.
  emitSessionEnded(): void;
}

export interface ToolDeltaPayload {
  toolName: string;
  input: unknown;
  output: string;
  isError: boolean;
}

// === SessionMode ===========================================================
//
// Provider-agnostic operating mode for a session. Each provider translates
// these to its native primitives:
//   - Claude   → permissionMode + system prompt
//   - Codex    → sandboxMode + (system prompt at session level not exposed)
//   - Copilot  → systemMessage + onPreToolUse shaping
//
// Adapters declare which modes they support via ProviderCapabilities.modes.
// The UI hides modes the current provider can't honor.

export type SessionMode =
  | 'default'      // normal: tools execute, prompts on demand
  | 'plan'         // read-only research: produce a plan, no edits
  | 'accept-edits' // auto-approve all tool calls
  | 'auto'         // bypass all permissions (advanced)
  | 'chat'         // conversation only, no tool execution
  | 'read-only';   // no mutations, but tools other than write run

// === ProviderCapabilities ==================================================
//
// What the adapter can and cannot do. The manager exposes this to the UI so
// rendering stays provider-agnostic — no `provider === 'claude'` branches in
// React code.

export interface ProviderCapabilities {
  // Cost surface: true = USD column shown; false = hidden (Codex).
  costUsd: boolean;
  // Plan-mode flavor: 'native' = first-class (Claude permissionMode='plan');
  // 'simulated' = host-side workaround; 'none' = no plan-mode toggle in UI.
  planMode: 'native' | 'simulated' | 'none';
  // Per-call host approval mechanism — affects PermissionManager wiring.
  perCallApproval: 'callback' | 'sandbox' | 'callback+kind';
  // How user-question-from-agent is delivered.
  userQuestion: 'tool' | 'callback' | 'unsupported';
  // MCP elicitation forms / URL flow supported.
  elicitation: boolean;
  // Subagent model.
  subagents: 'manual' | 'auto' | 'none';
  // Can host inject input mid-stream / steer the agent.
  midTurnInput: boolean;
  // Bring-your-own-key (per-session provider override).
  byok: boolean;
  // OS-level sandbox (vs soft permission gating).
  hardSandbox: boolean;
  // Lifecycle hook richness.
  hooks: 'rich' | 'six' | 'none';
  // Streaming text delta semantics — affects the StreamBuffer reducer.
  streamingDeltaSemantics: 'additive' | 'cumulative';
  // When the model id can be changed.
  modelSwitchScope: 'per-turn' | 'per-thread' | 'per-session';
  // Modes the adapter actually implements. UI hides others.
  modes: SessionMode[];
}

// === ProviderAdapter =======================================================
//
// Adapter contract. Each provider (claude, codex, copilot, …) implements
// this. The manager picks an adapter by AgentSession.provider and dispatches
// uniformly:
//   manager.sendTurn → adapter.runTurn
//   manager.abortTurn → adapter.abortTurn (optional override; default just
//                       uses the AbortController from the in-flight turn)
//   manager.resetSession → adapter.reset
//   manager.remove → adapter.destroy
//
// Adapters know NOTHING about WS, the store, REST routes, or the DB. They
// speak only this interface upward and the SDK API downward.

export interface ProviderAdapter {
  readonly name: 'claude' | 'codex' | 'copilot';
  readonly capabilities: ProviderCapabilities;

  // Drive one user turn. The adapter must respect `ctrl` for cancellation.
  // Runs to completion (success or error); throws on error so the manager
  // can surface a turn-error event.
  runTurn(s: AgentSession, text: string, ctrl: AbortController, cb: AdapterCallbacks): Promise<void>;

  // Optional: mint a provider-side session id WITHOUT running a turn. Called
  // by the manager right after register() during session creation so the
  // chat is "live" the moment the user clicks Start (transcript file exists,
  // resume is possible). The adapter MUST call cb.onSessionIdAssigned when it
  // learns the id and otherwise stay silent — no pushMessages, no applyUsage,
  // no emitTurnResult. Errors should propagate so the manager can log them
  // without breaking session creation.
  provisionSession?(s: AgentSession, ctrl: AbortController, cb: AdapterCallbacks): Promise<void>;

  // Optional: clean up per-session adapter caches. Called from /reset.
  reset?(s: AgentSession): void;

  // Optional: tear down per-session resources entirely. Called from session
  // delete. For Copilot this will eventually call session.disconnect().
  destroy?(s: AgentSession): void | Promise<void>;

  // Optional: tear down daemon-wide adapter resources (long-lived child
  // processes, singleton clients). Called from the daemon's SIGTERM handler.
  shutdown?(): void | Promise<void>;
}
