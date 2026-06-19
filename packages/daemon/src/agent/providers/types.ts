import type { AgentSession, UsageLimitSnapshot } from '../types.js';
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
  // Wholesale-replace the session's normalized usage-limit snapshot. Adapters
  // call this whenever the provider reports current limits — INCLUDING the
  // healthy case — so the always-present indicator has data even when nowhere
  // near a limit. Distinct from applyUsage (which is cumulative + writes
  // cost_records); a limit snapshot can arrive outside a turn. Pass
  // status:'unavailable' to advertise no live feed. See docs/reference/USAGE_LIMITS.md.
  applyUsageLimits(snapshot: UsageLimitSnapshot): void;
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
  // Provider produced a Tasks-panel event (subagent task, plan step, …).
  // `subtype` is 'task_started' | 'task_progress' | 'task_updated' |
  // 'task_notification'; `payload` is the Claude-native SDK shape the
  // frontend `applyTaskEvent` reducer consumes. Codex/Hermes normalize
  // their plan notifications INTO this shape.
  emitTaskEvent(subtype: string, payload: Record<string, unknown>): void;
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

// === ModeOption ============================================================
//
// A single entry in `ProviderCapabilities.modes`. Each adapter declares the
// list of modes its provider natively supports — the `value` is the literal
// string the SDK accepts (e.g. Claude's `PermissionMode` enum or Codex's
// `SandboxMode` enum). MultiTable does NOT invent extra modes or translate
// between provider primitives: whatever the adapter declares here is what
// goes straight back to the SDK on the next turn.

/** Risk tier of a mode. Purely a UI presentation hint — drives the color of
 * the behavior badge marker and the composer's send button so the active risk
 * posture is obvious at a glance. Adapter-declared (like label/description) so
 * the web side keeps zero hardcoded mode knowledge. */
export type ModeTone = 'safe' | 'standard' | 'elevated' | 'danger';

export interface ModeOption {
  /** Native SDK value passed through verbatim (e.g. 'acceptEdits' for Claude,
   * 'workspace-write' for Codex). */
  value: string;
  /** Display label — short, suitable for the dropdown trigger. */
  label: string;
  /** One-line description shown beneath the label in the dropdown.
   * For Claude these are lifted from the SDK JSDoc verbatim. */
  description: string;
  /** Risk tier driving UI coloring. Optional; the UI falls back to 'standard'
   * (amber) when absent. */
  tone?: ModeTone;
}

// === ProviderCapabilities ==================================================
//
// What the adapter can and cannot do. The manager exposes this to the UI so
// rendering stays provider-agnostic — no `provider === 'claude'` branches in
// React code.

export interface ProviderCapabilities {
  // Cost surface: true = USD column shown; false = hidden (Codex).
  costUsd: boolean;
  // Usage-limits indicator: true = adapter feeds applyUsageLimits with a live
  // snapshot (Claude, Codex); false = no live feed today (Hermes, Grok) and the
  // UI hides the badge. See docs/reference/USAGE_LIMITS.md.
  usageLimits: boolean;
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
  // Native modes the adapter accepts, with display metadata. The `value` of
  // each entry is the literal string the SDK takes (no MultiTable translation
  // layer); the UI renders them verbatim and the API validates against this
  // list on `setMode`.
  modes: ModeOption[];
  // Cross-provider reasoning-effort toggle. 'native' = adapter wires the value
  // through to the SDK (Claude `effort`, Codex `turn/start` effort field).
  // 'unsupported' = adapter ignores it; UI renders the toggle disabled.
  thinkingEffort: 'native' | 'unsupported';
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
  readonly name: 'claude' | 'codex' | 'copilot' | 'hermes' | 'grok' | 'cursor';
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

  // Optional: out-of-band fetch of the current usage-limit snapshot, for
  // providers whose limits live behind a billing/account API rather than the
  // turn event stream (Hermes/Grok → xAI billing via ~/.hermes/ ~/.grok/ creds).
  // The manager would poll this on an interval and feed the result through
  // cb.applyUsageLimits. UNIMPLEMENTED today — the contract is declared so the
  // out-of-band path is stable; see docs/reference/USAGE_LIMITS.md.
  fetchUsageLimits?(s: AgentSession): Promise<UsageLimitSnapshot | null>;

  // Optional: warm any daemon-wide adapter resources (long-lived child
  // processes, transport handshakes) so the first session that uses this
  // provider doesn't pay the cold-start cost. Called after `server.listen`
  // from the daemon entrypoint. Idempotent; errors must be swallowed by the
  // adapter (logged, not thrown) since warm-up failure should never block
  // boot.
  warmup?(): Promise<void>;

  // Optional: clean up per-session adapter caches. Called from /reset.
  reset?(s: AgentSession): void;

  // Optional: tear down per-session resources entirely. Called from session
  // delete. For Copilot this will eventually call session.disconnect().
  destroy?(s: AgentSession): void | Promise<void>;

  // Optional: tear down daemon-wide adapter resources (long-lived child
  // processes, singleton clients). Called from the daemon's SIGTERM handler.
  shutdown?(): void | Promise<void>;
}
