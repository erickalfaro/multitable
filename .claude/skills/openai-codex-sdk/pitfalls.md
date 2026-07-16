# Top pitfalls — read before changing Codex code

A condensed checklist of things that have bitten us or that the docs don't make obvious. If a PR touches Codex code, scan this first.

## 1. `item.updated.item.text` is cumulative, not a delta

Replace, don't append. Same for `command_execution.aggregated_output`, `mcp_tool_call.result.content`, etc. Source of #1 streaming bug.

## 2. `approvalPolicy` MUST be `'never'`

The SDK closes child stdin synchronously. Any other value hangs / fails / auto-denies. Hardcoded; don't parameterize.

## 3. There is no host-side approval / question / hook callback

No `canUseTool`, no `onElicitation`, no `hooks`, no `AskUserQuestion`, no `permissionMode`. Sandbox + abort is the only gate. Don't try to invent one — those are Claude SDK names.

## 4. No first-class plan mode in the SDK

Approximate via `sandboxMode: 'read-only'` + `modelReasoningEffort: 'high'`, then resume in `'workspace-write'` to execute. Don't grep for `--plan` in the SDK; it isn't there.

## 5. `Usage` has no USD field

Cost UI hides the dollar row for Codex sessions on purpose. Do not attempt to derive USD from token counts — pricing is contract-specific.

## 6. Item ids (`item_0`, `item_1`, …) are NOT globally unique

They reset every spawn (every turn). Use the `codex:{threadId}:t{turnIndex}:{kind}:{seq}` minted ids, which the JSONL parser also produces, so dedupe works.

## 7. `thread.id` is `null` until `thread.started` arrives

Don't expose a "stop" UI before the first event. Aborting before `thread.started` leaves nothing to resume.

## 8. `env` option REPLACES `process.env`, doesn't merge

If you must pass `env`, spread `process.env` first or you'll lose `HOME`, `PATH`, etc. and the codex CLI's own subprocesses will break.

## 9. The on-disk JSONL is the source of truth

`~/.codex/sessions/.../rollout-*.jsonl`. We reconcile from it after every turn. The live event stream is best-effort. If the live stream and the parser disagree on ids, dedupe falls apart — keep [`agent/providers/codex.ts`](../../../packages/daemon/src/agent/providers/codex.ts) and [`transcripts/codexParser.ts`](../../../packages/daemon/src/transcripts/codexParser.ts) in lockstep.

## 10. `outputSchema` is a tempfile + CLI flag, may silently no-op

