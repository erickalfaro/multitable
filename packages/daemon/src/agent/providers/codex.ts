import type { AgentSession, SessionMode } from '../types.js';
import type { Message } from '../../transcripts/parser.js';
import type { ProviderAdapter, ProviderCapabilities, AdapterCallbacks } from './types.js';
import { CodexAppServerClient } from './codex-app-server/index.js';
import type { RpcNotification } from './codex-app-server/index.js';
import type { ThreadItem } from './codex-protocol/v2/ThreadItem.js';
import type { TurnCompletedNotification } from './codex-protocol/v2/TurnCompletedNotification.js';
import type { TurnStartedNotification } from './codex-protocol/v2/TurnStartedNotification.js';
import type { ThreadStartedNotification } from './codex-protocol/v2/ThreadStartedNotification.js';
import type { ItemStartedNotification } from './codex-protocol/v2/ItemStartedNotification.js';
import type { ItemCompletedNotification } from './codex-protocol/v2/ItemCompletedNotification.js';
import type { AgentMessageDeltaNotification } from './codex-protocol/v2/AgentMessageDeltaNotification.js';
import type { ReasoningTextDeltaNotification } from './codex-protocol/v2/ReasoningTextDeltaNotification.js';
import type { CommandExecutionOutputDeltaNotification } from './codex-protocol/v2/CommandExecutionOutputDeltaNotification.js';
import type { ThreadTokenUsageUpdatedNotification } from './codex-protocol/v2/ThreadTokenUsageUpdatedNotification.js';
import type { ErrorNotification } from './codex-protocol/v2/ErrorNotification.js';
import type { TokenUsageBreakdown } from './codex-protocol/v2/TokenUsageBreakdown.js';
import type { SandboxMode } from './codex-protocol/v2/SandboxMode.js';
import {
  countCodexTurns,
  parseCodexThread,
  codexCanonicalId,
} from '../../transcripts/codexParser.js';

// Translate provider-agnostic SessionMode → Codex sandbox knobs. Codex has no
// per-call permission callback (approvalPolicy is set at thread/turn start
// time and we hardcode "never" — see CodexAppServerClient), so the only way
// to constrain its behavior is via the spawn-time sandbox.
//
//   default    → workspace-write (normal operation)
//   plan       → read-only (agent reads + reasons, can't mutate; user resumes
//                with workspace-write to execute the plan)
//   read-only  → read-only (no mutations)
//   accept-edits / auto / chat → not advertised in capabilities.modes for
//                                Codex; the manager's setMode rejects them.
function modeToCodexSandbox(mode: SessionMode): SandboxMode {
  switch (mode) {
    case 'plan':
    case 'read-only':
      return 'read-only';
    case 'auto':
      return 'danger-full-access';
    case 'default':
    case 'accept-edits':
    case 'chat':
    default:
      return 'workspace-write';
  }
}

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
    // Plan mode is TUI-only in Codex; we approximate via sandbox swap
    // (read-only thread → resume workspace-write) but the wiring lives in
    // the manager today, not here. Mark as 'simulated' so UI gates accordingly.
    planMode: 'simulated',
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
    // Read-only and default we can simulate via sandbox. Plan is also
    // simulated. Other modes (chat, accept-edits, auto) don't map cleanly to
    // the codex sandbox enum — leave them out so the UI doesn't show them.
    modes: ['default', 'plan', 'read-only'],
  };

  private client: CodexAppServerClient;
  // Per-session thread cache. Codex options are immutable post-thread-start;
  // we have to rebuild the thread on mode flip.
  private threads = new Map<string, { threadId: string; mode: SessionMode }>();
  private turnStates = new Map<string, TurnState>();

  constructor(client?: CodexAppServerClient) {
    this.client = client ?? new CodexAppServerClient();
  }

  reset(s: AgentSession): void {
    this.threads.delete(s.id);
    const state = this.turnStates.get(s.id);
    if (state?.reconcileTimer) clearTimeout(state.reconcileTimer);
    this.turnStates.delete(s.id);
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
      const { turnId } = await this.client.startTurn({ threadId, prompt: text });
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

    const sandbox = modeToCodexSandbox(s.mode);
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
