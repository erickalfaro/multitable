import type { AgentSession, UsageLimitSnapshot, UsageLimitWindow } from '../types.js';
import type { Message } from '../../transcripts/parser.js';
import type { ProviderAdapter, ProviderCapabilities, AdapterCallbacks } from './types.js';
import { CodexAppServerClient } from './codex-app-server/index.js';
import type { RpcNotification } from './codex-app-server/index.js';
import type { ThreadItem } from './codex-protocol/v2/ThreadItem.js';
import type { TurnCompletedNotification } from './codex-protocol/v2/TurnCompletedNotification.js';
import type { TurnStartedNotification } from './codex-protocol/v2/TurnStartedNotification.js';
import type { TurnPlanUpdatedNotification } from './codex-protocol/v2/TurnPlanUpdatedNotification.js';
import type { ThreadStartedNotification } from './codex-protocol/v2/ThreadStartedNotification.js';
import type { ItemStartedNotification } from './codex-protocol/v2/ItemStartedNotification.js';
import type { ItemCompletedNotification } from './codex-protocol/v2/ItemCompletedNotification.js';
import type { AgentMessageDeltaNotification } from './codex-protocol/v2/AgentMessageDeltaNotification.js';
import type { ReasoningTextDeltaNotification } from './codex-protocol/v2/ReasoningTextDeltaNotification.js';
import type { CommandExecutionOutputDeltaNotification } from './codex-protocol/v2/CommandExecutionOutputDeltaNotification.js';
import type { ThreadTokenUsageUpdatedNotification } from './codex-protocol/v2/ThreadTokenUsageUpdatedNotification.js';
import type { AccountRateLimitsUpdatedNotification } from './codex-protocol/v2/AccountRateLimitsUpdatedNotification.js';
import type { RateLimitSnapshot } from './codex-protocol/v2/RateLimitSnapshot.js';
import type { ErrorNotification } from './codex-protocol/v2/ErrorNotification.js';
import type { TokenUsageBreakdown } from './codex-protocol/v2/TokenUsageBreakdown.js';
import type { SandboxMode } from './codex-protocol/v2/SandboxMode.js';
import {
  countCodexTurns,
  parseCodexThread,
  codexCanonicalId,
} from '../../transcripts/codexParser.js';

// === Native Codex sandbox modes ============================================
//
// The Codex protocol's `SandboxMode` enum (generated from the codex-app-server
// schema). MultiTable passes `session.mode` straight through to `thread/start`
// — no translation layer. Codex enforces these at the OS sandbox level;
// approvalPolicy is hardcoded to "never" since per-call permission callbacks
// don't exist in the Codex protocol (see CodexAppServerClient).
const CODEX_NATIVE_MODES = [
  {
    value: 'workspace-write' as SandboxMode,
    label: 'Workspace write',
    description: 'Agent can read and edit files inside the workspace.',
    tone: 'elevated',
  },
  {
    value: 'read-only' as SandboxMode,
    label: 'Read-only',
    description: 'No file mutations; agent can read and reason only.',
    tone: 'safe',
  },
  {
    value: 'danger-full-access' as SandboxMode,
    label: 'Full access',
    description: 'Full filesystem access outside the workspace — advanced.',
    tone: 'danger',
  },
] as const;

export type { SandboxMode };

// CodexAdapter — driven by the long-lived `codex app-server` JSON-RPC child.
//
// Per turn:
//  1. ensureThreadId() — create a new thread or resume by stored agentSessionId
//  2. subscribe(threadId, listener) on the client singleton
//  3. turn/start with the user prompt; cache the returned turnId
//  4. drain notifications until turn/completed (or error) for THIS turnId
//  5. reconcile against the on-disk JSONL (belt-and-braces; the live stream is
//     now reliable for assistant text, but kept as cheap insurance)
//
// Why per-thread subscribers and a single shared child:
//  - One process means one auth + one warmup cost amortized across all
//    Codex sessions.
//  - Notifications carry threadId/turnId, so multiplexing is just routing.
//  - If the child crashes, CodexAppServerClient respawns and reapplies
//    thread/resume transparently — the on-disk rollout is the source of
//    truth.
//
// Canonical id scheme: `codex:{threadId}:t{turnIndex}:{kind}:{seq}`. Live
// adapter and on-disk JSONL parser mint matching ids so id-based dedup works
// across both the WS path and the REST refresh path.

interface TurnState {
  // Index of the upcoming/current turn relative to the thread. 0 = first.
  turnIndex: number;
  // Per-item-kind seq counters, reset at the start of every turn.
  seq: Map<string, number>;
  // Fires after the for-await loop ends to diff in-memory vs disk.
  reconcileTimer: NodeJS.Timeout | null;
}

// Tunable: how long after the stream closes before we reconcile from disk.
// Codex flushes JSONL slightly after stream close; 250ms is invisible behind
// the UI's "agent done" toast and gives the file time to settle.
const RECONCILE_DELAY_MS = 250;

// Codex emits very fine-grained deltas — often a single character per
// notification. Re-rendering the streaming bubble (which goes through
// react-markdown + shiki) on every chunk causes visible jitter, especially
// when a chunk lands a `\n` mid-paragraph and the markdown parser briefly
// shifts the layout. We coalesce deltas into a single emit per ~33ms (≈30
// fps) so the UI gets at most one streaming-text update per animation frame.
// Item completion flushes synchronously to keep the canonical-message
// ordering correct.
const DELTA_FLUSH_INTERVAL_MS = 33;

