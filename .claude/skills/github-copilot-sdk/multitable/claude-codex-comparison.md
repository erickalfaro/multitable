# Translating Claude / Codex concepts to Copilot

When you've been working in Claude SDK or Codex SDK code and switch to Copilot, the names and shapes change. This is the lookup table. **Don't import names across SDKs** — each one has its own vocabulary and the agent will fail in confusing ways if you mix them up.

## Top-level mapping

| Concept | Claude Agent SDK | Codex SDK | Copilot SDK |
|---|---|---|---|
| Top-level entry | `query(opts)` async-iterable | `new Codex()` factory | `new CopilotClient()` long-lived RPC client |
| Conversation primitive | A `Query` returned by `query(opts)` | `Thread` (metadata; per-turn spawn) | `CopilotSession` (live RPC handle) |
| Send a turn | Yield from the iterable | `thread.runStreamed(input, opts)` | `session.send({ prompt })` (event-driven, returns messageId immediately) |
| Wait for a turn | `for await (const msg of query)` | `for await (const ev of events)` | `await session.sendAndWait({ prompt }, timeoutMs)` |
| Cancel mid-stream | `query.interrupt()` or `AbortController` on `query` | `AbortSignal` on `TurnOptions.signal` | `await session.abort()` (NO AbortSignal on send) |
| Resume a session | `Options.resume: claudeSessionId` | `codex.resumeThread(threadId, opts)` | `await client.resumeSession(sessionId, config)` |
| Continue most recent | `Options.continue: true` | n/a (per-turn spawns; pass thread id) | n/a (must supply session id) |
| Fork a session | `Options.forkSession: true` | n/a | n/a |
| On-disk persistence | `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` (append JSONL) | `~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl` (append JSONL) | `~/.copilot/session-state/<sid>/checkpoints/NNN.json` (numbered full snapshots) |
| Process model | In-process (one query, async iterable) | Per-turn `codex exec` subprocess | One long-lived `copilot` CLI child via JSON-RPC |

## Permissions / tool gating

| Concept | Claude | Codex | Copilot |
|---|---|---|---|
| Per-call host approval | `canUseTool(toolName, input)` | NONE (sandbox + abort only) | `hooks.onPreToolUse({ toolName, toolArgs }) → { permissionDecision }` |
| Coarse permission gate | `hooks.PreToolUse` (rule-based) | `sandboxMode: 'read-only' \| 'workspace-write' \| 'danger-full-access'` | `onPermissionRequest({ kind })` (kind: shell/write/read/mcp/url/custom-tool/memory/hook) |
| Static disallow | `Options.disallowedTools` | n/a | (no static list; use `onPreToolUse` returning `'deny'`) |
| "Always allow this tool" | Allowlist remembered in PermissionManager | n/a | `defineTool({ skipPermission: true })` or maintain in `onPreToolUse`/`onPermissionRequest` |
| Network gate | Hooks | `networkAccessEnabled: false` | `onPermissionRequest` for `kind: 'url'` |

## Asking the user

| Channel | Claude | Codex | Copilot |
|---|---|---|---|
| Free-text question | Built-in `AskUserQuestion` tool — intercept in `canUseTool` | NONE | `onUserInputRequest(req: UserInputRequest) → UserInputResponse` |
| Multiple-choice question | Same — `AskUserQuestion` with options | NONE | `onUserInputRequest` with `req.choices` |
| Structured form / URL | `onElicitation` (top-level option) | NONE | `onElicitationRequest(ctx: ElicitationContext) → ElicitationResult` |
| Permission for a side effect | `canUseTool` | NONE (sandbox blocks it instead) | `onPermissionRequest(req: PermissionRequest) → PermissionRequestResult` |
| Host wants to ask via tool | Use `onElicitation`-shaped MCP elicitation | n/a | `session.ui.{confirm,select,input,elicitation}` (host → agent direction) |

**Important**: Copilot has THREE separate prompt callbacks (`onPermissionRequest`, `onUserInputRequest`, `onElicitationRequest`) that ALL must be wired or the agent hangs. Claude has TWO (`canUseTool` + `onElicitation`). Codex has ZERO.

## Streaming

