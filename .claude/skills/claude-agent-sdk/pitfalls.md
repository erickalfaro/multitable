# Known pitfalls

The recurring bug categories. If you're touching this code, read this first.

---

## 1. Streaming preview doesn't clear

**Symptom:** the partial assistant text stays on screen after the turn ends. Sometimes after a tool call. Sometimes after an error.

**Root cause:** code that wipes `s.streamingText` lives only in the `message_stop` branch of `handleStreamEvent`. If `message_stop` doesn't fire — abort, network drop, error mid-stream — the text never clears.

**Fix pattern:**
- Wipe in **three** places, not one:
  1. `message_stop` event ([`agent/manager.ts:529-533`](../../../../packages/daemon/src/agent/manager.ts))
  2. Canonical assistant message arrival ([`agent/manager.ts:644-646`](../../../../packages/daemon/src/agent/manager.ts))
  3. The `finally` block at end of `sendTurn` ([`agent/manager.ts:354-378`](../../../../packages/daemon/src/agent/manager.ts))
- The `finally` is the safety net. Never remove it. Never move clearance logic out of it.

**Why three?** `message_stop` is the normal path. Canonical message is the fallback when the stream wraps up oddly. `finally` is the catch-all for abort/error/iterator-throw.

If you're touching streaming, also read [`multitable/streaming-state-machine.md`](multitable/streaming-state-machine.md).

---

## 2. `AskUserQuestion` not intercepted (or auto-allowed)

**Symptom:** the agent invokes `AskUserQuestion`, but the user doesn't see a prompt. The agent either gets `behavior: 'allow'` (no answers) and re-asks, or auto-defers and silently fails.

**Root cause:** treating `AskUserQuestion` like a regular tool. Two specific bugs:

a) Adding `AskUserQuestion` to the auto-defer set, or generalizing the auto-defer check without carving it out. [`hooks/permissionManager.ts:500`](../../../../packages/daemon/src/hooks/permissionManager.ts) explicitly excludes it — keep that guard.

b) Returning `{ behavior: 'allow', updatedInput: input }` from `canUseTool` for `AskUserQuestion`. The model receives "your call to AskUserQuestion was allowed" but no answer, so it can't proceed. The right pattern is `{ behavior: 'deny', message: JSON.stringify({ questions: [...] with answer: [...] }) }` — the SDK feeds the deny message back as the tool result, and Claude reads the JSON.

**Fix pattern:**
- In the `canUseTool` callback, branch on `toolName === 'AskUserQuestion'`.
- Build a `PermissionPrompt` with `kind: 'ask-question'` and a parsed `questions` array.
- Surface it to the UI via `permission:prompt`.
- When the user submits answers, call `permissionManager.respondAskQuestion(id, answers)` ([`permissionManager.ts:372-408`](../../../../packages/daemon/src/hooks/permissionManager.ts)) which serializes answers into a deny+JSON `message`.

If you're touching `AskUserQuestion`, also read [`reference/canusetool-and-elicitation.md`](reference/canusetool-and-elicitation.md).

---

## 3. "Stream active vs completed" ambiguity

**Symptom:** UI thinks the agent is "still working" after the turn ended. Or thinks the agent is "idle" mid-tool-call. Or shows a spinner that never resolves.

**Root cause:** code conflating *streaming text active* with *turn running*. They are independent:

| Question | Use |
|---|---|
| Is the agent currently working on a turn? | `s.currentTurn !== null` |
| Is text currently streaming? | `s.streamingBlockIndex !== null` (live) or `s.streamingText !== ''` (visible preview) |
| Did the turn just end? | Listen for `turn-complete` event |

A turn can be running with no streaming text (waiting on a tool result, or between blocks). Streaming can be visible after a tool result comes back. They diverge constantly.

**Fix pattern:**
- For "agent is busy" UI state: derive from `s.state === 'running'` (which mirrors `currentTurn !== null` via the state-changed events).
- For "preview visible": derive from `streamingText !== ''`.
- Don't reconstruct one from the other.

If you're touching turn lifecycle, also read [`reference/streaming-and-lifecycle.md`](reference/streaming-and-lifecycle.md) and [`reference/abort-and-stop.md`](reference/abort-and-stop.md).

---

## 4. Stop mid-stream leaves state stuck

**Symptom:** user clicks Stop, the spinner persists, the streaming preview stays. Sometimes the next `sendTurn` throws "turn already in flight."

**Root cause(s):**