type DeltaKind = 'agentMessage' | 'reasoning' | 'commandOutput';

interface DeltaBuffers {
  // Per-item additive accumulator for `item/agentMessage/delta`.
  agentMessage: Map<string, string>;
  // Keyed by `${itemId}:${contentIndex}` for `item/reasoning/textDelta`.
  reasoning: Map<string, string>;
  // Per-item additive accumulator for `item/commandExecution/outputDelta`.
  commandOutput: Map<string, string>;
  // Pending coalesce timer + which streams have unflushed updates.
  flushTimer: NodeJS.Timeout | null;
  pending: Set<DeltaKind>;
  // Most-recent active item ids per stream, used to know which buffer to
  // emit at flush time. We only ever stream one of each kind at a time.
  activeAgentItem: string | null;
  activeReasoningItem: string | null;
  activeCommandItem: string | null;
  // Most-recent tool input shape (toolName + input) so flushes carry the
  // right metadata without re-deriving it from the latest delta.
  activeToolMeta: ToolDeltaMeta | null;
}

interface ToolDeltaMeta {
  toolName: string;
  input: Record<string, unknown>;
}

interface TurnCompletion {
  turnId: string | null;
  resolve: () => void;
  reject: (err: Error) => void;
  promise: Promise<void>;
  pendingUsage: TokenUsageBreakdown | null;
}

export class CodexAdapter implements ProviderAdapter {
  readonly name = 'codex' as const;

  readonly capabilities: ProviderCapabilities = {
    // Codex does not surface per-turn cost in USD — by design, codex pricing
    // is contract-specific. The UI hides the dollar row.
    costUsd: false,
    // Codex pushes account/rateLimits/updated (and we pull account/rateLimits/read
    // on provision) — normalized into the usage-limits indicator.
    usageLimits: true,
    // Codex has no native plan mode — the sandbox enum is the only knob.
    // The previous "simulated plan via read-only swap" UX was a MultiTable
    // invention and got dropped along with the SessionMode translation layer.
    planMode: 'none',
    // Sandbox enum, no per-call host approval — approvalPolicy is hardcoded
    // to "never" and Codex enforces the actual sandbox at the OS level.
    perCallApproval: 'sandbox',
    userQuestion: 'unsupported',
    elicitation: false,
    subagents: 'none',
    midTurnInput: false,
    byok: false,
    hardSandbox: true,
    hooks: 'none',
    // `item/agentMessage/delta` carries chunks (additive) — replaces the old
    // SDK behavior where item.text was cumulative. Manager-side StreamBuffer
    // accumulates these and emits cumulative text to the WS layer.
    streamingDeltaSemantics: 'additive',
    modelSwitchScope: 'per-thread',
    // Native SandboxMode values passed straight through to thread/start.
    modes: CODEX_NATIVE_MODES.map((m) => ({ ...m })),
    thinkingEffort: 'native',
  };

  private client: CodexAppServerClient;
  // Per-session thread cache. Codex options are immutable post-thread-start;
  // we have to rebuild the thread on mode flip.
  private threads = new Map<string, { threadId: string; mode: string }>();
  private turnStates = new Map<string, TurnState>();
  // Per-MT-session prior plan snapshot for diffing turn/plan/updated
  // notifications into synthetic Tasks-panel events. Re-namespaced per turnId
  // so each turn's plan is a distinct row set (prior turns persist as
  // completed history). Cleared in reset().
  private planState = new Map<string, { turnId: string | null; steps: string[] }>();
  // Usage limits are ACCOUNT-scoped (one snapshot for all Codex sessions), but
  // applyUsageLimits is a per-session callback. So we keep the latest snapshot
  // and the latest per-session callbacks, and fan a new snapshot to all of them.
  // A late-joining session gets the cached snapshot the moment it registers.
  private latestAccountLimits: UsageLimitSnapshot | null = null;
  private usageCbs = new Map<string, AdapterCallbacks>();
  private accountOff: (() => void) | null = null;

  constructor(client?: CodexAppServerClient) {
    this.client = client ?? new CodexAppServerClient();
  }

  /**
   * Register the single account-scoped listener that turns
   * `account/rateLimits/updated` into a normalized usage-limit snapshot and
   * fans it to every Codex session. Idempotent.
   */
  private ensureAccountListener(): void {
    if (this.accountOff) return;
    this.accountOff = this.client.subscribeAccount((n) => {
      if (n.method !== 'account/rateLimits/updated') return;
      const params = n.params as AccountRateLimitsUpdatedNotification | undefined;
      if (!params?.rateLimits) return;
      const snapshot = normalizeCodexLimits(params.rateLimits);
      this.latestAccountLimits = snapshot;
      for (const cb of this.usageCbs.values()) cb.applyUsageLimits(snapshot);
    });
  }

  /** Track a session's callback and immediately seed it with any cached snapshot. */
  private trackUsageCb(s: AgentSession, cb: AdapterCallbacks): void {
    this.usageCbs.set(s.id, cb);
    if (this.latestAccountLimits) cb.applyUsageLimits(this.latestAccountLimits);
  }

