# Top pitfalls — read before changing Copilot SDK code

A condensed checklist of things that have bitten us (or that the docs don't make obvious) for `@github/copilot-sdk`. If a PR touches Copilot code, scan this first. The streaming / interception / abort / "is the stream done" categories are exactly the bugs the user called out — they all map to specific items here.

## 1. `assistant.turn_end` is NOT the end of the agent loop

A single user `send()` triggers many "turns" (LLM call → tool → LLM call → tool → final). `assistant.turn_end` fires per LLM call. **Only `session.idle` means the agent loop is fully done.** If you unlock the composer or send the next user message on `turn_end`, you'll race the agent and the next user message will be steered into the still-running turn (or merged via the queue).

Source: `docs/features/agent-loop.md`. Mirror behavior of `session.sendAndWait` — it explicitly waits on `session.idle`, not `turn_end`.

## 2. Streaming deltas are ADDITIVE, not cumulative

`assistant.message_delta.deltaContent`, `assistant.reasoning_delta.deltaContent`, `assistant.streaming_delta.deltaContent`, and `tool.execution_partial_result.partialOutput` are **chunks to append**. Do not replace your buffer.

This is the **opposite** of Codex (`item.updated.item.text` is the full cumulative body — replace). If you copy/paste from `codex.ts`, you will get this wrong. Source: `docs/features/streaming-events.md` ("Accumulate deltas to build the complete content").

## 3. Always replace your live preview with `assistant.message.content` on completion

Even with `streaming: true`, the canonical `assistant.message` event still fires at end-of-turn carrying the full `content`. **Render deltas live, then replace with `assistant.message.content`** to absorb whitespace/formatting drift. Treating the accumulated deltas as final has bitten Claude / Codex integrations identically.

## 4. There are THREE separate "ask the user" channels — wire all three

| Channel | When the agent uses it | Required at construction? |
|---|---|---|
| `onPermissionRequest` | About to do a side effect (shell, write, read, mcp, url, custom-tool, memory, hook) | **Yes — crashes if missing** |
| `onUserInputRequest` | Free-text or multiple-choice question | No — but agent **hangs indefinitely** if not wired |
| `onElicitationRequest` | Structured form / URL request (often from MCP servers) | No — but agent **hangs indefinitely** if not wired |

There is **no host-side timeout** — if you forget one, the agent never returns. Always provide all three. Source: `nodejs/src/types.ts:765-1103`, README "Permission Handling".

## 5. `onPermissionRequest` is mandatory and crashes if omitted

Not a soft error; not a default. `createSession({ ...config /* no onPermissionRequest */ })` will throw the first time the agent wants to run a tool. For headless/daemon use, pass `approveAll` (exported from `@github/copilot-sdk`). Production should route through MultiTable's `PermissionManager` — see [`multitable/integration-plan.md`](multitable/integration-plan.md).

## 6. Abort is `await session.abort()`, NOT an `AbortSignal` on `send()`

`MessageOptions` has `{ prompt, attachments?, mode?, requestHeaders? }` — no `signal`. To cancel:

```ts
await session.abort(); // separate method on CopilotSession
```

After abort: `agent.abort` event fires (with `reason: 'user initiated'`), then `session.idle` still fires, and the session is reusable — `send()` again on the same instance.

## 7. `session.idle` is EPHEMERAL — not in the persisted log

If you replay a resumed session from `~/.copilot/session-state/<id>/checkpoints/`, you will not see `session.idle`. Track in-memory state for "loop done" detection. The same applies to `assistant.message_delta`, `session.title_changed`, and `session.snapshot_rewind`.

## 8. `session.send()` returns immediately with a `messageId`, not a turn handle

It does **not** await completion and does **not** throw on agent errors. To get a Promise<final-message>, use `session.sendAndWait(opts, timeoutMs)` (default 60s timeout). Source: `nodejs/src/session.ts:265-355`.

## 9. Subscribe BEFORE sending — there is a documented race

`sendAndWait` registers its event listener *before* invoking `send` to avoid dropping early events (`session.ts` doc note). Mirror this pattern in custom code:

```ts
const off = session.on('assistant.message', handler);
const id = await session.send({ prompt }); // not before
```

## 10. There is no `off()` method — drop the unsubscribe = leaked handler

`session.on(eventType, handler)` returns an unsubscriber function. Call it. Failing to unsubscribe leaves the handler attached for the session's lifetime; if your handler closes over heavy state, you've leaked it.

## 11. `session.ui.*` is HOST → AGENT, the `on*Request` callbacks are AGENT → HOST

Don't confuse them. `session.ui.confirm()` pushes a UI confirmation request *into* the agent's context (e.g. so a tool can ask the user). `onUserInputRequest` is how you intercept what the agent itself wants to ask the user. They share names but flow opposite directions. Source: `nodejs/src/types.ts:902-936`.

## 12. There is NO native plan / chat / auto mode in the SDK

The TUI's "Plan Mode" (Shift-Tab) and "Autopilot" are CLI features only. `SessionConfig` does **not** expose `mode: 'plan' | 'auto' | 'chat'`. Approximations:

- **Plan-mode-equivalent**: `onPreToolUse → { permissionDecision: 'deny', permissionDecisionReason: 'plan mode — no tool use' }` for any write/shell tool, plus a custom system prompt that asks for a plan.
- **Auto-mode-equivalent**: `onPermissionRequest: approveAll` + `onPreToolUse → { permissionDecision: 'allow' }`.
- **Chat-mode-equivalent**: don't register tools (`tools: []`), or `permissionDecision: 'deny'` for everything.

There IS a `session.mode_changed` event (`from`, `to`) and `exit_plan_mode.requested`/`completed` events, suggesting the CLI exposes mode toggling at runtime — but how to drive it from the SDK is undocumented as of this writing. See [`reference/modes-and-permissions.md`](reference/modes-and-permissions.md).

## 13. Per-tool override via `defineTool({ skipPermission: true })` skips BOTH gates

It bypasses `onPermissionRequest` AND `onPreToolUse`. Use sparingly; only for tools whose execution is provably safe (read-only data fetchers, idempotent lookups). Source: `nodejs/src/types.ts:515-604`.

## 14. Sessions need a stable `sessionId` to be resumable

If you don't supply one, the SDK generates a random id and the session **cannot** be resumed (it can still finish; it just can't be reopened later). Always pass an id you control (the MultiTable `sessions.id` UUID is the obvious choice). Source: `nodejs/README.md` resumability note.

