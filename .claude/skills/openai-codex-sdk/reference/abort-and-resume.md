# Aborting a turn and resuming a thread

## Aborting

The only abort knob is `TurnOptions.signal`:

```ts
const ctrl = new AbortController();
const { events } = await thread.runStreamed(text, { signal: ctrl.signal });
// later:
ctrl.abort();
```

The SDK passes `signal` straight to Node's `child_process.spawn(..., { signal })` — when fired, Node sends `SIGTERM` to the codex child by default and the spawn rejects.

### What you observe in the for-await loop

- Every event yielded **before** the abort is preserved by the consumer (you've already destructured them).
- The next iteration after stdout EOF causes the async generator to throw an `AbortError`-shaped exception (the message often looks like `"Codex Exec exited with signal SIGTERM: <stderr>"`).
- The SDK calls `child.kill()` in its own `finally` (idempotent if the child is already dead).

The recommended pattern (see [`packages/daemon/src/agent/providers/codex.ts:101-148`](../../../../packages/daemon/src/agent/providers/codex.ts#L101-L148)):

```ts
try {
  const { events } = await thread.runStreamed(text, { signal: ctrl.signal });
  for await (const event of events) {
    try { handleEvent(event); } catch (err) { /* recoverable */ }
  }
  scheduleReconcile();          // best-effort recovery from on-disk JSONL
} catch (err) {
  scheduleReconcile();          // partial output may exist on disk
  throw err;                    // bubble up so the manager records the error
}
```

### What's preserved on abort

- **Events already yielded** are observed by your consumer code.
- **The on-disk JSONL** under `~/.codex/sessions/.../rollout-*.jsonl` retains everything the codex CLI flushed before it died. This is the source of truth for "did the agent finish that file edit before I aborted?"
- **`Usage` is NOT delivered.** The aborted turn produces no `turn.completed`, so no usage record.

### What's NOT preserved

- **The in-memory `Turn` object from `run()`** is not returned — `run()` throws.
- **`thread.id`** is preserved IF `thread.started` had already arrived. If you abort *before* the first event, `thread.id` is still `null` and you cannot resume — the run produced nothing on disk.

### Footguns

1. **Aborting before `thread.started`** leaves the thread unresumable. Practical takeaway: don't expose a "stop" UI affordance until the user has seen at least one event arrive.

2. **The child may ignore SIGTERM.** A misbehaving codex binary or a long-running shell child it spawned can ignore SIGTERM. The for-await loop will not exit until the child dies. If you need a hard timeout, wrap the abort with a `setTimeout` that calls `ctrl.abort()` again (Node will eventually send SIGKILL on its own, but this is implementation-defined).

3. **Aborts arrive as exceptions** — they look identical to genuine errors at the throw site. Branch on `err.name === 'AbortError'` or check `ctrl.signal.aborted` to distinguish "user pressed stop" from "agent crashed".

4. **The SDK's error message format includes raw stderr**. If you display the exception verbatim, you may show the user a blob of internal codex CLI logging. Strip it for UI purposes; keep the full message in daemon logs.

## Resuming

```ts
const thread = codex.resumeThread(savedThreadId, {
  workingDirectory: cwd,
  sandboxMode: 'workspace-write',
  approvalPolicy: 'never',
  // any other ThreadOptions you want for the next turn
});
await thread.runStreamed("Continue.");
```

### What `savedThreadId` is

- The internal **session_id** the codex CLI assigned at thread creation.
- It is exposed to your code as `thread.id` (string) **after** the first `thread.started` event arrives.
- It is NOT a file path. The CLI looks the id up by scanning `~/.codex/sessions/**/rollout-*-{id}.jsonl`. Renaming or moving the rollout file is safe as long as the id-in-content is preserved.

### Footguns

1. **`resumeThread()` does not validate the id at construction.** Spawning a turn against a nonexistent id produces a stderr error from the codex CLI that the SDK rethrows.
2. **Options on `resumeThread()` are applied to the next turn**, not retroactively to the original thread. Switching `sandboxMode` on resume is fine; switching `model` is fine; switching `approvalPolicy` is fine (still keep it `'never'`).
3. **The thread does not carry option state across resumes.** Whatever options you pass on each `startThread`/`resumeThread` call is what that turn uses.

## Where MultiTable does this

- `abortTurn(sessionId)` lives in [`packages/daemon/src/agent/manager.ts:820-829`](../../../../packages/daemon/src/agent/manager.ts#L820-L829). It calls `s.currentTurn.abortController.abort()`. The for-await loop in [`packages/daemon/src/agent/providers/codex.ts:103`](../../../../packages/daemon/src/agent/providers/codex.ts#L103) exits, the `catch` schedules a reconcile, and the manager's `finally` clears state.
- Resume is handled by [`packages/daemon/src/agent/providers/codex.ts:258-279`](../../../../packages/daemon/src/agent/providers/codex.ts#L258-L279) in `getThread()`. We always call `resumeThread()` if `s.agentSessionId` is set, otherwise `startThread()`. The thread instance is cached per multitable session id; it's invalidated only on session removal or on a turn that throws.
- Past-thread resume from the UI (the AddAgentModal "Or resume a Codex thread" section) goes through `GET /api/transcripts/codex` to list rollout files and `POST /api/transcripts/codex/:threadId/resume` to materialize a new MultiTable session pointing at that thread id.

## Persistence (where the JSONL lives)

```
~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl
```

- The codex CLI is the **sole writer**; the SDK never touches this directory.
- Format: line-delimited JSON. Each line is one of: a session-meta record, an item event, a turn event, or a `token_count` record.
- The id you pass to `codex.resumeThread(id)` is the embedded `session_id`, not the filename.
- We parse this in [`packages/daemon/src/transcripts/codexParser.ts`](../../../../packages/daemon/src/transcripts/codexParser.ts). See [`multitable/reconcile-and-jsonl.md`](../multitable/reconcile-and-jsonl.md) for why we do.
