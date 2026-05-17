# The ACP wire protocol (as we speak it)

Hermes implements the **Agent Client Protocol** over **line-delimited JSON-RPC 2.0 on stdio** — one JSON object per line on both stdin and stdout. Everything here is quoted from [`packages/daemon/src/agent/providers/hermes-acp/transport.ts`](../../../../packages/daemon/src/agent/providers/hermes-acp/transport.ts) and [`client.ts`](../../../../packages/daemon/src/agent/providers/hermes-acp/client.ts) — *our* implementation is the contract that matters for our code.

Protocol version we send: `HERMES_ACP_PROTOCOL_VERSION = 1`.

## Three frame kinds we receive

The transport classifies every stdout line by the presence of `id` / `method`:

| Frame | Shape | Meaning |
|---|---|---|
| **response** | `{jsonrpc, id, result \| error}` (has `id`, no `method`) | Reply to a request *we* sent. Correlated by `id` against `this.pending`. |
| **notification** | `{jsonrpc, method, params}` (has `method`, no `id`) | One-way agent → client. Almost always `session/update`. |
| **server-request** | `{jsonrpc, method, id, params}` (has *both*) | Agent → client request *we must answer*. Permission prompts; defensively-rejected fs/terminal. |

Non-JSON stdout lines are dropped with a warning (`[hermes-acp] non-JSON stdout line dropped`). **Hermes routes all logging to stderr by design** — stdout is JSON-RPC only. The transport surfaces stderr as `console.warn('[hermes-acp]', line)`; it is operator-debug only, never load-bearing.

## Requests we send (client → agent)

In rough lifecycle order:

| Method | Sent by | Params | Result |
|---|---|---|---|
| `initialize` | `spawnAndInitialize` | `{ protocolVersion: 1, clientInfo, clientCapabilities }` | `{ protocolVersion?, agentInfo?, agentCapabilities?, authMethods? }` |
| `authenticate` | `spawnAndInitialize` | `{ methodId }` | (ignored; success = no error) |
| `session/new` | `newSession` | `{ cwd, mcpServers: [] }` | `{ sessionId }` |
| `session/load` | `loadSession` | `{ sessionId, cwd, mcpServers: [] }` | (ignored; we return the input id) |
| `session/prompt` | `prompt` | `{ sessionId, prompt: [{ type:'text', text }] }` | `{ stopReason, usage? }` |

And one **notification** we send (no response, fire-and-forget):

| Method | Sent by | Params |
|---|---|---|
| `session/cancel` | `cancel` | `{ sessionId }` |

`clientCapabilities` we advertise on `initialize` are deliberately minimal:

```ts
clientCapabilities: {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
}
```

This tells Hermes *not* to delegate file/terminal work back to us — it keeps its tool surface self-contained and runs tools in its own sandbox. We never broker filesystem or terminal access.

`mcpServers` is **always `[]`** on `session/new` and `session/load`. MCP wiring lives on the Hermes side (`hermes tools`), not ours. Don't pass MCP servers from the daemon.

## Server-requests we answer (agent → client)

Registered in `client.ts:registerServerRequestHandlers`:

| Method | Handler behavior |
|---|---|
| `session/request_permission` | If a `permissionHandler` is wired (always, in MultiTable: `HermesAdapter.handleAcpPermission`) route through `PermissionManager`. Otherwise fall back to the auto-policy (`pickPermissionOption`, default `allow_session`) — standalone/test only. See [`../multitable/permission-wiring.md`](../multitable/permission-wiring.md). |
| `fs/read_text_file` | **throws** `multitable did not advertise fs capability` |
| `fs/write_text_file` | **throws** `multitable did not advertise fs capability` |
| `terminal/create` | **throws** `multitable did not advertise terminal capability` |

Any server-request method with no registered handler gets JSON-RPC `-32601` (`method_not_found`); Hermes' own probe filter expects this for `ping`/`health` and continues. A handler that throws is returned as `-32000` with the error message.

## The handshake → turn lifecycle

