# `query()` and `Options`

Anthropic docs: https://docs.claude.com/en/api/agent-sdk/typescript • https://docs.claude.com/en/api/agent-sdk/overview

## Signature

From [`sdk.d.ts:2165`](../../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts):

```ts
export declare function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
```

`Query` extends `AsyncGenerator<SDKMessage, void>`. You drive it with `for await`. It also exposes control methods you can call concurrently while iterating: `interrupt()`, `setPermissionMode()`, `setModel()`, etc. (see [`abort-and-stop.md`](abort-and-stop.md) and [`permissions-modes.md`](permissions-modes.md)).

### Two prompt forms

- **String prompt (single-message mode):** one user message, then the SDK runs to completion. Simpler, no images, no mid-conversation interruption beyond `abort`. This is what MultiTable currently uses.
- **`AsyncIterable<SDKUserMessage>` (streaming input mode):** lets you yield additional user messages over time, attach images, and use `Query.setPermissionMode()` / `setModel()` mid-conversation. Switch to this if you need image attachments, multi-turn within one `query()` call, or per-turn mode switching from the daemon side.

Doc: https://docs.claude.com/en/api/agent-sdk/streaming-vs-single-mode

## How MultiTable calls `query()`

[`packages/daemon/src/agent/manager.ts:277-293`](../../../../packages/daemon/src/agent/manager.ts):

```ts
const it = query({
  prompt: text,
  options: {
    cwd: s.workingDir,
    ...(s.claudeSessionId ? { resume: s.claudeSessionId } : {}),
    ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
    ...(s.model ? { model: s.model } : {}),
    settingSources: ['project', 'user'],
    permissionMode: 'default',
    canUseTool: this.makeCanUseTool(sessionId),
    onElicitation: this.makeOnElicitation(sessionId),
    hooks: this.makeHooks(sessionId),
    includePartialMessages: true,
    abortController: ctrl, // controller, not signal — see abort-and-stop.md
  },
});
```

Every option here is load-bearing. Don't drop one without reading why it's there:

- `cwd` — anchors file-tool sandbox + slash command discovery to the project working tree.
- `resume` — when set, picks up the existing `claudeSessionId` JSONL so the SDK doesn't start a new conversation. See [`sessions.md`](sessions.md).
- `pathToClaudeCodeExecutable` — points at a pinned `claude` binary; otherwise the SDK searches `$PATH`. Useful if multiple installs exist.
- `model` — per-session override; otherwise SDK picks default.
- `settingSources: ['project', 'user']` — load `~/.claude/CLAUDE.md` and `<project>/CLAUDE.md`. Drop to `[]` to isolate from filesystem settings.
- `permissionMode: 'default'` — every tool that isn't auto-deferred or pre-allowed lands in `canUseTool`. See [`permissions-modes.md`](permissions-modes.md).
- `canUseTool` — interactive permission gate. See [`canusetool-and-elicitation.md`](canusetool-and-elicitation.md).
- `onElicitation` — MCP elicitation gate (separate from canUseTool).
- `hooks` — lifecycle observers (PreToolUse, PostToolUse, Notification, ...). See [`hooks.md`](hooks.md).
- `includePartialMessages: true` — turns on `stream_event` SSE deltas. Without this, no streaming preview. See [`streaming-and-lifecycle.md`](streaming-and-lifecycle.md).
- `abortController` — pass the *controller*, not its `signal`. The SDK reads `.signal` off the controller internally. Verified in [`agent/manager.ts:290`](../../../../packages/daemon/src/agent/manager.ts).

## `Options` — full surface

The full type lives at `sdk.d.ts:1118`. Highlights:

| Field | Type | What it does |
|---|---|---|
| `model` | `string` | Model id (e.g. `claude-opus-4-7`). |
| `maxTurns` | `number` | Hard cap on agent turns (subagents count). |
| `cwd` | `string` | Working directory for file/Bash tools. |
| `permissionMode` | `'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan' \| 'dontAsk' \| 'auto'` | Mode for the whole `query()`. See `sdk.d.ts:1757`. |
| `allowedTools` | `string[]` | Pre-approved tool names. NOTE: does NOT constrain `bypassPermissions`. |
| `disallowedTools` | `string[]` | Hard-block list. Wins over modes. |
| `mcpServers` | `Record<string, McpServerConfig>` | MCP server definitions (stdio / http / sse / sdk). |
| `agents` | `Record<string, AgentDefinition>` | Subagent definitions. |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | Lifecycle observers. |
| `canUseTool` | `CanUseTool` | Interactive permission callback. |
| `onElicitation` | `(req, signal) => Promise<ElicitResult>` | MCP elicitation callback. |
| `resume` | `string` | Resume a specific session id. |
| `continue` | `boolean` | Resume the most recent session. |
| `forkSession` | `boolean` | Branch from `resume` instead of appending to it. |
| `settingSources` | `('user'\|'project'\|'local')[]` | Which on-disk settings to load. |
| `systemPrompt` | `string \| { type: 'preset'; preset: 'claude_code'; append?; excludeDynamicSections? }` | Override or extend the default system prompt. |
| `includePartialMessages` | `boolean` | Emit `stream_event` deltas. |
| `abortController` | `AbortController` | The controller, not the signal. |
| `pathToClaudeCodeExecutable` | `string` | Pin a specific `claude` binary. |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | Thinking effort level. |
| `thinking` | `ThinkingConfig` | Adaptive or fixed thinking-token budget. |
| `enableFileCheckpointing` | `boolean` | File-snapshot rollbacks. |
| `persistSession` | `boolean` | Default true. False = memory-only. |

For the full list, search `sdk.d.ts` for `export declare type Options`.

## `SDKMessage` — what the iterator yields

The full union is at `sdk.d.ts:2919` (29 variants). The variants MultiTable handles in [`agent/manager.ts:545-743`](../../../../packages/daemon/src/agent/manager.ts):

| Type | Subtypes / shape | What it means |
|---|---|---|
| `'system'` | `init`, `compact_boundary`, `mirror_error`, `api_retry`, `status`, `task_*`, `notification` | Framing & lifecycle metadata. `init` carries the `session_id`, available tools, and slash commands. |
| `'assistant'` | `message: { content: (TextBlock \| ToolUseBlock \| ThinkingBlock)[], usage }` | Canonical assistant turn. Multiple blocks per message. |
| `'user'` | `message: { content: string \| ContentBlock[] }` | Echoed user message OR tool_result blocks coming back. |
| `'result'` | `subtype: 'success' \| 'error_*'`, `total_cost_usd`, `usage`, `modelUsage`, `result`, `num_turns` | Final summary. **`total_cost_usd` is a client-side estimate** (see [`cost-tracking.md`](cost-tracking.md)). |
| `'stream_event'` | `event: BetaRawMessageStreamEvent` | SSE delta. Subtypes: `content_block_start`, `content_block_delta`, `content_block_stop`, `message_stop`, `message_start`, `message_delta`. See [`streaming-and-lifecycle.md`](streaming-and-lifecycle.md). |
| `'rate_limit_event'` | `rate_limit` info | Rate-limit nag. |
| `'auth_status'` | auth state | Login state changed. |
| `'tool_progress'` | tool-side progress | Long-running tool reports progress. |

Other variants (`hook_started`, `plugin_install`, `task_started`, `notification`, etc.) are emitted but currently logged or ignored. If you handle a new one, add the branch in [`agent/manager.ts:545-743`](../../../../packages/daemon/src/agent/manager.ts) and a converter in [`agent/sdkAdapter.ts`](../../../../packages/daemon/src/agent/sdkAdapter.ts).

## Migration note

The package was renamed from `@anthropic-ai/claude-code` to `@anthropic-ai/claude-agent-sdk`. Migration guide: https://docs.claude.com/en/api/agent-sdk/migration-guide. Two breaking changes worth remembering:

- The default system prompt no longer auto-injects Claude Code's preset. To restore: `systemPrompt: { type: 'preset', preset: 'claude_code' }`. We don't currently set this; the SDK ships a sensible default for our use.
- `settingSources` defaults changed. Pass `[]` to fully isolate; pass `['project', 'user']` to keep CLAUDE.md loading (what we do).
