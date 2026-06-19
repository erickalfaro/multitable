# Cursor stream-json protocol

Invocation (headless / non-interactive):

```
cursor-agent --print --output-format stream-json --stream-partial-output \
  [--mode plan|ask] [--force] [--model <id>] [--resume <session_id>] \
  [--workspace <dir>] [--trust] "<prompt>"
```

Output is **NDJSON** on stdout — one JSON object per line — then the process
exits. `--stream-partial-output` turns assistant/thinking text into per-token
deltas. `--trust` skips the interactive workspace-trust prompt (required in
headless mode). `--workspace <dir>` sets the cwd (we spawn with `cwd` set, so
this is belt-and-suspenders).

## Event union (observed)

### `system` / `init` — first line
```json
{"type":"system","subtype":"init","apiKeySource":"login",
 "cwd":"…","session_id":"ca32…","model":"Composer 2.5","permissionMode":"default"}
```
Capture `session_id` → `onSessionIdAssigned`. `model` is the **display name**, not
the id.

### `user` — echo of the prompt
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]},"session_id":"…"}
```

### `thinking` — reasoning, additive
```json
{"type":"thinking","subtype":"delta","text":"Listing the","session_id":"…","timestamp_ms":…}
{"type":"thinking","subtype":"completed","session_id":"…","timestamp_ms":…}
```
Accumulate `delta` text → `emitReasoningDelta`. `completed` clears the live slot.

### `assistant` — answer text
Additive token pieces (with `--stream-partial-output`):
```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":" the"}]},"session_id":"…","timestamp_ms":…}
```
Consolidated per-segment (carries `model_call_id`) and a final consolidated line
(no `timestamp_ms`) carry the FULL segment text — do not append these as deltas
(see pitfalls #2).

### `tool_call` — started / completed
```json
{"type":"tool_call","subtype":"started","call_id":"tool_…",
 "tool_call":{"globToolCall":{"args":{"targetDirectory":"…","globPattern":"*"}}},
 "model_call_id":"…","session_id":"…","timestamp_ms":…}

{"type":"tool_call","subtype":"completed","call_id":"tool_…",
 "tool_call":{"globToolCall":{"args":{…},"result":{"success":{…}}}},
 "session_id":"…","timestamp_ms":…}
```
The single key inside `tool_call.tool_call` is the tool name (`globToolCall`,
`shellToolCall`, `readToolCall`, `editToolCall`, …). `result` is `{success:{…}}`
or `{rejected:{reason,isReadonly,…}}` (read-only mode gating — not an error).

### `result` — terminal, with usage
```json
{"type":"result","subtype":"success","duration_ms":11404,"duration_api_ms":11404,
 "is_error":false,"result":"<full assistant text>","session_id":"…","request_id":"…",
 "usage":{"inputTokens":11759,"outputTokens":339,"cacheReadTokens":15194,"cacheWriteTokens":0}}
```
This is the only event with usage and the canonical final text. `is_error:true`
or a non-`success` subtype = turn error.

## Mapping to MultiTable callbacks

| Cursor event | Callback |
| --- | --- |
| `system/init` | `onSessionIdAssigned(session_id, history)` |
| `thinking/delta` | `emitReasoningDelta(accumulated)` |
| `assistant` (additive piece) | `emitAssistantDelta(accumulated)` |
| `tool_call/started` | `pushMessages`+`emitToolEvent` (kind `tool_use`), `setCurrentTool` |
| `tool_call/completed` | `pushMessages`+`emitToolEvent` (kind `tool_result`), `incrementToolCount`, `setCurrentTool(null)` |
| `result` | `applyUsage`, `emitTurnResult`, push canonical assistant/reasoning `Message[]` |