a) Passing `abortController.signal` to `Options.abortController` instead of the controller itself. The SDK silently no-ops; `.abort()` does nothing. Always pass the controller. The Phase 0 comment at [`agent/manager.ts:290`](../../../../packages/daemon/src/agent/manager.ts) is load-bearing.

b) Relying on `message_stop` to clear streaming state. On abort, the SDK ends the iterator immediately — there's no `message_stop`. Pivot all cleanup to the `finally` block.

c) Forgetting to clear `s.currentTurn = null` in `finally`. Then the next turn throws.

d) Permission/elicitation prompts left pending when the abort fires. The SDK's `signal` is plumbed through to `requestFromSdk` exactly so the manager can clean up — make sure the abort listener is attached and the pending entry is removed when the signal fires ([`permissionManager.ts:568-589`](../../../../packages/daemon/src/hooks/permissionManager.ts), [`elicitationManager.ts:77-86`](../../../../packages/daemon/src/hooks/elicitationManager.ts)).

**Fix pattern:**
- `s.currentTurn.abortController.abort()` on stop.
- The `finally` block in `sendTurn` does ALL cleanup: streamingText, streamingBlockIndex, currentTurn, state, emits.
- Permission/elicitation managers honor the abort signal and resolve the pending Promise.

If you're touching stop / abort, also read [`reference/abort-and-stop.md`](reference/abort-and-stop.md).

---

## 5. Watchdog firing during legitimate long tool runs

**Symptom:** mid-bash command running `npm install`, the turn aborts with "no response from Claude API in 5 minutes."

**Root cause:** the watchdog ([`agent/manager.ts:235-270`](../../../../packages/daemon/src/agent/manager.ts)) measures iterator silence, not time. While a tool is running, the SDK doesn't yield messages, but no permission/elicitation is pending, so the timer can fire even though the system is healthy.

**Fix pattern:**
- The current 5-minute budget is generous for typical tool runs (npm install, build, tests). If a specific tool legitimately runs longer, extend `NO_PROGRESS_MS`.
- Don't disable the watchdog — it catches real hangs (TLS retry loops, network drops, stuck subprocess).
- Don't try to detect "tool is running" to disarm the timer — the SDK doesn't expose this and detecting from message types is fragile.

The proper fix if 5 minutes is too short is to let users configure it per-session. Until then, increase the constant.

---

## 6. Double WS delivery for `pty-output`

**Symptom:** terminal shows every character twice.

**Root cause:** `pty-output` events being both directly-sent (from `pty/stream.ts` `handleSubscribe`) AND broadcast (from `server.ts`).

**Fix pattern:**
- `pty-output` is the **only** event that's sent direct, not broadcast. Direct delivery happens in [`pty/stream.ts handleSubscribe`](../../../../packages/daemon/src/pty/stream.ts).
- Don't add a broadcast path for it. There's a load-bearing comment in `server.ts` about this.
- All `session:*` events are broadcast (so multiple browser tabs sync). `pty-output` is the only exception.

---

## 7. SDK message types we forgot to handle

**Symptom:** new SDK version ships, daemon logs `[agent] handler error: unhandled message type 'foo'`.

**Root cause:** we don't have a default branch in `handleSdkMessage` ([`agent/manager.ts:545-743`](../../../../packages/daemon/src/agent/manager.ts)). Unknown types are silently dropped.

**Fix pattern:**
- After SDK upgrades, run a few sessions and grep for `[agent] handler error` in logs.
- Add new `case` arms in `handleSdkMessage` and adapter conversions in `agent/sdkAdapter.ts`.
- Type-defs in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` are the source of truth for the union (`SDKMessage` at sdk.d.ts:2919).

---

## 8. Subagent messages clearing parent stream

**Symptom:** parent agent's streaming preview disappears the moment a subagent emits its first message.

**Root cause:** the stream-event handler clears parent `streamingText` indiscriminately on any incoming event. Subagent events have `parent_tool_use_id !== null`.

**Fix pattern:**
- Check `parent_tool_use_id` on stream events. If non-null, route to a separate (or nonexistent) tracking lane for the subagent.
- We currently don't surface subagent live previews. So the right behavior is "if `parent_tool_use_id != null`, ignore." Verify that's what the code does.

---

## When in doubt

- Read [`multitable/architecture.md`](multitable/architecture.md) to find the right file.
- Read [`multitable/event-map.md`](multitable/event-map.md) to find where an event flows.
- Read the SDK type defs at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` if you're unsure about a type shape.
- The migration plan at [`docs/reference/archive/SDK_MIGRATION_PLAN.md`](../../../docs/reference/archive/SDK_MIGRATION_PLAN.md) has historical context for why specific decisions exist.
