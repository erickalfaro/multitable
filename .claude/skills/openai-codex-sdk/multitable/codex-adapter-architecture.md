# How the Codex adapter fits into MultiTable

The Codex SDK lives behind one file: [`packages/daemon/src/agent/providers/codex.ts`](../../../../packages/daemon/src/agent/providers/codex.ts). Read its top-of-file comment block before any change — it captures every constraint that's bitten us before.

## The `ProviderAdapter` contract

Every provider implements [`packages/daemon/src/agent/providers/types.ts`](../../../../packages/daemon/src/agent/providers/types.ts):

```ts
interface ProviderAdapter {
  readonly name: 'claude' | 'codex' | string;
  runTurn(s: AgentSession, text: string, ctrl: AbortController, cb: AdapterCallbacks): Promise<void>;
  reset?(s: AgentSession): void;
}
```

`AdapterCallbacks` is the bag of "things the manager owns; an adapter calls into them when it has output to publish." It's owned by [`packages/daemon/src/agent/manager.ts:389-464`](../../../../packages/daemon/src/agent/manager.ts#L389-L464) (`makeAdapterCallbacks`). The list, with what each one does:

| Callback | What it does in the manager |
|---|---|
| `pushMessages(messages)` | Append to `s.messages` (in-memory chat history). |
| `emitAssistantMessage(messages)` | EventEmitter `'assistant-message'` → server.ts → WS `session:assistant-message`. |
| `emitToolEvent(messages)` | EventEmitter `'tool-event'` → WS `session:tool-event` (tool_use + tool_result). |
| `emitUserMessage(messages)` | EventEmitter `'user-message'` → WS `session:user-message`. |
| `emitAssistantDelta(text)` | Streaming text preview. Updates `s.streamingText` and emits to WS. **Pass full body, not delta.** |
| `emitToolDelta(payload \| null)` | In-flight tool preview (command output, mcp result, etc.). `null` clears. |
| `emitReasoningDelta(text)` | In-flight chain-of-thought preview. Empty string clears. |
| `setCurrentTool(name \| null)` | Updates `s.currentTool` (status-bar display). |
| `bumpActivity()` | Pokes `s.lastActivity` so the watchdog doesn't fire. |
| `applyUsage({ tokensIn, tokensOut, cacheCreationTokens, cacheReadTokens, costUsd })` | Adds to running totals; inserts cost record. |
| `emitTurnResult({ subtype, totalCostUsd, usage, text })` | EventEmitter `'turn-result'` → WS `session:turn-result`. |
| `emitStateSnapshot()` | Emits the full stat snapshot for the live cost panel. |
| `onSessionIdAssigned(threadId, history)` | Persists the thread id to DB on first `thread.started`. |
| `maybeRenameFromFirstPrompt(text)` | Auto-renames the session from the first prompt. |
| `emitReconciled(addedMessageIds)` | Tells the frontend the daemon just synced from the JSONL. |
| `emitMessageRekey(oldId, newId)` | Tells the frontend to swap an in-store message id (optimistic → canonical). |

The adapter must NOT touch `s.state`, the `currentTurn` field, the abort controller, or the database directly. The manager owns those.

## The shape of `runTurn`

```ts
async runTurn(s, text, ctrl, cb) {
  if (s.userMessages.length === 1) cb.maybeRenameFromFirstPrompt(text);
  const thread = await this.getThread(s);          // create-or-resume
  
  // Snapshot turnIndex from disk so live ids match what the parser will produce later.
  const turnIndex = s.agentSessionId ? countCodexTurns(s.agentSessionId) : 0;
  this.turnStates.set(s.id, { turnIndex, seq: new Map(), reconcileTimer: null });
  
  try {
    const { events } = await thread.runStreamed(text, { signal: ctrl.signal });
    for await (const event of events) {
      this.handleEvent(s, event, cb);              // see events-and-streaming.md
    }
    this.scheduleReconcile(s, cb);                 // 250ms after stream end
  } catch (err) {
    this.threads.delete(s.id);                     // poison the cached Thread
    this.scheduleReconcile(s, cb);                 // recover partial output if any
    throw err;
  }
}
```

The manager wraps this in:

1. A 5-minute no-progress watchdog that calls `ctrl.abort()` if no event arrives (re-armed on every event; suspended while a permission/elicitation is pending — though those don't apply to Codex).
2. A `try/catch/finally` that turns exceptions into `session:turn-error` events, sets `s.state = 'errored'`, and always emits `'turn-complete'`.

See [`packages/daemon/src/agent/manager.ts:191-378`](../../../../packages/daemon/src/agent/manager.ts#L191-L378) for the full wrapper.

## The thread cache

```ts
private threads = new Map<string, Thread>();
```

One `Thread` instance per MultiTable session id. Created lazily on first turn (via `startThread` or `resumeThread`). The cache is rebuilt from the DB on daemon restart — see `register()` in the manager.

The cache is poisoned (deleted) when:

- A turn throws (so the next turn re-resolves the thread, which is cheap).
- The session is removed (`reset()` clears the entry).
- The session is `resetSession()`'d for `/clear` (clears the entry and the persisted `agentSessionId`).

The thread's only state is its `id`; we cache it primarily to avoid re-parsing the cwd / git-repo-check on every turn.

## The turn-state map

```ts
interface TurnState {
  turnIndex: number;
  seq: Map<string, number>;     // per-item-kind seq counter
  reconcileTimer: NodeJS.Timeout | null;
}
private turnStates = new Map<string, TurnState>();
```

This drives canonical id minting. See `nextSeq()` and `codexCanonicalId()` — the goal is for live event handling and on-disk JSONL parsing to produce **identical ids** for the same item, so dedupe / rekey works trivially.

`turnIndex` is read from disk via `countCodexTurns(threadId)` at the start of each turn — it counts existing `turn.completed` events in the JSONL and uses that as the upcoming turn's 0-based index. This couples the adapter to the parser's id scheme; if you change one, change both.

## Adding a new feature

| Feature | Where to add |
|---|---|
| Handle a new `ThreadItem` type | `handleEvent` switch + `itemToMessages` switch. Mirror in `transcripts/codexParser.ts`. |
| Forward a new live preview kind | `updateToolDelta` / `updateReasoningDelta` / `updateAssistantDelta`. |
| Pass a new `ThreadOption` | `getThread()` in the adapter; consider DB persistence too. |
| New CodexOptions config | Move `new mod.Codex()` in `getClient()` to accept options; today we instantiate without any — adding any global option is a one-liner there. |
| New WS event needed | Add a new callback in `AdapterCallbacks` (types.ts), implement it in `makeAdapterCallbacks`, wire `server.ts` to forward to WS. |

The rule of thumb: only [`packages/daemon/src/agent/providers/codex.ts`](../../../../packages/daemon/src/agent/providers/codex.ts) and [`packages/daemon/src/transcripts/codexParser.ts`](../../../../packages/daemon/src/transcripts/codexParser.ts) should grow with Codex-specific changes. If you find yourself editing the manager for Codex behavior, the change probably belongs in the AdapterCallbacks bag instead.
