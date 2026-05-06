# Aborting a turn and resuming a session

## Aborting

Cancel mid-stream with the dedicated method (NOT an `AbortSignal`):

```ts
await session.abort();
```

`MessageOptions` has **no `signal` field** — there is no per-call AbortSignal. Cancellation is always a separate `abort()` call on the session.

### What you observe after `abort()`

- An `agent.abort` event fires with `data.reason: 'user initiated'` (or other reasons in non-user-initiated paths).
- `session.idle` **still fires** afterward. Treat `session.idle` as the universal "loop is over, clean up" signal regardless of success / abort / error.
- The session **remains valid**: you can `await session.send({ prompt: '...' })` again on the same instance.

```ts
const sawIdle = new Promise<void>((resolve) => {
  const off = session.on('session.idle', () => { off(); resolve(); });
});
await session.send({ prompt: 'long task...' });
setTimeout(() => session.abort(), 5_000);
await sawIdle;     // fires even though we aborted
// session is still usable:
await session.send({ prompt: 'try a different approach' });
```

### What's preserved on abort

- **All events already dispatched** to your handlers are observed normally.
- **The on-disk checkpoints** under `~/.copilot/session-state/<sessionId>/checkpoints/` retain whatever was flushed before abort. The highest-numbered checkpoint is the source of truth for "did this assistant message / tool result actually land?"
- **`assistant.usage`** may or may not fire — depends on whether the LLM call had completed before abort.
- **`assistant.message`** may not fire if abort lands mid-stream. You'll have a live `assistant.message_delta` accumulator with no canonical replacement. Reconcile from the latest checkpoint.

### What's NOT preserved

- The pending `Promise` from `sendAndWait` rejects (or resolves with `undefined` in the timeout path).
- In-flight tool **calls** the SDK started: the SDK will mark them aborted, but if they're your own JS handlers (registered via `defineTool`), the JS function continues executing — the SDK has no way to interrupt synchronous JS. **If your custom tools do long-running work, give them their own `AbortController` and listen for `agent.abort` to cancel them.**
- Steering messages queued via `mode: 'enqueue'` after the abort: behavior is undocumented; safest is to drain the queue on abort by checking `user.pending_messages_modified` and explicitly clearing.

### Footguns

1. **No AbortSignal on `send()`.** Don't try to thread `ctrl.signal` through `MessageOptions` — it doesn't exist there. Always use `session.abort()`.

2. **`send({ mode: 'immediate' })` is steering, not a fresh turn.** A "stop and restart" sequence must be `await session.abort(); await session.send({ prompt })`. Just calling `send({ mode: 'immediate' })` injects into the *running* turn rather than starting fresh.

3. **`session.idle` is ephemeral.** If your daemon crashes and restarts mid-turn, you cannot replay `session.idle` from disk to know whether the prior turn finished. Inspect the checkpoints to figure out where you left off.

4. **Don't expose a "stop" button until `session.start` has fired.** Aborting during session creation has undocumented behavior; the upstream README's examples all wait for `session.start` (or use `sendAndWait`) before exposing cancellation.

5. **`session.disconnect()` is harder than `abort()`.** Disconnect terminates the session entirely (RPC `session.destroy`) — the `CopilotSession` object is dead afterward. Use it on session deletion, not on "stop the current turn." Calling `disconnect()` while a turn is in flight will likely lose the partial output that hasn't flushed to disk.

6. **`client.stop()` cascades.** Stopping the client tears down all sessions belonging to it. If MultiTable has multiple Copilot sessions and only one wants to stop, abort that one — don't stop the client.

## Resuming

```ts
const session = await client.resumeSession(sessionId, {
  onPermissionRequest: approveAll,
  // BYOK keys MUST be re-supplied — they are not persisted:
  provider: { type: 'openai', baseUrl: '...', apiKey: process.env.OPENAI_API_KEY!, /* ... */ },
  // model? (optional override)
});
```

Required: the **same `sessionId`** you used in `createSession`. If you let the SDK auto-generate the id (by omitting it), you cannot resume — the random id is lost.

The `ResumeSessionConfig` accepts the same callbacks as `SessionConfig` (you must re-wire `onPermissionRequest`, `onUserInputRequest`, `onElicitationRequest`, hooks, custom tools, MCP servers). It does **not** persist these in the checkpoint; the daemon must own them.

What gets restored from `~/.copilot/session-state/<id>/`:
- Conversation history (latest checkpoint).
- Plan file (`plan.md`).
- Workspace artifacts (`files/`).

What does NOT get restored:
- BYOK API keys (security).
- In-memory tool state from custom `defineTool` handlers.
- Subscriptions (`session.on` listeners).

## Resume after daemon crash

The MultiTable pattern (mirrors what `AgentSessionManager.register` does for Codex):

1. On boot, load all `sessions` rows from SQLite where `provider = 'copilot'` and `agent_session_id IS NOT NULL`.
2. **Don't** call `resumeSession` eagerly. Wait for the first user `session:send` (or for the user to focus the session).
3. On first send, `await client.resumeSession(s.agentSessionId, config)` and cache the resulting `CopilotSession` in the adapter's per-session map.
4. Hydrate `s.messages` from `~/.copilot/session-state/<s.agentSessionId>/checkpoints/<latest>.json` via the eventual `transcripts/copilotParser.ts`.

Mirror the pattern in [`packages/daemon/src/agent/manager.ts`](../../../../packages/daemon/src/agent/manager.ts) for codex sessions.

## Killing the CLI server cleanly

```ts
// Daemon shutdown:
await client.stop();          // graceful; resolves with per-session shutdown errors
// or, if hung:
await client.forceStop();
```

Wire `client.stop()` into MultiTable's SIGTERM handler in `index.ts`. The Copilot CLI child is a long-lived `copilot` process; orphaning it on daemon crash leaves a zombie that may keep the OAuth credential cache warm and consume a license slot. The `pids.ts` mechanism we use for command/terminal PTYs should also track this child.

## Quick reference

| Action | Call |
|---|---|
| Cancel current turn, keep session | `await session.abort()` |
| End session, free resources | `await session.disconnect()` |
| Stop one session's RPC | `await session.disconnect()` (no separate destroy) |
| Stop the client and all its sessions | `await client.stop()` |
| Hard-kill the CLI child | `await client.forceStop()` |
| Resume a session by id | `await client.resumeSession(id, config)` |
| Detect "loop fully done" | `session.on('session.idle', ...)` |
| Detect abort vs error | watch for `agent.abort` (abort) vs `session.error` (error) |