```
HermesAcpClient.ensureReady()                       (idempotent; concurrent callers share one promise)
  ├─ HermesAcpTransport.start()  → spawn `hermes acp` child, wire readline on stdout
  ├─ request 'initialize'        → read authMethods[]
  └─ request 'authenticate'      → pick first non-`hermes-setup` method id
                                    (auth result cached as HermesAuthState)

HermesAdapter.runTurn(s, text, ctrl, cb)
  1. cwd = resolveCwd(s);  client = clientFor(cwd)            // per-cwd child
  2. await client.ensureReady()  → if 'needsSetup' → typed auth alert + throw
  3. hermesSessionId = ensureSessionId(...)                   // session/new OR session/load
       └─ if loaded: await sleep(500)  ← replay-flood drain (see hydration-and-replay.md)
  4. off = client.subscribe(hermesSessionId, listener)        // BEFORE prompt, can't miss chunks
  5. ctrl.signal 'abort' → client.cancel(hermesSessionId)     // session/cancel notification
  6. body = maybe `/reasoning <level>\n\n` + text             // only if effort changed
  7. result = await client.prompt({ sessionId, text: body })
       … meanwhile session/update notifications stream to the listener …
  8. emit canonical assistant Message from buffers.assistantText (if non-empty)
  9. applyUsage / emitTurnResult / emitStateSnapshot
  finally: remove abort listener; off()  (unsubscribe)
```

The `subscribe` listener is registered **before** `session/prompt` is sent so no early `session/update` is missed. `subscribe(sessionId, …)` *replaces* any prior listener for that id (last-writer-wins per session id).

## `session/update` — the only notification kind we handle

Every user-relevant event arrives as a `session/update` notification: `{ method: 'session/update', params: { sessionId, update } }`. The dispatcher routes by `params.sessionId` to the subscribed listener (notifications with no `sessionId` are dropped). `HermesAdapter.handleNotification` switches on `update.sessionUpdate`:

| `sessionUpdate` kind | Adapter action |
|---|---|
| `agent_message_chunk` | **append** `extractText(content)` to `buffers.assistantText`; emit cumulative via `cb.emitAssistantDelta(buffers.assistantText)`; `bumpActivity()` |
| `agent_thought_chunk` | **append** to `buffers.reasoningText`; `cb.emitReasoningDelta(buffers.reasoningText)`; `bumpActivity()` |
| `user_message_chunk` | **ignored** — only fires during `session/load` history replay; manager already has it |
| `tool_call` | drop if `isHistoricalToolId` (replay); else record meta, push a `tool_use` `Message`, `emitToolEvent`, `setCurrentTool` |
| `tool_call_update` | drop if historical; on `status === 'completed'\|'failed'` push canonical `tool_result` `Message` + `incrementToolCount` + clear tool delta; else emit a mid-execution `emitToolDelta` preview |
| `plan` / `available_commands_update` / `config_option_update` / `current_mode_update` / `usage_update` / *default* | **ignored** (v1 scope) — surface later as needed |

### The additive-delta rule (the inverse of Codex)

`agent_message_chunk` and `agent_thought_chunk` carry an **additive piece** of text per the ACP spec — *not* a cumulative snapshot. The adapter accumulates:

```ts
buffers.assistantText += text;
cb.emitAssistantDelta(buffers.assistantText);   // emit the RUNNING TOTAL
```

`StreamBuffer` (the manager-side reducer) expects **cumulative** semantics on the emit boundary, so we append-then-emit-total. `capabilities.streamingDeltaSemantics` is `'additive'` to document the *wire* shape. **Do not** copy Codex's "replace, don't append" handling — Codex's wire payload is already cumulative; Hermes' is not.

### Tool lifecycle

`tool_call` records `{ toolName, input }` into `buffers.toolCalls` keyed by `toolCallId` and pushes a synthetic `tool_use` `Message` with id `hermes:<agentSessionId|pending>:tool_use:<toolCallId>` and `parentId` `…:assistant:pending`. The matching `tool_call_update` with terminal `status` (`completed`/`failed`) renders output via `renderToolOutput` (joins ACP `content[].content` text blocks; falls back to `rawOutput`), pushes a `tool_result` `Message` (`isError: status === 'failed'`), and deletes the buffer entry. Non-terminal updates with known meta emit an `emitToolDelta` preview.

## Cancel & shutdown

- `cancel(sessionId)` sends `session/cancel` **as a notification** (ACP defines it response-less). We don't await. Hermes flips its internal cancel flag; the in-flight `session/prompt` resolves with `stopReason: 'cancelled'`. If the transport is dead, `cancel` is a silent no-op.
- `HermesAdapter.shutdown()` (daemon SIGTERM/SIGINT) closes the injected client (tests) and **every** pooled per-cwd client. `HermesAcpTransport.close()` ends stdin, sends `SIGTERM`, and `SIGKILL`s after a 2s grace timer.

## Failure modes the transport surfaces

- Child `spawn` error or `exit` → all pending requests reject with `hermes acp exited (code=… signal=…)`; client clears transport + authState (`onTransportExit`).
- `request()` while the child is down → immediate reject `hermes acp is not running (method=…)`.
- Response for an unknown `id` → warn + drop (no crash).
- RPC `error` in a response → rejects the pending promise as `${method} failed: ${message}`, copying `code`/`data` onto the `Error`.
