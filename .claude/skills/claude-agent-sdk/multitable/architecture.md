# MultiTable's agent architecture

This is the project-specific overlay on top of the SDK reference. Read [`../SKILL.md`](../SKILL.md) for the high-level map; read this when you need to find your way around the daemon code.

## Boot order

`packages/daemon/src/index.ts` is load-bearing. The order matters because the manager registers existing DB sessions on startup and any of them can have stuck state from a prior run.

1. Load global config (`config/loader.ts`).
2. Reap orphan PIDs (`pids.ts`) — commands/terminals only; sessions don't have a PID.
3. Init SQLite (`db/store.ts`).
4. Construct `PtyManager`, `PermissionManager`, `ElicitationManager`, `AgentSessionManager`.
5. Build Express + WS server (`server.ts`).
6. Walk DB sessions; `agentManager.register(...)` each row. **No SDK calls yet** — the session is just registered with its `claudeSessionId` so the next `sendTurn` can resume.
7. Listen on host:port.

When the user opens the UI and clicks into a session, the WS client subscribes; on the first `session:send`, `agentManager.sendTurn()` finally calls `query()`.

## File map (with role)

| File | Role |
|---|---|
| [`agent/manager.ts`](../../../../packages/daemon/src/agent/manager.ts) | `AgentSessionManager`. Owns sessions, calls `query()`, dispatches `SDKMessage` events, emits to WS. ~1440 lines. |
| [`agent/sdkAdapter.ts`](../../../../packages/daemon/src/agent/sdkAdapter.ts) | Pure functions converting SDK message shapes → MultiTable `Message[]`. |
| [`agent/types.ts`](../../../../packages/daemon/src/agent/types.ts) | `AgentSession`, `AgentMessageOut`, `SendTurnInput`, `AdapterCallbacks`. |
| [`agent/providers/types.ts`](../../../../packages/daemon/src/agent/providers/types.ts) | `ProviderAdapter` contract. |
| [`agent/providers/codex.ts`](../../../../packages/daemon/src/agent/providers/codex.ts) | Codex provider adapter. See [`codex-provider-notes.md`](codex-provider-notes.md). |
| [`hooks/permissionManager.ts`](../../../../packages/daemon/src/hooks/permissionManager.ts) | `canUseTool` Promise machinery + UI plumbing. |
| [`hooks/elicitationManager.ts`](../../../../packages/daemon/src/hooks/elicitationManager.ts) | `onElicitation` Promise machinery. |
| [`hooks/labeler.ts`](../../../../packages/daemon/src/hooks/labeler.ts) | Auto-rename session on first prompt. |
| [`hooks/costParser.ts`](../../../../packages/daemon/src/hooks/costParser.ts) | JSONL → cost summary. |
| [`hooks/optionDetector.ts`](../../../../packages/daemon/src/hooks/optionDetector.ts) | Stop-time detection of clickable options in assistant text. |
| [`pty/stream.ts`](../../../../packages/daemon/src/pty/stream.ts) | WS message router. Routes `session:send` to the manager. |
| [`server.ts`](../../../../packages/daemon/src/server.ts) | Express + WS bridge. Listens on the manager's `EventEmitter`, broadcasts to WS. |
| [`api/sessions.ts`](../../../../packages/daemon/src/api/sessions.ts) | REST endpoints (`stop`, `reset`, `messages`, etc.). |
| [`transcripts/parser.ts`](../../../../packages/daemon/src/transcripts/parser.ts) | JSONL → `Message[]` for transcript browser. Same shape `sdkAdapter` produces. |

## End-to-end flow: a single user turn

```
[Web]                                              [Daemon]
─────                                              ────────

User types "explain auth.ts"
      │
      ▼
wsClient.sendTurn(processId, text)
      │
      ▼
WS msg { type: 'session:send', payload }
      │
      ▼ ────────────────────────────────────► pty/stream.ts handleWsMessage
                                                      │
                                                      ▼
                                              agentManager.sendTurn({ sessionId, text })
                                                      │
                                                      ▼
                                              s.currentTurn = { abortController, ... }
                                              s.state = 'running'
                                              s.messages.push(userMsg)
                                              emit('user-message')   ──► WS 'session:user-message'
                                              emit('state-changed')  ──► WS 'process-state-changed'
                                                      │
                                                      ▼
                                              query({ prompt: text, options: { ... canUseTool, hooks, abortController } })
                                                      │
                                                      ▼
                                              for await (msg of it) handleSdkMessage(...)
                                                      │
                                                      ▼
                                                ┌─────┴─────┬─────────┬──────────┐
                                                │           │         │          │
                                          'system'    'stream_event' 'assistant' 'user' 'result'
                                                │           │         │          │
                                                ▼           ▼         ▼          ▼
                                           init={}    handleStreamEvent   sdkAssistantToMessages
                                                │           │         │
                                                │     emit('assistant-delta')  emit('assistant-message')
                                                │     ──► WS 'session:assistant-delta' ──► WS 'session:assistant-message'
                                                │
                                                │     (canUseTool fires for tool calls)
                                                │           │
                                                │           ▼
                                                │     permManager.requestFromSdk
                                                │           │
                                                │           ▼
                                                │     emit('permission:prompt') ──► WS 'permission:prompt'
                                                │           │
                                                │           ▼ (UI responds)
                                                │     respond() → resolve Promise
                                                │           │
                                                │           ▼
                                                │     SDK proceeds with tool call
                                                ▼
                                          (loop continues)
                                                │
                                                ▼
                                          iterator returns
                                                │
                                                ▼
                                          finally:
                                            clear streamingText
                                            s.state = 'stopped'
                                            emit('turn-complete')
                                            ──► WS 'session:turn-complete'
```

For the full SDK-event → emit-name → WS-name table, see [`event-map.md`](event-map.md).

## Where to make changes

By task:

| Task | File(s) to edit |
|---|---|
| Add a new `Options` field | `agent/manager.ts:sendTurn` (query call) |
| Handle a new `SDKMessage.type` | `agent/manager.ts:handleSdkMessage` + `agent/sdkAdapter.ts` (if it needs conversion) |
| Add a new lifecycle hook | `agent/manager.ts:makeHooks` |
| Change permission flow | `hooks/permissionManager.ts` |
| Change elicitation flow | `hooks/elicitationManager.ts` |
| Add a new emit event | `agent/manager.ts` (emit) + `server.ts` (listen + WS broadcast) |
| Add a new REST endpoint | `api/sessions.ts` (operate on existing id) or `api/projects.ts` (create new) |
| Add a new WS inbound message type | `pty/stream.ts:handleWsMessage` |

## Concurrency model

- One `AgentSessionManager` instance per daemon process.
- One `Map<sessionId, AgentSession>` keyed by id.
- One `currentTurn` per session; `sendTurn` throws if already in flight ([`agent/manager.ts:194`](../../../../packages/daemon/src/agent/manager.ts)).
- `EventEmitter` events fire synchronously; WS broadcasts are async but ordered per client.
- Permission/elicitation Promises bridge async UI input to sync SDK callbacks.

## DB writes

Mostly fire-and-forget (`try { updateSession(...) } catch { /* don't let DB block the turn */ }`). The DB row is a snapshot of the latest state, not a log. The JSONL on disk is the log.

## See also

- [`event-map.md`](event-map.md) — exhaustive event table
- [`permission-and-elicitation-wiring.md`](permission-and-elicitation-wiring.md) — Promise bridge details
- [`streaming-state-machine.md`](streaming-state-machine.md) — `streamingText` / `streamingBlockIndex` transitions
- [`codex-provider-notes.md`](codex-provider-notes.md) — Codex differences
