# The ACP wire protocol (as Grok Build speaks it)

Grok Build implements the **Agent Client Protocol** over **line-delimited JSON-RPC 2.0 on stdio** — one JSON object per line on both stdin and stdout, **no Content-Length framing** — spawned via:

```bash
grok agent stdio
```

> **Everything below is research-derived** (xAI docs + the CodexBar/OpenACP ACP integrations + the ACP spec) and tagged **`VERIFY`** where it must be confirmed against a running `grok agent stdio`. Once `grok-acp/transport.ts` + `client.ts` exist, *our* code is the contract and this doc should quote it (the way [`../../hermes-grok/reference/acp-protocol.md`](../../hermes-grok/reference/acp-protocol.md) quotes the Hermes transport for Hermes).

Protocol version we send: `GROK_ACP_PROTOCOL_VERSION = 1`. **VERIFY** Grok's accepted `protocolVersion` (CodexBar sends `"1"` as a string; the canonical ACP spec uses an integer — Grok may accept either).

## ⚠️ The `\/` method-name shim (mandatory)

Grok's ACP parser does **not** unescape `\/` in JSON-RPC `method` names. Every outbound frame must be post-processed so `method` uses bare `/` (e.g. `session/prompt`, not `session\/prompt`), or the request silently times out. See [`../pitfalls.md`](../pitfalls.md) §1 for the exact shim. This is the first thing `transport.ts` must get right.

## Three frame kinds we receive

The transport classifies every stdout line by the presence of `id` / `method`:

| Frame | Shape | Meaning |
|---|---|---|
| **response** | `{jsonrpc, id, result \| error}` (has `id`, no `method`) | Reply to a request *we* sent. Correlated by `id` against `this.pending`. |
| **notification** | `{jsonrpc, method, params}` (has `method`, no `id`) | One-way agent → client. Almost always `session/update`. |
| **server-request** | `{jsonrpc, method, id, params}` (has *both*) | Agent → client request *we must answer*. Permission prompts; defensively-rejected fs/terminal; possibly workspace-trust (`VERIFY`). |

Non-JSON stdout lines are dropped with a warning. Grok logs to stderr by design — surfaced as `console.warn('[grok-acp]', line)`, operator-debug only.

## Requests we send (client → agent), in rough lifecycle order

| Method | Sent by | Params (`VERIFY` all shapes) | Result |
|---|---|---|---|
| `initialize` | `spawnAndInitialize` | `{ protocolVersion, clientInfo, clientCapabilities }` | `{ protocolVersion?, agentInfo?, agentCapabilities?, authMethods? }` |
| `authenticate` | `spawnAndInitialize` | `{ methodId }` (if `authMethods[]` non-empty) | (ignored; success = no error) |
| `session/new` | `newSession` | `{ cwd, mcpServers: [] }` | `{ sessionId }` |
| `session/load` | `loadSession` | `{ sessionId, cwd, mcpServers: [] }` | (ignored; we return the input id) — **VERIFY** Grok supports `session/load` vs only `session/new` |
| `session/prompt` | `prompt` | `{ sessionId, prompt: [{ type:'text', text }] }` | `{ stopReason, usage? }` |
| ~~`session/set_mode`~~ | — | — | **NOT AVAILABLE (verified 0.2.2):** `session/new` returns no `modes`/`availableModes`, so there's no set-mode. Mode is a spawn-time `grok agent` flag instead; see [`modes.md`](modes.md). |
| `x.ai/billing` | (one-shot probe, optional) | none | billing object — **but `-32601` over agent-stdio in 0.1.x**, see [`xai-auth.md`](xai-auth.md) |

And one **notification** we send (fire-and-forget, no response):

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

This tells Grok *not* to delegate file/terminal work back to us — it keeps its tool surface self-contained under its own workspace-trust/sandbox. **VERIFY** Grok honors `false` and doesn't hard-require host fs (if it does, that's a deliberate capability decision, not an accident).

`mcpServers` is **`[]`** on `session/new`/`session/load` by default — Grok reads MCP config from project `.grok/settings.json`. See [`../pitfalls.md`](../pitfalls.md) §14.

## Server-requests we answer (agent → client)

