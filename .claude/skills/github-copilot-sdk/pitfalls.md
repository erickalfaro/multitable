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

## 12. Plan / autopilot mode IS native in SDK ≥1.0.5 — via `MessageOptions.agentMode`, per SEND

**Superseded (verified against the installed 1.0.5, 2026-07):** `send({ prompt, agentMode })` takes
`'interactive' | 'plan' | 'autopilot' | 'shell'` per send — no session rebuild for a mode flip, and
none of the onPreToolUse/system-prompt approximations below are needed. Plan mode's execute gate is
the `SessionConfig.onExitPlanModeRequest` handler (`ExitPlanModeRequest { summary, planContent?,
actions, recommendedAction }` → `{ approved, selectedAction?, feedback? }`). The CopilotAdapter maps
it onto the same `ExitPlanMode` PermissionManager prompt Claude/Grok use. Note the runtime uses its
own judgment in plan mode — a trivial request may skip planning and go straight to (permission-gated)
tool use.

`SessionConfig` still has no `mode` field; older SDKs (pre-agentMode) need the composed
approximations described in [`reference/modes-and-permissions.md`](reference/modes-and-permissions.md).

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

## 19. The transcript is `events.jsonl` — checkpoints are COMPACTION SUMMARIES, not history

**Superseded (verified against real CLI 1.0.63–1.0.68 session state):**
`~/.copilot/session-state/<sessionId>/` contains:

- **`events.jsonl`** — the full session event log, one `{ type, data, id, timestamp, parentId }`
  per line (`session.start` with `selectedModel`, `user.message`, `assistant.message` with
  `content`+`reasoningText`+`toolRequests`, `tool.execution_start/complete`, …). **This is the
  transcript source** — `transcripts/copilotParser.ts` parses it. Ephemeral events (deltas,
  `session.idle`) are not persisted.
- `checkpoints/*.md` — markdown **compaction summaries** (`<overview>/<history>/...` sections), NOT
  the conversation. The older "numbered JSON checkpoints" layout this pitfall used to describe no
  longer exists.
- `workspace.yaml` (id, cwd, summary title, timestamps), `session.db`, `files/`, `research/`.

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

## 31. Adapter-integration gotchas verified live on 1.0.5 (2026-07)

- **`reasoningEffort` on a non-supporting model HARD-FAILS `session.create`** ("Model 'x' does not
  support reasoning effort configuration") — it does not degrade like Claude. The adapter retries
  once with the field stripped. `ReasoningEffort` is `'low'|'medium'|'high'|'xhigh'` (no `max`),
  even though `listModels()` advertises `max` on some models — discovery filters `max` out.
- **`SessionConfig` field is `workingDirectory`, not `workspacePath`** (the getter on
  `CopilotSession` is still `workspacePath`).
- **The index does NOT re-export `UserInputRequest` / `UserInputResponse` / `ReasoningEffort`** —
  they exist in `dist/types.d.ts` but aren't in the export list; the adapter mirrors them
  structurally.
- **`data.reasoningText` repeats verbatim on every `assistant.message` within a turn** — dedup
  against the last emitted value or each tool round duplicates the reasoning card (adapter and
  parser both do this).
- **`PermissionRequest` is a rich discriminated union** (shell carries `fullCommandText` +
  `intention`; write carries `fileName` + `diff`; read carries `path`; mcp carries
  `serverName`/`toolName`/`args`) — no need to correlate toolCallId→args via `onPreToolUse`.
  Result enum is `{ kind: 'approve-once' } | { kind: 'reject', feedback? } | …`.
- **No `autoStart` client option in 1.0.5** — call `client.start()` explicitly.
- **`assistant.usage.cost` is the premium-request billing MULTIPLIER, not USD.** Don't record it as
  dollars.
- **`@github/copilot-sdk` ships a CJS build** (`dist/cjs` + `require` export condition) — the
  daemon's Node16/CJS `import` works directly; no dynamic-import hack (unlike codex).
- **Sub-agent events carry `agentId`** — filter them out of the main transcript.

## 21. `session.idle` NEVER fires if the CLI dies after `send()` — bound the wait or hang forever

`session.idle` is the only loop-done signal (pitfall #1) and it is an in-memory push event: if the shared CLI child dies or wedges after `send()` resolves, no error is thrown and no idle ever arrives — an unbounded `await idle` hangs the turn forever (stuck "running" spinner). `session.error` is an event, not a throw, and does not imply the loop ended. There is **no connection-close hook to subscribe to**: `client.rpc` is a typed RPC-namespace facade (not a raw vscode-jsonrpc `MessageConnection` — no `onClose`/`onError`), and the client's connection `state` is private (`getStatus()` is itself an RPC, useless for detecting a dead transport).

**Fix pattern (implemented in [`copilot.ts`](../../../packages/daemon/src/agent/providers/copilot.ts)):**
- Make the idle promise **rejectable** and register the rejecter per in-flight turn (`idleFailers` map).
- **Active liveness probe**: every `CONNECTION_CHECK_MS` (15s), `client.ping(...)` raced against a `PING_TIMEOUT_MS` deadline; consecutive failures ⇒ the child is dead/unresponsive ⇒ fail every in-flight turn, clear the session cache, and null the client so the next turn respawns.
- **Zero-event ceiling** (`IDLE_WAIT_TIMEOUT_MS`, 60 min): if no session event arrived for the whole window and no permission/elicitation prompt is pending (those re-arm the ceiling), reject the idle wait — an hour of total silence is a wedge, not live work.
