# Cursor CLI pitfalls

Provider-specific traps. Read before changing `cursor.ts` / `cursor-cli/`.

## 1. Windows `.cmd` shim — spawn needs the resolved path or a shell

On Windows the CLI is `cursor-agent.cmd` / `cursor-agent.ps1` under
`%LOCALAPPDATA%\cursor-agent\` (PATH-visible). Since Node 18.20/20.x, spawning a
`.cmd` with `child_process.spawn` without `shell:true` throws `EINVAL`. The
runner resolves the real executable (prefer the `.cmd` on win32) and spawns with
`shell:false` by passing the absolute path, OR sets `shell:true` on win32. Never
pass an unescaped prompt with `shell:true` — prefer resolving the absolute path
and `shell:false` so the prompt arg is not re-parsed by cmd.exe.

## 2. Double-counted assistant text (additive vs consolidated)

With `--stream-partial-output`, `{"type":"assistant"}` lines arrive as **additive
token pieces** (`"List"`, `"ing"`, …). BUT Cursor also emits **consolidated**
assistant lines: one per model-call segment carrying `model_call_id` with the
full text of that segment, and a final consolidated line at end of turn. If you
append every `assistant` line you double-count.

Rule the adapter uses: accumulate **only** the additive pieces into the live
delta buffer; treat a line carrying `model_call_id` (or the terminal `result`)
as authoritative, not as a delta to append. The canonical final assistant text is
`result.result`. Keep this logic in one place.

## 3. `result` is the ONLY terminal + usage event

Usage (`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`) and the
final text live solely on `{"type":"result"}`. There is no per-message usage and
no USD figure. Don't look for usage anywhere else; if the child exits without a
`result` line, treat it as a turn error (and surface stderr).

## 4. Read-only modes surface `result.rejected`, not an error

In `plan`/`ask` (and in default mode for non-allowlisted tools), a disallowed
tool call returns `tool_call.completed` with `tool_call.<name>ToolCall.result =
{ rejected: { reason, isReadonly } }` — the turn still succeeds. Render it as a
rejected tool result; do NOT treat it as a turn failure. This is the expected
mode-gating behavior, not a bug.

## 5. Effort is in the model id, not a flag

There is no `--effort`. Tiers are baked into the model id (`gpt-5.5-high`,
`claude-opus-4-7-thinking-max`, `…-fast`). So `capabilities.thinkingEffort =
'unsupported'` and the adapter never sends an effort flag — the picked model id
carries it. Don't add an effort flag mapping.

## 6. NDJSON line buffering across stdout chunks

stdout arrives in arbitrary chunks; a JSON object can be split across two `data`
events. Use a line reader (`readline.createInterface`) or buffer until `\n`.
Never `JSON.parse` a raw chunk. Skip blank lines; log-and-drop non-JSON lines
(Cursor keeps stdout clean for NDJSON but be defensive).

## 7. `--resume <id>` is required for continuity AND keeps the same id

The first turn has no `--resume`; capture `session_id` from `init` and persist it
(`onSessionIdAssigned`). Every later turn MUST pass `--resume <session_id>` or
Cursor starts a fresh chat with no context. The resumed turn re-emits the same
`session_id` in its `init` line (verified) — so don't re-key on resume.

## 8. Tool name lives in the `tool_call` object key

`tool_call.tool_call` is an object with a single key like `globToolCall`,
`shellToolCall`, `readToolCall`, `editToolCall` — the key IS the tool name. Read
the first key, strip the `ToolCall` suffix for display, and pull `args` / `result`
from inside it. New tool kinds appear over time; handle unknown keys generically.