  /** Best-effort on-demand pull so the badge has data before the first turn. */
  private async pullAccountLimits(cb: AdapterCallbacks): Promise<void> {
    try {
      const res = await this.client.getAccountRateLimits();
      if (!res?.rateLimits) return;
      const snapshot = normalizeCodexLimits(res.rateLimits);
      this.latestAccountLimits = snapshot;
      cb.applyUsageLimits(snapshot);
    } catch (err) {
      // Not authed yet / server doesn't support it — non-fatal; the push path
      // (account/rateLimits/updated) will populate the badge on the next turn.
      console.warn('[codex] account/rateLimits/read failed (non-fatal)', err);
    }
  }

  reset(s: AgentSession): void {
    this.threads.delete(s.id);
    const state = this.turnStates.get(s.id);
    if (state?.reconcileTimer) clearTimeout(state.reconcileTimer);
    this.turnStates.delete(s.id);
    this.planState.delete(s.id);
    this.usageCbs.delete(s.id);
  }

  /**
   * Mint a fresh codex thread without running a turn. Called at session
   * creation time so the rollout file exists on disk before the user's first
   * prompt. We deliberately do NOT populate `this.threads` here — if the user
   * flips mode before sending, ensureThreadId() will resume this same threadId
   * with the new sandbox via resumeThread(), which is exactly the right
   * behavior. Caching now would force a wasted createThread later.
   */
  async provisionSession(
    s: AgentSession,
    _ctrl: AbortController,
    cb: AdapterCallbacks,
  ): Promise<void> {
    if (s.agentSessionId) return;
    // s.mode is already a native SandboxMode string (validated on write).
    const sandbox = s.mode as SandboxMode;
    const threadId = await this.client.createThread({
      cwd: s.workingDir,
      sandbox,
      model: s.model ?? null,
    });
    cb.onSessionIdAssigned(threadId, s.agentSessionIdHistory);
    // Seed the usage-limits indicator before the first turn (best-effort pull).
    this.ensureAccountListener();
    this.trackUsageCb(s, cb);
    await this.pullAccountLimits(cb);
  }

  /**
   * Daemon boot hook. Eagerly spawns `codex app-server` + runs the initialize
   * handshake so the first Codex session doesn't pay the ~2–5s subprocess
   * cold-start. ensureReady() is idempotent; this is safe to call alongside
   * provisionSession() races.
   */
  async warmup(): Promise<void> {
    try {
      await this.client.ensureReady();
      // Start listening for account/rateLimits/updated as early as possible so
      // the usage-limits indicator is live from the first turn.
      this.ensureAccountListener();
    } catch (err) {
      console.error('[codex] warmup failed', err);
    }
  }

  /**
   * Out-of-band usage-limits fetch (called by the manager's poll loop on a
   * cadence). Pulls the account rate-limit snapshot via the app-server and
   * normalizes it. Account-wide, so the manager fans the result to all Codex
   * sessions. Returns null silently on failure (not authed / unsupported) so
   * the poll doesn't spam logs.
   */
  async fetchUsageLimits(_s: AgentSession): Promise<UsageLimitSnapshot | null> {
    try {
      const res = await this.client.getAccountRateLimits();
      if (!res?.rateLimits) return null;
      const snapshot = normalizeCodexLimits(res.rateLimits);
      this.latestAccountLimits = snapshot;
      return snapshot;
    } catch {
      return null;
    }
  }

  /**
   * Daemon shutdown hook. Closes the underlying app-server child.
   */
  shutdown(): void {
    this.client.close();
  }