## 15. BYOK keys are NEVER persisted — re-supply on resume

`customProvider.apiKey` / `bearerToken` is in-memory only. On `resumeSession()` you must re-supply the full `provider` config. Source: `docs/features/session-persistence.md`.

## 16. `bearerToken` does not auto-refresh

BYOK auth uses the bearer token verbatim. If you're proxying short-lived OIDC tokens, you must intercept and re-create the session before expiry. GitHub OAuth refresh behavior for the non-BYOK path is undocumented — assume it does not.

## 17. Classic GitHub PATs (`ghp_`) are NOT supported

Token type whitelist: `gho_`, `ghu_`, `github_pat_`. `ghp_` is rejected. Source: `docs/auth/index.md`. Surface this in onboarding errors so users don't paste the wrong token type.

## 18. The CLI server is a child process — `client.stop()` matters

`client.start()` spawns `copilot` (or whatever `cliPath` points to) as a long-lived child. `client.stop()` shuts it down gracefully (returns `Promise<Error[]>` for any per-session shutdown errors); `client.forceStop()` kills hard. On daemon crash you may leak a `copilot` process. Wire `client.stop()` into MultiTable's shutdown sequence (`pids.ts` / SIGTERM handler).

## 19. Sessions persist as numbered JSON checkpoints, NOT JSONL

Path: `~/.copilot/session-state/<sessionId>/checkpoints/001.json`, `002.json`, ... Each checkpoint is a **full snapshot** of conversation history, not an append log. Plus `plan.md` and a `files/` artifact dir alongside.

For a `transcripts/copilotParser.ts` analog of `codexParser.ts`, you read the **highest-numbered checkpoint**, not stream-append. The schema is **not formally documented as stable** — treat as internal, version-pinned, and write a defensive parser. Source: `docs/features/session-persistence.md`.

## 20. `env: NodeJS.ProcessEnv` on `CopilotClientOptions` is a footgun if you're not careful

