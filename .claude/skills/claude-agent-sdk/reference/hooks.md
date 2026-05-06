# Hooks

Anthropic doc: https://docs.claude.com/en/api/agent-sdk/hooks

> **Two layers, same vocabulary.** "Hooks" can mean two different things:
> - **SDK hooks** (this file) — JavaScript callbacks passed via `Options.hooks` to `query()`. They run inside the daemon process. This is what `agent/manager.ts:makeHooks` configures.
> - **Claude Code hooks** — shell commands / HTTP endpoints declared in `.claude/settings.json`, run by the Claude Code CLI itself. See the sibling skill `claude-code-hooks`.
>
> The lifecycle event names overlap (`PreToolUse`, `PostToolUse`, `Stop`, ...) but the two layers are independent. The SDK runs its own callbacks; if `settingSources` includes `'project'` or `'user'`, the SDK ALSO loads `.claude/settings.json` hooks and runs them. They both fire. This file is about the SDK-callback layer.

Hooks observe (and optionally short-circuit) lifecycle events. Unlike `canUseTool` and `onElicitation`, hooks are **not** for prompting the user — they should not block on UI input. Use them for static rules, logging, side effects, and observability.

## Event list

From [`sdk.d.ts:713-732`](../../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts):

```ts
type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'UserPromptExpansion'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'StopFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'Setup'
  | 'TeammateIdle'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'InstructionsLoaded'
  | 'CwdChanged'
  | 'FileChanged';
```

## Callback signature

[`sdk.d.ts:718`](../../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts):

```ts
type HookCallback = (
  input: HookInput,           // discriminated by hook_event_name
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

`HookCallbackMatcher` ([`sdk.d.ts:725`](../../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts)):

```ts
interface HookCallbackMatcher {
  matcher?: string;          // regex against tool_name (PreToolUse/PostToolUse only)
  hooks: HookCallback[];
  timeout?: number;          // seconds
}
```

`HookJSONOutput` is the union of `SyncHookJSONOutput` (resolves immediately) and `AsyncHookJSONOutput` (returns a token; another process completes the hook). The shape you'll usually return:

```ts
{
  // Top-level — affects the conversation
  systemMessage?: string,    // Inject a system note Claude will see
  continue?: boolean,        // Halt the agent if false (Python-style)

  // hookSpecificOutput — affects this specific event
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse' | 'PostToolUse' | ...,
    permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer',  // PreToolUse
    permissionDecisionReason?: string,                         // shown to Claude on deny
    updatedInput?: Record<string, unknown>,                    // PreToolUse: rewrite tool input
    additionalContext?: string,                                // PostToolUse: extra info for Claude
    updatedToolOutput?: string,                                // PostToolUse: rewrite tool result
  },
}
```

`permissionDecision: 'defer'` means "don't gate here, let the next layer decide." `'ask'` punts to `canUseTool`.

## How MultiTable wires hooks

[`agent/manager.ts:makeHooks` (lines 1195-1439)](../../../../packages/daemon/src/agent/manager.ts) returns a `Partial<Record<HookEvent, HookCallbackMatcher[]>>`. We register every event we care about; each handler is fire-and-forget (returns `{ continue: true }`) and used purely for state-tracking side effects:

| Hook | Side effect |
|---|---|
| `PreToolUse` | Set `s.currentTool`, bump activity, emit live state snapshot |
| `PostToolUse` | Increment `toolCount`, clear `currentTool`, emit snapshot |
| `PostToolUseFailure` | Emit alert "tool failed" |
| `UserPromptSubmit` | Auto-rename session on first prompt (via labeler) |
| `Stop` | Fire-and-forget option detection from JSONL |
| `SubagentStart` / `SubagentStop` | Increment / decrement `activeSubagents` |
| `Notification` | Emit toast + chime alert |
| `SessionStart` / `SessionEnd` | Lifecycle markers |
| `TaskCreated` / `TaskCompleted` | Background task alerts |
| `PreCompact` / `PostCompact` | "Compacting…" status indicator + summary |
| `PermissionDenied` | Alert (explicit deny, not timeout) |

We **do not** use hooks to gate tool calls (no `permissionDecision: 'deny'` returns). All gating goes through `canUseTool` because it's the user-prompt path.

## Hooks vs `canUseTool` vs `disallowedTools`

Decision matrix:

| Need | Use |
|---|---|
| Block a tool unconditionally, no UI | `Options.disallowedTools` |
| Block based on input shape, no UI ("never write to .env") | `hooks.PreToolUse` returning `permissionDecision: 'deny'` |
| Block based on dynamic state ("only weekdays"), no UI | `hooks.PreToolUse` |
| Show the user a prompt before each call | `canUseTool` |
| Log every tool call | `hooks.PostToolUse` (no decision) |
| Inject context after a tool result | `hooks.PostToolUse` returning `additionalContext` |

A hook that returns `permissionDecision: 'deny'` wins over `bypassPermissions`. This is the only safe way to enforce hard guardrails when running headless with bypass.

## Adding a new hook

Pattern from MultiTable:

```ts
// In agent/manager.ts, inside makeHooks()
PreCompact: [
  {
    hooks: [
      async (_input, _toolUseId, _ctx) => {
        const s = this.sessions.get(sessionId);
        if (!s) return { continue: true };
        s.compacting = true;
        this.emit('status', { sessionId, kind: 'compact', state: 'started' });
        return { continue: true };
      },
    ],
  },
],
```

Three things to remember:

1. **Return `{ continue: true }`** unless you really want to halt the agent. Halting from a hook is heavy-handed.
2. **Read `s = this.sessions.get(sessionId)` defensively** — `clearForSession` can run in race conditions; bail out if missing.
3. **Don't await UI input from a hook.** Hooks have a default 60s timeout (configurable per matcher). If you need to ask the user, route through `canUseTool` or `onElicitation`.

## Common mistakes

- **Treating `Stop` as "turn ended."** It fires when the agent stops thinking but tool processing may still be in flight. Use the iterator return / `result` message for true turn end.
- **Returning a giant `additionalContext` from `PostToolUse`.** Inflates context window. Keep it tight.
- **Mutating `input` in place inside a `PreToolUse` hook.** Return `updatedInput` instead — the SDK reads that field, not your mutations.