  async runTurn(
    s: AgentSession,
    text: string,
    ctrl: AbortController,
    cb: AdapterCallbacks,
  ): Promise<void> {
    if (s.userMessages.length === 1) cb.maybeRenameFromFirstPrompt(text);

    // Keep this session wired for account-scoped usage-limit fan-out, and seed
    // it with the latest cached snapshot.
    this.ensureAccountListener();
    this.trackUsageCb(s, cb);

    // Surface a single "Codex restarted" alert if we just respawned. This
    // applies once per crash event regardless of how many threads were
    // affected.
    if (this.client.consumeRespawnFlag()) {
      cb.emitAlert({
        category: 'turn',
        severity: 'warning',
        title: 'Codex restarted',
        body: 'The codex app-server child crashed and was respawned. Resuming the conversation.',
      });
    }

    const threadId = await this.ensureThreadId(s);

    // Persist the threadId on the session as soon as we know it. We do NOT
    // rely on the `thread/started` notification for this because (a) its
    // params shape is `{ thread: Thread }` with no top-level `threadId`, so
    // our dispatcher (which routes by `params.threadId`) drops it, and
    // (b) it fires during the thread/start RPC — before we've even
    // subscribed for this thread, so it'd be unroutable anyway. Without
    // this, `s.agentSessionId` stays null, the DB column stays null, and on
    // page refresh the daemon can't find the rollout file to hydrate from
    // disk → empty chat.
    if (threadId !== s.agentSessionId) {
      const previous = s.agentSessionId;
      const nextHistory =
        previous && !s.agentSessionIdHistory.includes(previous)
          ? [...s.agentSessionIdHistory, previous]
          : s.agentSessionIdHistory;
      cb.onSessionIdAssigned(threadId, nextHistory);
      cb.emitStateSnapshot();
    }

    // Determine turnIndex from disk so live ids match what parseCodexThread
    // will later compute. New thread → 0; resumed thread → existing count.
    let turnIndex = 0;
    if (s.agentSessionId) {
      try {
        turnIndex = countCodexTurns(s.agentSessionId);
      } catch {
        /* file not flushed yet → safe to start at 0 */
      }
    }
    const prev = this.turnStates.get(s.id);
    if (prev?.reconcileTimer) clearTimeout(prev.reconcileTimer);
    this.turnStates.set(s.id, { turnIndex, seq: new Map(), reconcileTimer: null });

    const buffers: DeltaBuffers = {
      agentMessage: new Map(),
      reasoning: new Map(),
      commandOutput: new Map(),
      flushTimer: null,
      pending: new Set(),
      activeAgentItem: null,
      activeReasoningItem: null,
      activeCommandItem: null,
      activeToolMeta: null,
    };

    const completion = makeTurnCompletion();

    // Subscribe BEFORE turn/start. Notifications can race the response and we
    // can't afford to miss `turn/started` or early deltas.
    const off = this.client.subscribe(threadId, (n) => {
      try {
        this.handleNotification(s, n, cb, completion, buffers);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[codex] notification handler threw', {
          sessionId: s.id,
          threadId,
          method: n.method,
          error: message,
        });
        const seq = this.nextSeq(s.id, 'evterr');
        const messages: Message[] = [
          {
            id: codexCanonicalId(s.agentSessionId, turnIndex, 'evterr', seq),
            ts: Date.now(),
            kind: 'system',
            text: `Codex notification handling error (${n.method}): ${message}`,
          },
        ];
        cb.pushMessages(messages);
        cb.emitToolEvent(messages);
      }
    });

    const onAbort = () => {
      if (completion.turnId) {
        void this.client.interruptTurn({
          threadId,
          turnId: completion.turnId,
        });
      }
    };
    ctrl.signal.addEventListener('abort', onAbort, { once: true });

    console.info('[codex] starting turn', {
      sessionId: s.id,
      threadId,
      turnIndex,
      promptLength: text.length,
    });

    try {
      // Map our five-level toggle into Codex's ReasoningEffort enum
      // ("none" | "minimal" | "low" | "medium" | "high" | "xhigh"). The Claude
      // SDK has an additional 'max' tier; Codex does NOT, so a session that
      // carried `max` over from a Claude model (or via sticky lastThinkingEffort)
      // gets omitted here — Codex applies its own default reasoning level. The
      // UI per-model gating will normally prevent this from ever landing, but
      // we keep the defensive map so a stale persisted value can't 400 a turn.
      // NOTE: effort is per-turn; do NOT include it in the threads-cache key.
      const codexEffort =
        s.thinkingEffort === 'max' ? undefined : s.thinkingEffort ?? undefined;
      const { turnId } = await this.client.startTurn({
        threadId,
        prompt: text,
        ...(codexEffort ? { effort: codexEffort } : {}),
      });
      completion.turnId = turnId;
      // If the user already aborted before the response landed, fire-and-
      // forget the interrupt now.
      if (ctrl.signal.aborted) onAbort();
      await completion.promise;
      console.info('[codex] turn completed cleanly', { sessionId: s.id, threadId });
    } catch (err) {
      console.error('[codex] turn failed', {
        sessionId: s.id,
        threadId,
        error: err instanceof Error ? err.stack ?? err.message : String(err),
      });
      // Drop the cached thread so the next turn re-resumes (the on-disk
      // rollout is the source of truth — fresh resume picks up wherever the
      // last completed turn left off).
      this.threads.delete(s.id);
      this.scheduleReconcile(s, cb);
      throw err;
    } finally {
      ctrl.signal.removeEventListener('abort', onAbort);
      off();
      if (buffers.flushTimer) {
        clearTimeout(buffers.flushTimer);
        buffers.flushTimer = null;
      }
    }
    this.scheduleReconcile(s, cb);
  }

  private async ensureThreadId(s: AgentSession): Promise<string> {
    const existing = this.threads.get(s.id);
    if (existing && existing.mode === s.mode) return existing.threadId;

    // s.mode is already a native SandboxMode string (validated on write).
    const sandbox = s.mode as SandboxMode;
    let threadId: string;
    if (s.agentSessionId) {
      try {
        threadId = await this.client.resumeThread({
          threadId: s.agentSessionId,
          cwd: s.workingDir,
          sandbox,
          model: s.model ?? null,
        });
      } catch (err) {
        // Resume can fail if the rollout was deleted or the threadId was
        // never persisted. Fall back to a fresh thread.
        console.warn('[codex] resumeThread failed, creating fresh', {
          sessionId: s.id,
          threadId: s.agentSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        threadId = await this.client.createThread({
          cwd: s.workingDir,
          sandbox,
          model: s.model ?? null,
        });
      }
    } else {
      threadId = await this.client.createThread({
        cwd: s.workingDir,
        sandbox,
        model: s.model ?? null,
      });
    }
    this.threads.set(s.id, { threadId, mode: s.mode });
    return threadId;
  }

  private nextSeq(sessionId: string, kind: string): number {
    const state = this.turnStates.get(sessionId);
    if (!state) return 0;
    const n = state.seq.get(kind) ?? 0;
    state.seq.set(kind, n + 1);
    return n;
  }

  private currentTurnIndex(sessionId: string): number {
    return this.turnStates.get(sessionId)?.turnIndex ?? 0;
  }

  private handleNotification(
    s: AgentSession,
    n: RpcNotification,
    cb: AdapterCallbacks,
    completion: TurnCompletion,
    buffers: DeltaBuffers,
  ): void {
    switch (n.method) {
      case 'thread/started': {
        const params = n.params as ThreadStartedNotification;
        const newId = params.thread.id;
        if (newId && newId !== s.agentSessionId) {
          const previous = s.agentSessionId;
          const nextHistory =
            previous && !s.agentSessionIdHistory.includes(previous)
              ? [...s.agentSessionIdHistory, previous]
              : s.agentSessionIdHistory;
          cb.onSessionIdAssigned(newId, nextHistory);
          cb.emitStateSnapshot();
        }
        return;
      }

      case 'turn/started': {
        const params = n.params as TurnStartedNotification;
        // No-op besides logging — turn lifecycle progress is reflected in
        // item-level events.
        console.info('[codex] turn started', {
          sessionId: s.id,
          threadId: params.threadId,
          turnId: params.turn.id,
        });
        return;
      }

      case 'item/started': {
        const params = n.params as ItemStartedNotification;
        this.applyItemStreamingPreviews(params.item, cb, buffers);
        return;
      }

      case 'item/agentMessage/delta': {
        const params = n.params as AgentMessageDeltaNotification;
        const prev = buffers.agentMessage.get(params.itemId) ?? '';
        buffers.agentMessage.set(params.itemId, prev + params.delta);
        buffers.activeAgentItem = params.itemId;
        buffers.pending.add('agentMessage');
        this.scheduleFlush(buffers, cb);
        cb.bumpActivity();
        return;
      }

      case 'item/reasoning/textDelta': {
        const params = n.params as ReasoningTextDeltaNotification;
        const key = `${params.itemId}:${params.contentIndex}`;
        const prev = buffers.reasoning.get(key) ?? '';
        buffers.reasoning.set(key, prev + params.delta);
        buffers.activeReasoningItem = params.itemId;
        buffers.pending.add('reasoning');
        this.scheduleFlush(buffers, cb);
        cb.bumpActivity();
        return;
      }

      case 'item/commandExecution/outputDelta': {
        const params = n.params as CommandExecutionOutputDeltaNotification;
        const prev = buffers.commandOutput.get(params.itemId) ?? '';
        buffers.commandOutput.set(params.itemId, prev + params.delta);
        buffers.activeCommandItem = params.itemId;
        buffers.pending.add('commandOutput');
        this.scheduleFlush(buffers, cb);
        cb.bumpActivity();
        return;
      }

      case 'item/completed': {
        const params = n.params as ItemCompletedNotification;
        const isToolItem = isToolThreadItem(params.item);

        // Drain any deltas that the throttle hasn't emitted yet so the UI
        // reflects the final cumulative text BEFORE the canonical message
        // lands. Otherwise the canonical assistant bubble could appear
        // before the streaming bubble shows the last chunk, snapping the
        // visible text backwards for one frame.
        this.flushDeltas(buffers, cb);

        // Push the canonical message FIRST, then clear the live preview.
        // Reverse order causes a one-frame gap where the streaming bubble
        // has emptied but the canonical message hasn't landed yet — visible
        // as end-of-message flicker. Same ordering Claude uses.
        const messages = this.itemToMessages(s, params.item, Date.now());
        if (messages.length > 0) {
          cb.pushMessages(messages);
          if (messages.some((m) => m.kind === 'assistant')) {
            cb.emitAssistantMessage(messages);
          } else {
            cb.emitToolEvent(messages);
          }
        }

        if (isToolItem) cb.emitToolDelta(null);
        else if (params.item.type === 'reasoning') cb.emitReasoningDelta('');
        else if (params.item.type === 'agentMessage') cb.emitAssistantDelta('');

        // Drop the per-item delta buffer so memory doesn't accumulate over
        // long sessions, and null out the active pointer so a stale flush
        // can't re-emit text after the canonical message lands.
        if (params.item.type === 'agentMessage') {
          buffers.agentMessage.delete(params.item.id);
          if (buffers.activeAgentItem === params.item.id) buffers.activeAgentItem = null;
        } else if (params.item.type === 'reasoning') {
          for (const k of Array.from(buffers.reasoning.keys())) {
            if (k.startsWith(`${params.item.id}:`)) buffers.reasoning.delete(k);
          }
          if (buffers.activeReasoningItem === params.item.id) buffers.activeReasoningItem = null;
        } else if (params.item.type === 'commandExecution') {
          buffers.commandOutput.delete(params.item.id);
          if (buffers.activeCommandItem === params.item.id) {
            buffers.activeCommandItem = null;
            buffers.activeToolMeta = null;
          }
        } else if (isToolItem) {
          // Non-streaming tool items (fileChange, mcpToolCall, webSearch)
          // also need their tool-meta cleared so a later commandExecution
          // doesn't accidentally render with stale metadata.
          buffers.activeToolMeta = null;
        }

        if (isToolItem) cb.incrementToolCount();
        cb.setCurrentTool(null);
        cb.bumpActivity();
        // Don't emit a state snapshot per item completion — the canonical
        // message + tool count update are already sufficient signal. The
        // turn/completed handler emits one snapshot for the cost/token UI
        // to refresh from.
        return;
      }

      case 'thread/tokenUsage/updated': {
        const params = n.params as ThreadTokenUsageUpdatedNotification;
        if (completion.turnId && params.turnId === completion.turnId) {
          completion.pendingUsage = params.tokenUsage.last;
        }
        return;
      }

      case 'turn/plan/updated': {
        const params = n.params as TurnPlanUpdatedNotification;
        // Scope to the in-flight turn; ignore stragglers from other turns.
        if (completion.turnId && params.turnId !== completion.turnId) return;
        let st = this.planState.get(s.id);
        if (!st || st.turnId !== params.turnId) {
          st = { turnId: params.turnId, steps: [] };
          this.planState.set(s.id, st);
        }
        const prior = st.steps;
        const nextStatuses: string[] = [];
        params.plan.forEach((p, i) => {
          const status = mapCodexPlanStatus(p.status);
          nextStatuses.push(status);
          // turnId in the id so each turn's plan is a distinct task set.
          const taskId = `codex-plan-${params.turnId}-${i}`;
          const before = prior[i];
          if (before === undefined) {
            cb.emitTaskEvent('task_started', {
              task_id: taskId,
              description: p.step,
              task_type: 'plan',
              skip_transcript: true,
            });
            if (status !== 'pending') {
              cb.emitTaskEvent('task_updated', {
                task_id: taskId,
                patch: { status, description: p.step },
              });
            }
          } else if (before !== status) {
            cb.emitTaskEvent('task_updated', {
              task_id: taskId,
              patch: { status, description: p.step },
            });
          }
        });
        st.steps = nextStatuses;
        cb.bumpActivity();
        return;
      }

      case 'turn/completed': {
        const params = n.params as TurnCompletedNotification;
        if (!completion.turnId || params.turn.id !== completion.turnId) return;
        // Drain any pending deltas before clearing previews — same reasoning
        // as item/completed.
        this.flushDeltas(buffers, cb);
        // Belt-and-braces: clear any lingering live previews in case an item
        // was aborted without firing item/completed.
        cb.emitToolDelta(null);
        cb.emitReasoningDelta('');
        cb.emitAssistantDelta('');

        const usage = completion.pendingUsage;
        if (usage) {
          // The Codex protocol's `cachedInputTokens` is a SUBSET of
          // `inputTokens` (and `reasoningOutputTokens` is a subset of
          // `outputTokens`) — see TokenUsageBreakdown.ts. snapshotStats sums
          // tokensIn + tokensOut + cacheCreationTokens + cacheReadTokens, so
          // we have to break out the cached portion to avoid double-counting.
          cb.applyUsage({
            tokensIn: usage.inputTokens - usage.cachedInputTokens,
            tokensOut: usage.outputTokens,
            cacheCreationTokens: 0,
            cacheReadTokens: usage.cachedInputTokens,
            costUsd: 0,
          });
          cb.emitTurnResult({
            subtype: 'success',
            totalCostUsd: 0,
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: usage.cachedInputTokens,
            },
            text: null,
          });
        } else {
          cb.emitTurnResult({
            subtype: 'success',
            totalCostUsd: 0,
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
            },
            text: null,
          });
        }
        cb.bumpActivity();
        cb.emitStateSnapshot();
        completion.resolve();
        return;
      }

      case 'error': {
        const params = n.params as ErrorNotification;
        // Only fail this turn if the error scopes to it. Errors for other
        // turns/threads shouldn't reach us anyway (we filter by threadId in
        // the client) but be defensive about turnId.
        if (completion.turnId && params.turnId !== completion.turnId) return;
        completion.reject(new Error(params.error.message || 'codex turn failed'));
        return;
      }

      default:
        // Many notifications (turn/diff/updated, plan/delta, mcp progress
        // etc.) are not load-bearing for our UX. Drop quietly.
        return;
    }
  }

  /**
   * Initial-state hooks the live preview channels expect on `item/started`.
   * Sets the current-tool badge and stashes the tool metadata that the
   * throttled flush will need (toolName + input). We deliberately do NOT
   * emit a placeholder tool-delta — for `commandExecution` the first real
   * `outputDelta` arrives almost immediately, and a placeholder one frame
   * earlier causes a visible tool-card flicker.
   */
  private applyItemStreamingPreviews(
    item: ThreadItem,
    cb: AdapterCallbacks,
    buffers: DeltaBuffers,
  ): void {
    switch (item.type) {
      case 'commandExecution':
        cb.setCurrentTool('Command');
        buffers.activeToolMeta = { toolName: 'Command', input: { command: item.command } };
        break;
      case 'fileChange':
        cb.setCurrentTool('Patch');
        buffers.activeToolMeta = { toolName: 'Patch', input: { changes: item.changes } };
        break;
      case 'mcpToolCall':
        cb.setCurrentTool(`${item.server}.${item.tool}`);
        buffers.activeToolMeta = {
          toolName: `${item.server}.${item.tool}`,
          input: (item.arguments ?? {}) as Record<string, unknown>,
        };
        break;
      case 'webSearch':
        cb.setCurrentTool('WebSearch');
        buffers.activeToolMeta = { toolName: 'WebSearch', input: { query: item.query } };
        break;
      default:
        return;
    }
    cb.bumpActivity();
  }

  /**
   * Schedule a single coalesced flush in DELTA_FLUSH_INTERVAL_MS. Repeated
   * calls during the window are no-ops — the timer fires once and emits
   * whatever is in the buffer at that moment.
   */
  private scheduleFlush(buffers: DeltaBuffers, cb: AdapterCallbacks): void {
    if (buffers.flushTimer) return;
    buffers.flushTimer = setTimeout(() => {
      buffers.flushTimer = null;
      this.flushDeltas(buffers, cb);
    }, DELTA_FLUSH_INTERVAL_MS);
  }

  /**
   * Emit cumulative buffer text for any stream that has unflushed deltas.
   * Safe to call synchronously from `item/completed` to drain in-flight
   * deltas before pushing the canonical message.
   */
  private flushDeltas(buffers: DeltaBuffers, cb: AdapterCallbacks): void {
    if (buffers.flushTimer) {
      clearTimeout(buffers.flushTimer);
      buffers.flushTimer = null;
    }
    if (buffers.pending.size === 0) return;
    if (buffers.pending.has('agentMessage') && buffers.activeAgentItem) {
      const text = buffers.agentMessage.get(buffers.activeAgentItem) ?? '';
      cb.emitAssistantDelta(text);
    }
    if (buffers.pending.has('reasoning') && buffers.activeReasoningItem) {
      // Concatenate all content blocks for this item in index order so
      // the preview is monotonic across content_index changes.
      const itemId = buffers.activeReasoningItem;
      const parts: { idx: number; text: string }[] = [];
      for (const [k, v] of buffers.reasoning.entries()) {
        if (!k.startsWith(`${itemId}:`)) continue;
        const idx = Number(k.slice(itemId.length + 1));
        parts.push({ idx, text: v });
      }
      parts.sort((a, b) => a.idx - b.idx);
      cb.emitReasoningDelta(parts.map((p) => p.text).join('\n'));
    }
    if (
      buffers.pending.has('commandOutput') &&
      buffers.activeCommandItem &&
      buffers.activeToolMeta
    ) {
      const text = buffers.commandOutput.get(buffers.activeCommandItem) ?? '';
      cb.emitToolDelta({
        toolName: buffers.activeToolMeta.toolName,
        input: buffers.activeToolMeta.input,
        output: text || 'Running…',
        isError: false,
      });
    }
    buffers.pending.clear();
  }

  private scheduleReconcile(s: AgentSession, cb: AdapterCallbacks): void {
    const state = this.turnStates.get(s.id);
    if (!state) return;
    if (state.reconcileTimer) clearTimeout(state.reconcileTimer);
    state.reconcileTimer = setTimeout(() => {
      state.reconcileTimer = null;
      try {
        this.reconcileTurn(s, cb);
      } catch (err) {
        console.error('[codex] reconcileTurn failed', {
          sessionId: s.id,
          threadId: s.agentSessionId ?? null,
          error: err instanceof Error ? err.stack ?? err.message : String(err),
        });
      }
    }, RECONCILE_DELAY_MS);
  }

  // Diff in-memory s.messages against on-disk JSONL and broadcast the delta.
  // The live notification stream now fires assistant text deltas, so this is
  // belt-and-braces — but cheap, and survives any future protocol drift.
  private reconcileTurn(s: AgentSession, cb: AdapterCallbacks): void {
    if (!s.agentSessionId) return;
    const fromDisk = parseCodexThread(s.agentSessionId);
    if (fromDisk.length === 0) return;
    const inMemoryIds = new Set(s.messages.map((m) => m.id));

    // Optimistic user-message id (`turn-${ts}-${rand}`) → canonical id rekey.
    const optimisticUserMatches = (live: Message, disk: Message): boolean => {
      if (live.kind !== 'user' || disk.kind !== 'user') return false;
      if (!live.id.startsWith('turn-')) return false;
      const norm = (t: string) => t.trim().replace(/\s+/g, ' ');
      return norm(live.text) === norm(disk.text);
    };
    for (const dm of fromDisk) {
      if (dm.kind !== 'user') continue;
      const idx = s.messages.findIndex((m) => optimisticUserMatches(m, dm));
      if (idx === -1) continue;
      const existing = s.messages[idx];
      if (existing.id === dm.id) continue;
      inMemoryIds.delete(existing.id);
      const reKeyed: Message = { ...existing, id: dm.id } as Message;
      s.messages[idx] = reKeyed;
      inMemoryIds.add(dm.id);
      cb.emitMessageRekey(existing.id, dm.id);
    }

    const additions: Message[] = [];
    for (const dm of fromDisk) {
      if (inMemoryIds.has(dm.id)) continue;
      additions.push(dm);
      inMemoryIds.add(dm.id);
    }
    if (additions.length === 0) {
      cb.emitReconciled([]);
      return;
    }
    s.messages.push(...additions);

    const assistant: Message[] = [];
    const tool: Message[] = [];
    const user: Message[] = [];
    for (const m of additions) {
      if (m.kind === 'assistant') assistant.push(m);
      else if (m.kind === 'user') user.push(m);
      else tool.push(m);
    }
    if (assistant.length) cb.emitAssistantMessage(assistant);
    if (tool.length) cb.emitToolEvent(tool);
    if (user.length) cb.emitUserMessage(user);
    cb.emitReconciled(additions.map((m) => m.id));
    cb.emitStateSnapshot();
  }

  // Mints canonical Message[] for one Codex item. The protocol's item.id
  // (e.g. `item_0`) is NOT used directly because it collides across turns;
  // we derive `codex:{threadId}:t{turnIndex}:{kind}:{seq}` ids that match
  // exactly what `parseCodexFile` produces from the disk JSONL.
  private itemToMessages(s: AgentSession, item: ThreadItem, ts: number): Message[] {
    const turnIndex = this.currentTurnIndex(s.id);
    const threadId = s.agentSessionId;
    switch (item.type) {
      case 'agentMessage': {
        const id = codexCanonicalId(threadId, turnIndex, 'msg', this.nextSeq(s.id, 'msg'));
        return [{ id, ts, kind: 'assistant', text: item.text, model: 'codex' }];
      }
      case 'reasoning': {
        const text = [...item.summary, ...item.content].filter((s) => s.trim()).join('\n');
        if (!text) return [];
        const id = codexCanonicalId(threadId, turnIndex, 'reason', this.nextSeq(s.id, 'reason'));
        return [{ id, ts, kind: 'reasoning', text }];
      }
      case 'commandExecution': {
        const callId = codexCanonicalId(threadId, turnIndex, 'exec', this.nextSeq(s.id, 'exec'));
        return [
          {
            id: `${callId}-use`,
            ts,
            kind: 'tool_use',
            parentId: callId,
            toolUseId: callId,
            toolName: 'Command',
            input: { command: item.command },
          },
          {
            id: `${callId}-result`,
            ts,
            kind: 'tool_result',
            toolUseId: callId,
            output:
              item.aggregatedOutput ||
              (item.exitCode === null ? 'Command started.' : `Exit code ${item.exitCode}`),
            isError: item.status === 'failed',
          },
        ];
      }
      case 'fileChange': {
        const callId = codexCanonicalId(threadId, turnIndex, 'patch', this.nextSeq(s.id, 'patch'));
        return [
          {
            id: `${callId}-use`,
            ts,
            kind: 'tool_use',
            parentId: callId,
            toolUseId: callId,
            toolName: 'Patch',
            input: { changes: item.changes },
          },
          {
            id: `${callId}-result`,
            ts,
            kind: 'tool_result',
            toolUseId: callId,
            output: item.changes.map((c) => `${c.kind}: ${c.path}`).join('\n'),
            isError: item.status === 'failed',
          },
        ];
      }
      case 'mcpToolCall': {
        const callId = codexCanonicalId(threadId, turnIndex, 'mcp', this.nextSeq(s.id, 'mcp'));
        const result = item.error?.message ?? (item.result ? JSON.stringify(item.result, null, 2) : '');
        return [
          {
            id: `${callId}-use`,
            ts,
            kind: 'tool_use',
            parentId: callId,
            toolUseId: callId,
            toolName: `${item.server}.${item.tool}`,
            input: (item.arguments ?? {}) as Record<string, unknown>,
          },
          {
            id: `${callId}-result`,
            ts,
            kind: 'tool_result',
            toolUseId: callId,
            output: result,
            isError: item.status === 'failed',
          },
        ];
      }
      case 'webSearch': {
        const callId = codexCanonicalId(threadId, turnIndex, 'search', this.nextSeq(s.id, 'search'));
        return [
          {
            id: `${callId}-use`,
            ts,
            kind: 'tool_use',
            parentId: callId,
            toolUseId: callId,
            toolName: 'WebSearch',
            input: { query: item.query },
          },
        ];
      }
      case 'plan': {
        const id = codexCanonicalId(threadId, turnIndex, 'plan', this.nextSeq(s.id, 'plan'));
        return [{ id, ts, kind: 'system', text: `Plan: ${item.text}` }];
      }
      default:
        return [];
    }
  }
}