| Method | Handler behavior |
|---|---|
| `session/request_permission` | Route through `PermissionManager` via `GrokAdapter.handleAcpPermission`. Return the **nested** outcome `{ outcome: { outcome: 'selected', optionId } \| { outcome: 'cancelled' } }`. See [`../multitable/permission-wiring.md`](../multitable/permission-wiring.md). |
| `fs/read_text_file` / `fs/write_text_file` | **throw** `multitable did not advertise fs capability` → `-32000`. |
| `terminal/create` (+ terminal/*) | **throw** `multitable did not advertise terminal capability`. |
| workspace-trust request (name `VERIFY`) | If Grok asks for trust over ACP, route like a permission/elicitation prompt; see [`../pitfalls.md`](../pitfalls.md) §9. |

Any server-request method with no registered handler gets JSON-RPC `-32601` (`method_not_found`); a handler that throws returns `-32000` with the message.

## The handshake → turn lifecycle (planned, mirrors the ACP shape)

```
GrokAcpClient.ensureReady()                          (idempotent; concurrent callers share one promise)
  ├─ GrokAcpTransport.start()  → spawn `grok agent stdio`, wire readline on stdout, install \/ shim
  ├─ request 'initialize'      → read authMethods[] + agentCapabilities
  └─ request 'authenticate'    → pick a non-setup auth method id (if any)
                                  (auth result cached; auth-failure → typed alert + throw)

GrokAdapter.runTurn(s, text, ctrl, cb)
  1. cwd = resolveCwd(s);  client = clientFor(cwd)            // per-cwd child (VERIFY if singleton ok)
  2. await client.ensureReady()  → if auth fails → typed auth alert + throw
  3. grokSessionId = ensureSessionId(...)                     // session/new OR session/load
       └─ if loaded: drain replay flood (VERIFY replay behavior)
  4. off = client.subscribe(grokSessionId, listener)          // BEFORE prompt, can't miss chunks
  5. ctrl.signal 'abort' → client.cancel(grokSessionId)       // session/cancel notification
  6. result = await client.prompt({ sessionId, prompt: [{type:'text', text}] })
       … meanwhile session/update notifications stream to the listener …
  7. emit canonical assistant Message from buffers.assistantText (if non-empty)
  8. applyUsage / emitTurnResult / emitStateSnapshot
  finally: remove abort listener; off()  (unsubscribe)
```

Register the `subscribe` listener **before** `session/prompt` so no early `session/update` is missed.

## `session/update` — the notification kinds to handle

Every user-relevant event arrives as `{ method: 'session/update', params: { sessionId, update } }`, routed by `params.sessionId` to the subscribed listener. Switch on `update.sessionUpdate` (**VERIFY** the exact set Grok emits — the ACP-standard kinds are below; Grok may add subagent/arena kinds):

| `sessionUpdate` kind | Adapter action |
|---|---|
| `agent_message_chunk` | **append** text to `buffers.assistantText`; emit cumulative via `cb.emitAssistantDelta(buffers.assistantText)`; `bumpActivity()` |
| `agent_thought_chunk` | **append** to `buffers.reasoningText`; `cb.emitReasoningDelta(buffers.reasoningText)` |
| `user_message_chunk` | **ignore** — only fires during history replay; manager already has it |
| `tool_call` | record meta, push a `tool_use` `Message`, `emitToolEvent`, `setCurrentTool(name)`, `incrementToolCount` |
| `tool_call_update` | on terminal `status` push canonical `tool_result` `Message` + `setCurrentTool(null)` + clear tool delta; else `emitToolDelta` preview |
| `plan` / `current_mode_update` / `available_commands_update` / `usage_update` | route plan/subagent items into `emitTaskEvent`; mode/commands/usage mostly informational for v1 |
| subagent kinds (Grok runs up to 8 — names `VERIFY`) | normalize into `emitTaskEvent` (the Tasks panel shape) + `incrementSubagents` |
| *default* | **ignore** (v1 scope) — log unknown kinds once so we discover Grok-specific ones |

### The additive-delta rule (the inverse of Codex)

`agent_message_chunk` / `agent_thought_chunk` carry an **additive piece** per the ACP spec. Accumulate, emit the running total. Do **not** copy Codex's "replace, don't append" handling. `capabilities.streamingDeltaSemantics = 'additive'`.

## Cancel & shutdown

- `cancel(sessionId)` sends `session/cancel` **as a notification** (response-less). Don't await. The in-flight `session/prompt` resolves `stopReason: 'cancelled'`.
- `shutdown()` (daemon SIGTERM/SIGINT) closes **every** pooled per-cwd client; `transport.close()` ends stdin, `SIGTERM`s, then `SIGKILL`s after a short grace.

## Failure modes the transport must surface

- Child `spawn` error / `exit` → all pending requests reject (`grok agent stdio exited (code=… signal=…)`); clear transport + auth state.
- `request()` while the child is down → immediate reject.
- Response for an unknown `id` → warn + drop (no crash).
- RPC `error` in a response → reject the pending promise as `${method} failed: ${message}`, copying `code`/`data` onto the `Error` (so `-32601` billing / auth-required can be classified upstream).
