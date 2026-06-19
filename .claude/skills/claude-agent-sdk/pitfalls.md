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

## 9. Usage-limit indicator goes blank when not near a limit

**Symptom:** the per-session usage-limits badge shows data only right before you hit a rate limit, then disappears; for a healthy session it's always empty.

**Root cause:** `handleRateLimitEvent` ([`claude.ts:873-899`](../../../packages/daemon/src/agent/providers/claude.ts)) has `if (status === 'allowed') return;` (line ~880) *ahead* of where the snapshot would be emitted. That guard was correct when the handler only fired an alert (you don't want an alert when you're fine). But the always-present indicator needs the **healthy** snapshot too.

**Fix pattern:**
- Build and emit the `UsageLimitSnapshot` via `cb.applyUsageLimits(...)` **before** the `status === 'allowed'` early-return.
- Keep the early-return only to gate the *alert* (`emitAlert`), not the snapshot.
- `rate_limit_info` is one window → one `UsageLimitWindow`. Don't fabricate `primary`/`secondary` (that's Codex's shape).

If you're touching usage limits, read [`reference/usage-limits.md`](reference/usage-limits.md) and the cross-provider spec [`docs/reference/USAGE_LIMITS.md`](../../../docs/reference/USAGE_LIMITS.md).

---

## 10. JSONL resume 400: `diagnostics.previous_message_id`

**Symptom:** the next turn after resuming a Claude session — particularly one started in the bare TUI — fails with:

```
API Error: 400 {"type":"error","error":{"type":"invalid_request_error",
"message":"diagnostics.previous_message_id: must be the `id` from a prior
/v1/messages response (starts with `msg_`)"}}
```

Every retry returns the same 400. The session is permanently 400-poisoned for the lifetime of that JSONL tail.

**Root cause:** the bundled `claude` CLI (the binary at `node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`) ships an experimental **prompt-cache-diagnostics** feature. When it's active, the CLI request builder ends with:

```js
...r && O && z && U && !z$ ? { diagnostics: { previous_message_id: z } } : {}
```

where `z` comes from a backwards walk over the in-memory message list looking for the first `type==='assistant' && requestId` row, returning that row's `message.id` — with **no validation that the id matches `^msg_`**. When the JSONL tail has assistant rows whose `message.id` is a UUID (locally-generated placeholders from a 529 retry storm; harness-emitted pseudo-system notices like the oversized-image warning), the CLI ships the UUID as `previous_message_id` and the API rejects it.

**Two confirmed triggers** (both upstream, both unfixed as of CC 2.1.167):

- [anthropics/claude-code#58427](https://github.com/anthropics/claude-code/issues/58427) — synthetic assistant tail from `<synthetic>` placeholders after `/continue` past a usage-limit/network error. Also reproduces mid-session when the harness emits image-dimension-limit notices as pseudo-assistant rows.
- [anthropics/claude-code#59520](https://github.com/anthropics/claude-code/issues/59520) — pointer advances optimistically before `message_stop`; transient 529/429 leaves it referencing a turn the server never minted a `msg_…` for.

**The gate chain (load-bearing — read before changing the workaround):**

```
diagnostics.previous_message_id is sent  IFF
  Of5() returns true
    └─ k$("tengu_prompt_cache_diagnostics", false) returns true
        └─ vHH() returns true  ← if false, k$ short-circuits to the default (false)
            └─ !rU()
                └─ rU() returns true IFF
                     - CLAUDE_CODE_USE_BEDROCK is set, OR
                     - CLAUDE_CODE_USE_VERTEX is set, OR
                     - CLAUDE_CODE_USE_FOUNDRY is set, OR
                     - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set
```

`tengu_prompt_cache_diagnostics` is a GrowthBook A/B flag with default `false`. Some accounts/sessions get rolled into the experiment and start sending the field; mine did, yours might.

**Fix pattern (we have):** [`agent/providers/claude.ts`](../../../packages/daemon/src/agent/providers/claude.ts) sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` at module load (only if the env doesn't already define it — operator override wins). That collapses `vHH()` to `false`, makes the flag-fetcher short-circuit to its default, and the `diagnostics` block is **never built** for any request. No JSONL mutation, no truncation, no data loss, works for every session including already-corrupted ones.

**Side effects of the env var** (Anthropic-documented, all acceptable here):

| Effect | Impact on MultiTable |
|---|---|
| Disables GrowthBook A/B feature flag fetching | We don't depend on any experimental feature flag. |
| Disables `/feedback` TUI command | Not surfaced in MultiTable's composer. |
| Disables internal cache-hit-rate telemetry | We track our own usage via the `result` message. |
| **Does NOT** disable prompt caching | Caching is the `enablePromptCaching` SDK option — a separate axis. |
| **Does NOT** disable token / cost tracking | Those ride the `result` payload, not the diagnostics path. |

**Operator override:** if a future operator needs the diagnostics feature on (Anthropic engineer debugging cache behavior, etc.), set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=` (empty string also works — the env presence check sees it absent). The module-load shim only sets the var when it's not already in the env, so any preexisting value wins.

**When to revisit this fix:**
- After every `@anthropic-ai/claude-agent-sdk` bump. Re-grep the bundled CLI binary for `previous_message_id`. If the string disappears, the CLI started validating (the bug got fixed). The env shim becomes dead code; remove it and add a one-line note to the SKILL.md changelog.
- If a new bug-shape emerges that this env var doesn't cover (e.g. some other diagnostics field, or a separate corruption path), prefer adding a second env shim or an SDK option over reintroducing JSONL mutation.
- If a real prompt-caching debugging session requires diagnostics ON, set the env var to empty in that operator's shell — don't remove the shim.

**The JSONL-truncation approach we previously shipped:** rejected. Trade-offs were worse than the env-var path:
- It mutated user data (backup files notwithstanding).
- It lost the user's tail prompts (even if those prompts were unrecoverable in the corrupted state, the bare TUI in a healthy account never even tries to send the diagnostics field, so the loss was avoidable).
- It was reactive (per-turn read of the JSONL) rather than preventive.

If you're thinking about reintroducing JSONL surgery for ANY upstream bug, look for an env var first — the CLI's auth/telemetry/feature surface has knobs for almost everything.

---

## When in doubt

- Read [`multitable/architecture.md`](multitable/architecture.md) to find the right file.
- Read [`multitable/event-map.md`](multitable/event-map.md) to find where an event flows.
- Read the SDK type defs at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` if you're unsure about a type shape.
- The migration plan at [`docs/reference/archive/SDK_MIGRATION_PLAN.md`](../../../docs/reference/archive/SDK_MIGRATION_PLAN.md) has historical context for why specific decisions exist.
