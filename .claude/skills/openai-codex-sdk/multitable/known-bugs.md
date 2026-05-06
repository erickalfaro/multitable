# Known Codex-specific bugs to watch for

These are bugs we've either hit, fixed, or worked around in MultiTable. Read this before debugging a Codex session that "just isn't working" — chances are the symptom is here.

## 1. Cumulative-text streaming corruption (HIGH)

**Symptom:** Streaming assistant text shows letters repeating or growing wrong: `"Hello"` → `"Hello Hello"` → `"Hello Hello Hello"`.

**Cause:** Code that *appends* `item.updated.item.text` instead of *replacing* the current preview. The SDK sends each update with the entire accumulated body so far.

**Fix:** Replace, don't append. See `updateAssistantDelta` at [`packages/daemon/src/agent/providers/codex.ts:417-420`](../../../../packages/daemon/src/agent/providers/codex.ts#L417-L420). Frontend handlers must also treat the incoming string as a full replacement.

**Also affects:** `command_execution.aggregated_output`, `mcp_tool_call.result`. Same rule — replace, don't append.

## 2. Reconcile may emit messages for a deleted session (LOW–MEDIUM)

**Symptom:** Frontend logs "received WS event for unknown session id" briefly after a Codex session is deleted mid-turn.

**Cause:** `scheduleReconcile()` arms a 250ms timer. If the session is removed in that window AND `reconcileTurn()` is already executing, the closure-captured `s` is processed and messages are emitted for a session no longer in the manager.

**Status:** Currently benign — frontend store ignores the events because no session with that id exists. But the WS broadcast is wasted, and if the user creates a new session that re-uses the same id (we use UUIDs, so very unlikely), we could leak messages across sessions.

**Hardening:** Add `if (!agentManager.get(sessionId)) return;` at the top of `reconcileTurn`. See [`reconcile-and-jsonl.md`](reconcile-and-jsonl.md).

## 3. Aborted child may ignore SIGTERM (HIGH if it occurs)

**Symptom:** User clicks "Stop", the UI says "stopping...", but `turn-complete` never fires; the session sits at `state: 'running'` indefinitely.

