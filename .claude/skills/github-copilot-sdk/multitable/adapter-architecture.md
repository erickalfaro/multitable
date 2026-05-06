# Copilot adapter architecture (target shape)

This file describes how the Copilot adapter **will** fit into MultiTable's existing daemon. It mirrors the role that [`packages/daemon/src/agent/providers/codex.ts`](../../../../packages/daemon/src/agent/providers/codex.ts) plays for Codex, but with structural differences driven by Copilot's long-lived-child architecture.

## Where it sits

```
packages/daemon/src/
├── agent/
│   ├── manager.ts                  ← dispatch by provider; for copilot, calls copilotAdapter.runTurn()
│   ├── providers/
│   │   ├── copilot.ts              ← NEW — owns CopilotClient + per-session CopilotSession cache
│   │   ├── codex.ts                ← existing — owns per-session Thread cache; spawns codex per turn
│   │   ├── types.ts                ← extends ProviderAdapter.name to include 'copilot'
│   │   └── index.ts
│   └── types.ts                    ← AgentSession.provider: 'claude' | 'codex' | 'copilot'
├── hooks/
│   ├── permissionManager.ts        ← extended with askQuestion() for onUserInputRequest
│   └── elicitationManager.ts       ← reused as-is (Copilot ElicitationContext is similar shape)
└── transcripts/
    ├── parser.ts                   ← Claude JSONL parser
    ├── codexParser.ts              ← Codex JSONL parser
    └── copilotParser.ts            ← NEW — reads ~/.copilot/session-state/<id>/checkpoints/<latest>.json
```

## The big architectural difference vs. Codex

| Concept | Codex adapter | Copilot adapter |
|---|---|---|
| Process model | Spawn `codex exec` per turn | One `CopilotClient` for the daemon's lifetime; sessions multiplex |
| Thread cache | `Map<multitableSessionId, Thread>` (just stores thread id + options for next spawn) | `Map<multitableSessionId, CopilotSession>` (stores live RPC-connected session object) |
| Lifetime | Each `Thread` is essentially metadata; child dies after every turn | `CopilotSession` is alive between turns; subscribers persist; `disconnect()` is the kill switch |
| Daemon shutdown | Nothing to clean up; child is already gone | `await copilotAdapter.shutdown()` → `client.stop()` |
| First-call spawn | Per turn | Once at first session creation |
| Cost of "switching" sessions | Free (just pick a different cached id and spawn) | Free (sessions multiplex inside one client) |

This drives a few specific design choices for `copilot.ts`:

1. **The client is loaded lazily**, on the first `runTurn` call. Daemon boot does not require `@github/copilot-sdk` to be installed — only first use of a Copilot session does.
2. **Per-session subscribers must be cleaned up** on `runTurn` exit (in a `finally`). Otherwise a long-lived `CopilotSession` accumulates handlers across many turns.
3. **`reset(s)` calls `session.disconnect()`** to free RPC resources, then deletes the cache entry. Next turn re-creates a fresh session (re-running `createSession` with the same id will… actually fail, because the id already exists on disk — see below).
4. **`/clear` semantics are tricky.** With Codex, `reset` just drops the thread cache, and the next turn spawns a new thread. With Copilot, "clear conversation" means deleting `~/.copilot/session-state/<id>/` AND calling `disconnect()`. Sequence:
   ```ts
   reset(s) {
     const sess = this.sessions.get(s.id);
     if (sess) sess.disconnect().catch(() => {});
     this.sessions.delete(s.id);
     this.client?.deleteSession(s.id).catch(() => {});  // wipes ~/.copilot/session-state/<id>/
   }
   ```

## The `AdapterCallbacks` mapping

Same `AdapterCallbacks` contract as Codex — see [`packages/daemon/src/agent/providers/types.ts`](../../../../packages/daemon/src/agent/providers/types.ts). Mapping from Copilot events to callbacks:

| Copilot event | AdapterCallbacks call |
|---|---|
| `assistant.message_delta` | `emitAssistantDelta(liveText)` (after additive append) |
| `assistant.reasoning_delta` | `emitReasoningDelta(liveReasoning)` |
| `assistant.message` (canonical) | `pushMessages([msg])` + `emitAssistantMessage([msg])` + `emitAssistantDelta('')` |
| `tool.execution_start` | `setCurrentTool(toolName)` |
| `tool.execution_partial_result` | `emitToolDelta({ toolName, input, output, isError })` |
| `tool.execution_complete` | push canonical tool_use + tool_result Messages, `emitToolDelta(null)` |
| `assistant.usage` (per call) | accumulate locally |
| `session.idle` (per turn) | `applyUsage(...)` + `emitTurnResult(...)` + `bumpActivity()` |
| `session.error` | log + (optional) push system Message; do NOT throw inside handler |
| `agent.abort` | log; the `session.idle` that follows handles cleanup |
| `session.shutdown` | persist cumulative metrics; clear cache |