| Concept | Claude | Codex | Copilot |
|---|---|---|---|
| Live text deltas | `assistant_text_delta` content blocks (additive) | `item.updated.item.text` (CUMULATIVE — replace) | `assistant.message_delta.deltaContent` (ADDITIVE — append) |
| Live tool output | n/a (tool output lands whole) | `command_execution.aggregated_output` (cumulative) | `tool.execution_partial_result.partialOutput` (additive) |
| Reasoning streaming | n/a (Claude separates reasoning differently) | `reasoning.text` (cumulative) | `assistant.reasoning_delta.deltaContent` (additive) |
| Canonical assistant message | The completed `Message` event | `agent_message` item completed | `assistant.message` event (always fires, even with streaming on) |

⚠️ **The cumulative-vs-additive difference is the #1 cross-SDK porting bug.** Codex deltas are full snapshots — you replace your buffer. Copilot deltas are additive — you append. Claude is also additive. If you copy code between Codex and Copilot adapters, this will silently corrupt the live preview.

## "Done" signals

| Concept | Claude | Codex | Copilot |
|---|---|---|---|
| Per-LLM-call done | `Message` event | `turn.completed` | `assistant.turn_end` |
| Per-tool done | `tool_result` content block | `item.completed` for the tool item | `tool.execution_complete` |
| Whole agent loop done | `result` SDK message | `turn.completed` (since Codex is one LLM call per spawn) | **`session.idle`** (the only true "loop done" signal) |
| Aborted | iterator throws (or `interrupt()` returns) | for-await throws AbortError | `agent.abort` event, then `session.idle` still fires |

⚠️ For Copilot, **`assistant.turn_end` ≠ done**. The agent loop typically chains many LLM calls (turns) per `send()`. Only `session.idle` means safe-to-send-next.

## Hooks / lifecycle

| Hook | Claude | Codex | Copilot |
|---|---|---|---|
| Pre-tool-use | `hooks.PreToolUse` | n/a | `hooks.onPreToolUse` |
| Post-tool-use | `hooks.PostToolUse` | n/a | `hooks.onPostToolUse` |
| Session start | `hooks.SessionStart` | n/a | `hooks.onSessionStart` |
| Session end | n/a | n/a | `hooks.onSessionEnd` |
| User prompt submit | `hooks.UserPromptSubmit` | n/a | `hooks.onUserPromptSubmitted` |
| Stop / loop done | `hooks.Stop` (Claude-specific) | n/a (use for-await end) | observe `session.idle` event (no hook for it) |
| Subagent stop | `hooks.SubagentStop` | n/a | observe `subagent.completed` event |
| Notification | `hooks.Notification` | n/a | observe `system.notification` event |
| Pre-compact | `hooks.PreCompact` | n/a | observe `session.compaction_start` event |
| Error occurred | n/a | n/a | `hooks.onErrorOccurred` (return retry/skip/abort) |

## Modes

| Concept | Claude | Codex | Copilot |
|---|---|---|---|
| Plan mode | `Options.permissionMode: 'plan'` (first-class) | None — approximate via `sandboxMode: 'read-only'` + `modelReasoningEffort: 'high'` | None — approximate via `onPreToolUse → 'deny'` for write tools + system prompt |
| Accept-edits | `permissionMode: 'acceptEdits'` | n/a (`approvalPolicy: 'never'` is hardcoded) | `onPreToolUse → 'allow'` for `kind: 'write'` |
| Bypass permissions | `permissionMode: 'bypassPermissions'` | (sandbox + `additionalDirectories`) | `onPermissionRequest: approveAll` + omit `onPreToolUse` |
| Switch mid-session | `Query.setPermissionMode` | n/a | recreate session (cheap; client is shared) |

## MCP

| Concept | Claude | Codex | Copilot |
|---|---|---|---|
| Configure servers | `Options.mcpServers` | `CodexOptions.config.mcp_servers` (CLI flags) | `SessionConfig.mcpServers` (per-session) |
| In-process MCP server | `createSdkMcpServer(...)` | NONE | NONE — use `defineTool` instead |
| Per-tool host hook | `canUseTool` (one callback) | NONE | `hooks.onPreToolUse` (tool-name based) |
| Runtime add/remove | n/a | rebuild thread | `client.rpc.sendRequest('mcp.config.add', ...)` (no high-level helper) |