// Codex RateLimitSnapshot → normalized UsageLimitSnapshot. primary/secondary
// become windows; credits.balance (a STRING) → creditsRemaining; planType is
// carried for the popover header. See .claude/skills/openai-codex-sdk/reference/usage-limits.md.
function normalizeCodexLimits(rl: RateLimitSnapshot): UsageLimitSnapshot {
  const windows: UsageLimitWindow[] = [];
  if (rl.primary) {
    windows.push({
      label: rl.limitName ?? 'Primary',
      usedPercent: rl.primary.usedPercent,
      resetsAt: rl.primary.resetsAt,
      windowDurationMins: rl.primary.windowDurationMins,
    });
  }
  if (rl.secondary) {
    windows.push({
      label: 'Secondary',
      usedPercent: rl.secondary.usedPercent,
      resetsAt: rl.secondary.resetsAt,
      windowDurationMins: rl.secondary.windowDurationMins,
    });
  }
  const balance = rl.credits?.balance != null ? Number(rl.credits.balance) : null;
  return {
    status: 'live',
    source: 'codex',
    windows,
    planType: rl.planType ?? null,
    creditsRemaining: balance != null && Number.isFinite(balance) ? balance : null,
    capturedAt: Date.now(),
  };
}

// Codex plan-step status → frontend TaskState. The generated protocol type
// (TurnPlanStepStatus) claims camelCase `inProgress`, but the real update_plan
// wire payload uses snake_case `in_progress` — accept both so an in-progress
// step doesn't silently fall through to `pending`.
function mapCodexPlanStatus(s: unknown): 'pending' | 'running' | 'completed' {
  if (s === 'inProgress' || s === 'in_progress') return 'running';
  if (s === 'completed') return 'completed';
  return 'pending';
}

function isToolThreadItem(item: ThreadItem): boolean {
  return (
    item.type === 'commandExecution' ||
    item.type === 'fileChange' ||
    item.type === 'mcpToolCall' ||
    item.type === 'webSearch' ||
    item.type === 'dynamicToolCall'
  );
}

function makeTurnCompletion(): TurnCompletion {
  let resolveFn: () => void = () => {};
  let rejectFn: (err: Error) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    turnId: null,
    resolve: resolveFn,
    reject: rejectFn,
    promise,
    pendingUsage: null,
  };
}