Note: there is **no per-Copilot-event "session id assigned" callback equivalent** like Codex's `thread.started` event because the `CopilotSession.sessionId` is **already known** when `createSession` resolves (we supplied it). So `cb.onSessionIdAssigned` is called once, immediately after `createSession`, with the same id we passed in.

## Sequence diagrams

### First send to a brand-new Copilot session

```
UI  →  WS session:send (text)
       AgentSessionManager.sendTurn(s, text)
         → CopilotAdapter.runTurn(s, text, ctrl, cb)
              if !this.client: await loadClient()
              if !this.sessions.get(s.id): await client.createSession({ sessionId: s.id, ... })
                                            cb.onSessionIdAssigned(s.id, [])    # confirm id
              register all session.on(...) handlers
              session.send({ prompt: text })  # returns messageId immediately
              wait for session.idle event
              cleanup: unsubscribe all, clear toolDelta/reasoningDelta
```

### Subsequent send (session already cached)

```
UI  →  WS session:send (text)
       AgentSessionManager.sendTurn(s, text)
         → CopilotAdapter.runTurn(s, text, ctrl, cb)
              session = this.sessions.get(s.id)   # cache hit
              register all session.on(...) handlers (fresh per turn — important!)
              session.send({ prompt: text })
              wait for session.idle
              cleanup: unsubscribe all
```

### Daemon restart, then first send

```
boot:
  no eager resumeSession — sessions are loaded from DB but Copilot sessions
  do NOT call resumeSession at boot (saves RPC churn on cold start)
  hydrate s.messages from copilotParser.parseCopilotSession(s.id)

UI  →  WS session:send (text)
       AgentSessionManager.sendTurn(s, text)
         → CopilotAdapter.runTurn(s, text, ctrl, cb)
              if !this.client: await loadClient()
              if !this.sessions.get(s.id): await client.resumeSession(s.id, { ... })
              # rest is identical to above
```

### Stop mid-stream

```
UI  →  POST /api/sessions/:id/stop
       AgentSessionManager.abortTurn(s.id)
         → s.currentTurn.controller.abort()
              ctrl.signal fires
              abortHandler: session.abort()
                → agent.abort event arrives
                → session.idle event arrives
                → cleanup runs (unsubscribe, clear deltas)
              runTurn promise resolves
       state → 'stopped'
```

## Reconciliation strategy

For Codex we built `reconcileTurn` because the live event stream can drop items in edge cases. **For Copilot, the analogous concern is different**: the live stream is JSON-RPC over a persistent connection (not flushed JSONL), so item drops are less likely. But the on-disk checkpoint is still authoritative.

Recommended approach:

1. **Don't reconcile after every turn** by default — trust the live event stream more than for Codex.
2. **DO reconcile in two specific cases**:
   - On `runTurn` failure (caught exception): the live stream may have dropped events.
   - On daemon restart: re-hydrate `s.messages` from the latest checkpoint.
3. **Mint canonical message ids** of the form `copilot:{sessionId}:t{turnIndex}:{kind}:{seq}` so live and on-disk dedupe agree (mirror the Codex pattern in `codexCanonicalId`).

## Schema-pinning the parser

The checkpoint JSON schema is **not documented as stable**. Defense:

1. Validate the checkpoint shape against an expected version field (likely something like `cp.version: 1` — verify on first integration).
2. If the version doesn't match, log a loud warning and fall back to "no history" rather than crashing.
3. Pin `@github/copilot-sdk` to an exact version in `package.json` (no `^`). Bump deliberately and re-verify the parser when upgrading.
4. Generate a few real checkpoint files during integration and store sanitized samples in `packages/daemon/src/transcripts/__fixtures__/copilot/` for parser tests.

## Manager-side dispatch (the only `manager.ts` change)

```ts
// In sendTurn:
if (s.provider === 'codex') {
  return this.codexAdapter.runTurn(s, text, ctrl, this.makeCallbacks(s));
}
if (s.provider === 'copilot') {
  return this.copilotAdapter.runTurn(s, text, ctrl, this.makeCallbacks(s));
}
// fallthrough: claude (inline)
```

`makeCallbacks(s)` already exists for the Codex path; reuse it untouched.

## What this adapter does NOT need

- **No `--resume` zombie detection** (sessions don't have a child process per turn).
- **No `/$bunfs/...` workarounds** (no PTY).
- **No PTY ring buffer** (no PTY).
- **No file-watch restart** (sessions don't restart).
- **No process-conflict detection** (one client, one CLI child, no port contention).

## What this adapter DOES need that Codex doesn't

- **Client lifecycle ownership** — `start()` lazily, `stop()` on daemon shutdown.
- **Subscription bookkeeping** — `session.on(...)` returns an unsubscriber; we have to call it per turn.
- **Three handler functions** at session creation (`onPermissionRequest`, `onUserInputRequest`, `onElicitationRequest`).
- **Six lifecycle hooks** (optional but recommended) on `SessionConfig.hooks`.
- **A `client.deleteSession(id)` call inside `reset()`** to wipe the on-disk state for `/clear`.