Like Codex's `env`, this is forwarded to the spawned child. The exact merge semantics aren't documented as starkly as Codex's "REPLACES process.env" warning, but be safe: if you pass `env`, spread `process.env` first.

## 21. The bundled CLI is large

`@github/copilot` is pulled in transitively as a runtime dep — it includes a native binary. Plan for the install footprint and document offline-install constraints. Override via `cliPath` / `COPILOT_CLI_PATH` if you ship your own.

## 22. `assistant.message` ALWAYS fires, even with `streaming: true`

It is not optional. Use it as the canonical message and stop accumulating deltas at that point. If you treat live deltas as final, your stored message may have whitespace/formatting drift from what the agent actually said.

## 23. Tool args are NOT streamed; tool OUTPUT may be

`tool.execution_start.data` carries the full args object. `tool.execution_partial_result.data.partialOutput` may stream incremental output (long shell commands, multi-step tools). Then `tool.execution_complete` carries the final result blocks + status. Pattern:

- Render `partialOutput` as live "tool running" preview.
- Replace with `tool.execution_complete.result` when it lands.

## 24. `session.error` is NOT thrown — it's an event

`session.send()` does not throw on agent errors. Subscribe to `session.error` (`{ category, code, message, stack }`) for recoverable agent errors, and to `onErrorOccurred` hook for retry/skip/abort decisions. Hard transport errors (CLI died, RPC connection lost) DO throw at the JSON-RPC layer.

## 25. Tool failures travel through `ToolResult`, not exceptions

`ToolResultType: 'success' | 'failure' | 'rejected' | 'denied' | 'timeout'`. Branch on this in your tool result handler — don't try to wrap tool calls in try/catch expecting throws.

## 26. Copilot has SUB-AGENTS and SKILLS — separate from tools / MCP

Three orthogonal extension surfaces:
- **Tools** (`SessionConfig.tools` via `defineTool`) — direct callable functions.
- **Skills** — first-class extensions discoverable via `skills.loaded` event, invoked via `skill.invoked`.
- **Custom agents** (`SessionConfig.customAgents`) — sub-agents the runtime auto-routes to based on user request classification. Lifecycle events: `subagent.started/completed/failed/selected/deselected`.

If wiring sub-agents into MultiTable, treat them as separate UI rows (same way we'd treat a Claude SDK subagent) — don't conflate with tools.

## 27. Steering messages bypass abort

`send({ prompt, mode: 'immediate' })` injects a message *during* the running turn (steering); `mode: 'enqueue'` (default) queues for after. To truly stop, call `abort()` first, then `send()`. A stray "immediate" message will be incorporated into the in-flight turn rather than starting fresh. Source: `docs/features/steering-and-queueing.md`.

## 28. The protocol version is pinned

`SDK_PROTOCOL_VERSION = 3` (`nodejs/src/sdkProtocolVersion.ts`). If a CLI binary doesn't speak version 3, `client.start()` will fail. Pin the SDK + bundled CLI versions in lockstep — don't override `cliPath` to a system `copilot` of an unknown version.

## 29. Don't expose a "stop" UI before `session.start` event arrives

Mirrors the Codex rule. If you abort before the session has fully initialized, you may end up with a half-created session that can't be resumed cleanly.

## 30. Do NOT paste Claude Agent SDK or Codex SDK names into Copilot code

Wrong (Claude SDK): `canUseTool`, `permissionMode: 'plan'`, `Query.interrupt()`, `forkSession`, `onElicitation` (Claude has it as a separate top-level option, Copilot has it as `onElicitationRequest` on `SessionConfig`).

Wrong (Codex SDK): `Thread`, `runStreamed`, `approvalPolicy`, `sandboxMode`, `additionalDirectories`, `ThreadEvent`, `ThreadItem`.

Right (Copilot SDK): `CopilotClient`, `CopilotSession`, `session.send`, `sendAndWait`, `session.abort`, `session.disconnect`, `session.idle`, `assistant.message_delta`, `onPermissionRequest`, `onUserInputRequest`, `onElicitationRequest`, `defineTool`, `approveAll`, `mcpServers`, `customAgents`, `hooks.onPreToolUse`.
