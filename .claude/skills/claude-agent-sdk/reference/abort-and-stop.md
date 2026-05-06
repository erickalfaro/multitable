# Aborting and stopping a turn

## Two stop mechanisms

The SDK exposes two ways to stop a turn:

1. **`Options.abortController`** — pass an `AbortController` when calling `query()`. Calling `.abort()` on it ends the iterator.
2. **`Query.interrupt()`** — a method on the `Query` object returned by `query()`. Only available in streaming-input mode (per [`sdk.d.ts:1962-1970`](../../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts)).

MultiTable uses **AbortController** because we own the controller anyway (we need it for the watchdog timer). `Query.interrupt()` would also work but adds nothing.

## The Phase 0 correction

```ts
abortController: ctrl,         // ✅ correct
abortController: ctrl.signal,  // ❌ wrong — silently no-ops
```

The SDK option is named `abortController` and expects the *controller*, not the `signal`. The SDK reads `.signal` off the controller internally. Passing the signal directly does not error but the abort never propagates. See the explicit comment at [`agent/manager.ts:290`](../../../../packages/daemon/src/agent/manager.ts):

```ts
// NOTE: Phase 0 correction — SDK accepts the controller, NOT just its signal.
abortController: ctrl,
```

## What happens on abort

1. `ctrl.abort()` fires the signal.
2. The SDK's internal stream sees the abort and ends the underlying connection.
3. The `for await (const msg of it)` loop returns.
4. Execution falls through to the `finally` block ([`agent/manager.ts:354-378`](../../../../packages/daemon/src/agent/manager.ts)).
5. The finally clears streaming state, sets state to `'stopped'`, emits `turn-complete`.

The `for await` may take a fraction of a second to actually return after abort, depending on what the SDK is doing (waiting on an HTTP read vs. between messages). Don't rely on it being instant.

## MultiTable's stop endpoint

[`api/sessions.ts:312-317`](../../../../packages/daemon/src/api/sessions.ts):

```ts
router.post('/:id/stop', (req, res) => {
  agentManager.abortTurn(req.params.id);
  res.json({ ok: true });
});
```

[`agent/manager.ts:820-829`](../../../../packages/daemon/src/agent/manager.ts):

```ts
abortTurn(sessionId: string): void {
  const s = this.sessions.get(sessionId);
  if (!s) return;
  if (!s.currentTurn) return;
  try {
    s.currentTurn.abortController.abort();
  } catch (err) {
    console.error('[agent] abortTurn failed:', err);
  }
}
```

Three behaviors worth knowing:

- **Idempotent.** Calling abort twice is safe; the second call is a no-op.
- **Returns immediately.** Doesn't wait for the turn to finish unwinding. The caller can re-poll session state to confirm.
- **Doesn't kill the session.** The next `sendTurn` works normally; only the in-flight turn ends.

## Pending permission/elicitation prompts during abort

When you abort a turn while a permission or elicitation prompt is open:

- The signal passed into `canUseTool` / `onElicitation` fires.
- [`permissionManager.ts:568-589`](../../../../packages/daemon/src/hooks/permissionManager.ts) cleans up the SDK resolver and resolves with `{ kind: 'deny', message: 'Cancelled' }`.
- [`elicitationManager.ts:77-86`](../../../../packages/daemon/src/hooks/elicitationManager.ts) does the same with `{ action: 'cancel' }`.
- The pending UI prompt should also be removed — the WS event `permission:resolved` / `elicitation:resolved` fires.

This is the right behavior: the user said "stop" → we stop asking them things and end the turn cleanly.

## The watchdog

[`agent/manager.ts:235-270`](../../../../packages/daemon/src/agent/manager.ts) sets a 5-minute no-progress timer:

- Armed on turn start.
- Re-armed every time the SDK iterator yields a message.
- **Disarmed (re-armed without action)** when `permManager.hasPending(sessionId)` or `elicitManager.hasPending(sessionId)` — because waiting on user input isn't progress, but also isn't a hang.
- On expiry, calls `ctrl.abort()` and surfaces a "no response in 5 minutes" error.

This catches:
- TLS handshake retry loops (corporate proxies)
- Stuck `claude` subprocess
- Network drops mid-stream
- The SDK's own bugs that leave the iterator hanging

It does **not** trigger during legitimate long tool runs (5-minute budget per silent stretch is generous). If your tool legitimately runs longer than 5 minutes, increase `NO_PROGRESS_MS`.

## Mid-stream stop pattern

To stop a turn mid-stream from the daemon side, the entire flow is:

```
UI clicks Stop
→ POST /api/sessions/:id/stop
→ agentManager.abortTurn(sessionId)
→ ctrl.abort()
→ SDK iterator ends
→ for await loop returns
→ finally block:
   - s.streamingText = ''
   - s.streamingBlockIndex = null
   - emit assistant-delta ''
   - emit tool-delta null
   - emit reasoning-delta ''
   - s.state = 'stopped'
   - emit state-changed stopped
   - emit turn-complete
→ Pending canUseTool/onElicitation Promises:
   - signal fires
   - PermissionManager / ElicitationManager remove pending entries
   - emit permission:resolved / elicitation:resolved
```

There is no separate "abort the streaming preview" step. The preview clears as a side effect of the finally block.

## What you should NEVER do

- **Don't try to abort by sending a special "stop" message through `query()`'s `prompt` iterable.** That's a model-level interrupt, not a turn-level one. Use the AbortController.
- **Don't manually `s.streamingText = ''`** outside the manager — race conditions with the stream-event handler. Let the finally do it.
- **Don't kill the daemon process** to stop a turn. The session state goes inconsistent; you'll have orphan rows on restart.
- **Don't rely on `sawAnyMessage` for abort detection.** [`agent/manager.ts:252,308-311`](../../../../packages/daemon/src/agent/manager.ts) uses it only to distinguish "API never responded" from "API went silent mid-turn" for the error message.