## Subagents

| Concept | Claude | Codex | Copilot |
|---|---|---|---|
| Configure | `Options.agents` | n/a | `SessionConfig.customAgents` |
| Routing | Manual via Task tool | n/a | Auto-routed by runtime classification |
| Lifecycle events | Subagent messages in main stream | n/a | Separate `subagent.{started,completed,...}` events |

## Sessions / persistence

| Concept | Claude | Codex | Copilot |
|---|---|---|---|
| Where sessions live | `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` | `~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl` | `~/.copilot/session-state/<sid>/checkpoints/NNN.json` |
| Format | Append JSONL (parseable line-by-line) | Append JSONL (parseable line-by-line) | Numbered JSON snapshots (read latest) |
| Session id | claudeSessionId (UUID) | thread_id (UUID) | sessionId (you supply) |
| Resume | `Options.resume: id` | `codex.resumeThread(id)` | `client.resumeSession(id, config)` |
| List sessions | filesystem walk | filesystem walk | `client.listSessions(filter)` |
| Delete session | rm file | rm file | `client.deleteSession(id)` |

## Cost / usage

| Field | Claude | Codex | Copilot |
|---|---|---|---|
| Per-turn cost USD | `result.total_cost_usd` | NOT surfaced | sum of `assistant.usage.cost` over turn (per-call events; units unconfirmed) |
| Tokens in | `usage.input_tokens` | `usage.input_tokens` | `assistant.usage.inputTokens` |
| Tokens out | `usage.output_tokens` | `usage.output_tokens + reasoning_output_tokens` | `assistant.usage.outputTokens` |
| Cache read | `usage.cache_read_input_tokens` | `usage.cached_input_tokens` | `assistant.usage.cacheReadTokens` |
| Cache create | `usage.cache_creation_input_tokens` | NOT surfaced | `assistant.usage.cacheWriteTokens` |
| Per-call vs per-turn | per-turn (one event) | per-turn (one event) | **per-call** (multiple events per loop) |

## Auth

| Source | Claude | Codex | Copilot |
|---|---|---|---|
| Env var | `ANTHROPIC_API_KEY` | (proxied via codex CLI; `~/.codex/auth.json`) | `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` |
| Login flow | `claude login` populates `~/.claude/auth.json` | `codex login` populates `~/.codex/auth.json` | `copilot` interactive login OR `gh auth login` |
| BYOK | n/a (Anthropic only) | n/a (OpenAI only) | First-class via `SessionConfig.provider` (openai/azure/anthropic, key-based only) |

## "Wrong SDK" cheat sheet

If you find yourself typing one of these in the Copilot adapter, stop:

| Wrong | Right (Copilot) |
|---|---|
| `query(opts)` | `client.createSession(config)` |
| `for await (const msg of query)` | `session.on(eventType, handler)` |
| `Options.resume: id` | `client.resumeSession(id, config)` |
| `Options.continue: true` | (not supported; supply explicit sessionId) |
| `Options.forkSession: true` | (not supported) |
| `Options.permissionMode: 'plan'` | `hooks.onPreToolUse` returning `'deny'` for writes (recipe in `reference/modes-and-permissions.md`) |
| `canUseTool(name, input)` | `hooks.onPreToolUse({ toolName, toolArgs })` |
| `Query.interrupt()` | `await session.abort()` |
| `query.setPermissionMode(...)` | recreate session |
| `Thread`, `runStreamed`, `ThreadEvent`, `ThreadItem` | `CopilotSession`, `session.send`, `SessionEvent` |
| `approvalPolicy: 'never'` | omit `onPreToolUse` + use `approveAll` for `onPermissionRequest` |
| `sandboxMode: 'workspace-write'` | (no equivalent; use permissions) |
| `additionalDirectories: [...]` | `SessionConfig.workspacePath` for cwd; per-write gating in `onPreToolUse` |
| `outputSchema: {...}` | (not first-class; bake into prompt + custom tool) |
| `createSdkMcpServer(...)` | `defineTool(...)` for in-process tools |
| `onElicitation: ...` (top-level Claude option) | `onElicitationRequest` (on `SessionConfig`) |