Issue [#10393](https://github.com/openai/codex/issues/10393). Validate responses host-side; don't assume schema compliance.

## 11. `--add-dir` grants WRITE access

Don't confuse with read-only mounts. Adding a directory to `additionalDirectories` lets the agent edit files there.

## 12. Aborts arrive as exceptions

Branch on `err.name === 'AbortError'` or check `ctrl.signal.aborted` to distinguish from genuine errors. The SDK's error message often embeds raw stderr — strip before showing in UI.

## 13. `run()` discards `item.updated`

If you want streaming partials, you MUST use `runStreamed()`. Don't use `run()` then complain about no streaming.

## 14. Don't expect `turn.completed` to always arrive

A spawn that dies abnormally ends the for-await without a terminal event. Always run cleanup in a `finally` block; never rely solely on `turn.completed` for state reset.

## 15. `webSearchMode` defaults to `"cached"`, not `"live"`

If a feature requires live search, set `webSearchMode: 'live'` explicitly.

## 16. `skipGitRepoCheck: true` is set in our adapter on purpose

Codex requires a git repo by default. We skip the check because we use `additionalDirectories` and non-git roots. Don't remove the flag.

## 17. The thread cache poisons on error

If `runTurn` throws, we delete the cached `Thread` so the next turn re-resolves it. Don't add code that re-uses a `Thread` after it's thrown — the codex-internal state is uncertain.

## 18. Adding a new `ThreadItem` handler? Mirror it in the parser.

Two places to update: `handleEvent`/`itemToMessages` in [`agent/providers/codex.ts`](../../../packages/daemon/src/agent/providers/codex.ts) AND `parseCodexThread` in [`transcripts/codexParser.ts`](../../../packages/daemon/src/transcripts/codexParser.ts). They mint matching canonical ids, so dedupe works on both the live and on-disk paths.

## 19. There is no `mcpServers` typed option

MCP server config goes through `CodexOptions.config.mcp_servers.*` (which the SDK flattens to `--config` flags). No per-tool host hook.

## 20. Frontend should ignore unknown session ids gracefully

After a session removal, the daemon may still emit a few in-flight WS events for that id (reconcile timer, late event). The store should drop them silently — don't crash.

## 21. `account/rateLimits/updated` is silently dropped (usage-limits indicator stays empty)

**Symptom:** Codex sessions never populate the usage-limits badge, even after turns. No error.

**Root cause:** `account/rateLimits/updated` is **account-scoped** — its params have **no `threadId`**. `CodexAppServerClient.dispatchNotification` ([`codex-app-server/client.ts:160-176`](../../../packages/daemon/src/agent/providers/codex-app-server/client.ts)) reads `params.threadId` and **drops every notification without one** (account/\*, configWarning, app/list/\*). The per-thread `subscribe(threadId, …)` fan-out can never see it.

**Fix pattern:**
- Add an account-listener channel (`subscribeAccount(listener)`) and route `n.method.startsWith('account/')` to it in `dispatchNotification` instead of dropping.
- Register one account listener in warmup (not per-thread); the snapshot is **account-wide** → fan it to all Codex sessions.
- For data before the first turn, also pull `account/rateLimits/read` on provision.
- Consume the **generated** `RateLimitSnapshot`/`RateLimitWindow` types; never hand-edit `codex-protocol/*`.

If you're touching usage limits, read [`reference/usage-limits.md`](reference/usage-limits.md) and the cross-provider spec [`docs/reference/USAGE_LIMITS.md`](../../../docs/reference/USAGE_LIMITS.md).

## 22. The turn completion deferred settles ONLY on notifications — a dead child strands it

`runTurn` awaits a `TurnCompletion` deferred that is resolved by the `turn/completed` **notification** and rejected by the `error` notification — never by an RPC response. On child death the transport's `failAllPending` rejects pending RPC *requests* only, so without extra wiring the turn deferred hangs forever, `runTurn` never settles, and the manager's `finally` (state flip, `turn-complete`, `idle`) never runs → the session pins on "running" with a spinner that never stops.

**Fix pattern (implemented):** `CodexAppServerClient.subscribeExit(listener)` fires on transport exit; the adapter subscribes per turn ([`codex.ts` `runTurn`](../../../packages/daemon/src/agent/providers/codex.ts)) and rejects the deferred with `codex app-server exited mid-turn`, unsubscribing in the turn's `finally`. Also attach a no-op `.catch()` branch to the deferred at creation — if the child dies while `turn/start` is still in flight, both the RPC and the deferred reject, and nothing has awaited the deferred yet.

## 23. `turn/completed` can arrive BEFORE the `turn/start` response assigns `turnId`

Notifications and RPC responses share one stdout pipe. For sub-second turns, `turn/started` + items + `turn/completed` can land **in the same readline chunk** as the `turn/start` response — the notification handler then runs before `completion.turnId = turnId` executes, and a guard like `if (!completion.turnId || …) return;` silently drops the completion → the turn hangs even though the full answer rendered (the classic stuck-spinner bug).

**Fix pattern (implemented):** never drop turn-scoped notifications while `completion.turnId` is null — stash them on `completion.earlyNotifications` and re-dispatch through `handleNotification` immediately after the assignment (the id guard then filters stragglers from other turns correctly). Applied to `turn/completed` and `thread/tokenUsage/updated`; the `error` handler is already null-safe (rejects when the id is unknown — failing defensively is fine, dropping is not).