**Cause:** `ctrl.abort()` causes Node to send SIGTERM to the codex child. If the child is itself blocked on a stuck subprocess (e.g. a `command_execution` running `kubectl --context=broken get pods` that's hung on TLS), SIGTERM may not propagate.

**Mitigation:** The 5-minute `NO_PROGRESS_MS` watchdog in [`packages/daemon/src/agent/manager.ts:249-269`](../../../../packages/daemon/src/agent/manager.ts#L249-L269) eventually re-aborts. But a stuck child still won't die without escalation to SIGKILL.

**Hardening idea:** wrap abort in a `setTimeout(() => /* harder kill */, 10000)`. Currently not implemented; rely on watchdog.

## 4. Spawn errors include raw stderr in the exception message (LOW)

**Symptom:** A `session:turn-error` toast displays a wall of internal codex CLI logs.

**Cause:** The SDK rethrows non-zero-exit/signal errors as `Codex Exec exited with signal SIGTERM: <stderr>`. The full stderr is appended.

**Fix:** Strip the `: ` suffix before showing in UI; keep the full message in daemon logs (for debugging). Currently we forward the whole message; if this becomes a UX problem, edit at the manager's catch in [`packages/daemon/src/agent/manager.ts:314-353`](../../../../packages/daemon/src/agent/manager.ts#L314-L353).

## 5. Thread can become unresumable if aborted before `thread.started` (LOW)

**Symptom:** First turn aborted before any event arrives → no `agentSessionId` is set → next "send" creates a fresh thread instead of resuming.

**Cause:** `thread.id` is `null` until `thread.started` arrives. Aborting before then leaves nothing to resume from.

**Why it's "fine":** The aborted thread had no on-disk rollout either, so there's nothing to lose. Practical impact: zero. Just be aware that "abort early → fresh thread next time" is by-design, not a bug.

## 6. `outputSchema` may silently no-op (MEDIUM if used)

**Symptom:** Asked for structured JSON; got plain natural-language text instead.

**Cause:** Upstream issue [#10393](https://github.com/openai/codex/issues/10393). Behavior depends on the codex *binary* version, not the SDK version.

**Mitigation:** Restate the schema in the prompt; validate the response yourself; manual retry on failure. We don't currently use `outputSchema` anywhere in the daemon; if you add it, plan for this case from day one. See [`reference/structured-output.md`](../reference/structured-output.md).

## 7. `Usage` has no USD field (BY DESIGN — don't add)

**Symptom:** Cost panel shows tokens but no dollar amount for Codex sessions.

**Cause:** The Codex SDK's `Usage` type literally does not include cost. Token counts populate; cost does not.

**Fix:** None. The frontend hides the dollar row when `provider === 'codex'`. Don't try to compute cost from token counts on the daemon side — pricing is provider/contract-specific and we don't have the right data.

## 8. `env` option footgun (LOW — we don't use it)

**Symptom:** Passing `env: { PATH: '/usr/local/bin' }` to `new Codex(...)` makes the codex binary's own subprocess spawns fail because `HOME` / `USER` / etc. are missing.

**Cause:** The SDK *replaces* `process.env` entirely when `env` is passed; it doesn't merge.

**Fix:** Spread `process.env` first: `env: { ...process.env, MY_VAR: 'x' }`. We currently don't pass `env` at all — keep it that way unless you have a specific reason.

## 9. Reconcile-without-thread-id (MEDIUM, mitigated)

**Symptom:** Could potentially crash if `parseCodexThread(null)` were called.

**Cause:** Hypothetical — would happen if `reconcileTurn` ran before `thread.started` arrived.

**Mitigation:** [`packages/daemon/src/agent/providers/codex.ts:174`](../../../../packages/daemon/src/agent/providers/codex.ts#L174) early-exits if `!s.agentSessionId`. Don't remove that guard.

## 10. Subagent tracking is heuristic (LOW)

**Symptom:** When the agent uses parallel subagents, MultiTable's "active subagents" counter may be off.

**Cause:** Codex events lack `agent_id`, `agent_name`, and `parent_*` metadata. See [GitHub issue #20979](https://github.com/openai/codex/issues/20979).

**Fix:** None until the SDK adds the metadata. We don't currently track subagents for Codex sessions.

## 11. Unbuffered `item.updated` thrashing (MEDIUM, observed)

**Symptom:** A long-running `command_execution` produces dozens of WS messages per second; the frontend re-renders thrash.

**Cause:** Every `item.updated` for a `command_execution` re-emits the full `aggregated_output` via `cb.emitToolDelta(...)`. There's no rate limiting.

**Mitigation idea (not yet implemented):** Debounce `emitToolDelta` server-side (50–100ms) per item id. The final `item.completed` already overrides whatever the last preview showed, so dropping intermediate updates is safe.

**Where to add:** [`packages/daemon/src/agent/providers/codex.ts:428-477`](../../../../packages/daemon/src/agent/providers/codex.ts#L428-L477) `updateToolDelta`.

## 12. Hardcoded `approvalPolicy: 'never'` (BY DESIGN — don't change)

**Symptom:** Tempted to make `approvalPolicy` configurable per session.

**Cause / why not:** The SDK closes child stdin after writing the prompt. Any policy other than `'never'` requires the child to read approval responses from stdin, which it can't. Other values will hang or fail.

**Fix:** None. The hardcode in [`packages/daemon/src/agent/providers/codex.ts:266`](../../../../packages/daemon/src/agent/providers/codex.ts#L266) is intentional. See [`reference/sandbox-approval-modes.md`](../reference/sandbox-approval-modes.md).

## 13. No equivalent of Claude's `AskUserQuestion` (BY DESIGN)

**Symptom:** UX request: "let the agent ask the user a question mid-turn."

**Cause:** No such primitive in this SDK.

**Workaround:** Watch for an `agent_message` text that ends with a question, abort the turn, surface the question in the chat input, and start a new turn with the user's answer. This is a full UX feature, not a wiring change. Don't try to wire `canUseTool` — it's Claude-only.

## How to add a new entry here

When you fix a Codex bug, add an entry: symptom, cause, fix, and a file:line link to the change. Future-you will be grateful when the bug recurs after a SDK upgrade.
