# Lifecycle hooks

Six hooks. All optional, all `async`, all on `SessionConfig.hooks`. Each runs at a specific point in the agent loop and can return data that influences subsequent behavior.

```ts
const session = await client.createSession({
  sessionId,
  onPermissionRequest: approveAll,
  hooks: {
    onSessionStart:        async (input) => ({ /* see below */ }),
    onUserPromptSubmitted: async (input) => ({ /* */ }),
    onPreToolUse:          async (input) => ({ /* */ }),
    onPostToolUse:         async (input) => ({ /* */ }),
    onSessionEnd:          async (input) => ({ /* */ }),
    onErrorOccurred:       async (input) => ({ /* */ }),
  },
});
```

Each hook execution is also surfaced as `hook.start` / `hook.end` events on the session for observability.

## `onSessionStart`

Fires once per session creation/resume. Use it to inject project-specific context.

```ts
onSessionStart: async ({ source, initialPrompt }) => {
  // source: 'startup' | 'resume' | 'new'
  return {
    additionalContext: `Today is ${new Date().toISOString()}. Project: ${projectName}.`,
    modifiedConfig: { /* override session config (limited fields) */ },
  };
};
```

For MultiTable, this is where we inject the project name, working directory, current git branch, and active task context — analogous to how the Claude SDK adapter prepends a system message.

## `onUserPromptSubmitted`

Fires every time the user sends a message (`session.send()`). Runs **before** the agent processes it.

```ts
onUserPromptSubmitted: async ({ prompt }) => {
  return {
    modifiedPrompt: rewritePrompt(prompt),         // optional: rewrite what the agent sees
    additionalContext: 'Note: user is on mobile.', // optional: extra context for this turn
    suppressOutput: false,                         // optional: silence the user.message echo
  };
};
```

Use for prompt enrichment (RAG context injection, file mention expansion, etc.).

## `onPreToolUse`

The fine-grained per-call gate. See [`prompts-and-interception.md`](prompts-and-interception.md) — this is half the permission story.

```ts
onPreToolUse: async ({ toolName, toolArgs }) => {
  return {
    permissionDecision: 'allow' | 'deny' | 'ask',  // REQUIRED
    permissionDecisionReason: 'optional explanation for deny/ask',
    modifiedArgs: { ...toolArgs, sanitized: true }, // optional: rewrite args before tool runs
    additionalContext: 'Note for the agent post-tool',
    suppressOutput: false,
  };
};
```

**Runs synchronously in the agent loop** — slow remote validation here adds latency to every tool call. Keep it fast or push to `onPostToolUse` for non-gating observability.

## `onPostToolUse`

Fires after every tool call completes. Best place for non-gating observability (logging, metrics, audit trails).

```ts
onPostToolUse: async ({ toolName, toolArgs, toolResult }) => {
  await audit.log({ tool: toolName, args: toolArgs, result: toolResult });
  return {
    modifiedResult: toolResult,                    // optional: rewrite what the agent sees
    additionalContext: 'Note about tool result',
    suppressOutput: false,
  };
};
```

Note that you can rewrite `toolResult` here — useful for redacting secrets from output before the model sees it.

## `onSessionEnd`

Fires when the session terminates. Use for cleanup, summary persistence, sending notifications.

```ts
onSessionEnd: async ({ reason, finalMessage, error }) => {
  // reason: 'complete' | 'error' | 'abort' | 'timeout' | 'user_exit'
  await persistSummary({ sessionId, reason, finalMessage });
  return {
    suppressOutput: false,
    cleanupActions: [/* */],                       // optional cleanup descriptors
    sessionSummary: 'Optional human-readable summary string',
  };
};
```

For MultiTable: emit a `session:notification` here for the chime/toast (mirror what we do on Claude SDK `Stop` hook).

## `onErrorOccurred`

Fires on recoverable errors (model API failure, tool execution exception, system error, bad user input). Returns a retry/skip/abort decision.

```ts
onErrorOccurred: async ({ error, errorContext, recoverable }) => {
  // errorContext: 'model_call' | 'tool_execution' | 'system' | 'user_input'
  console.error(`[copilot] ${errorContext}: ${error.message}`);

  if (errorContext === 'model_call' && /rate limit/i.test(error.message)) {
    return {
      errorHandling: 'retry',
      retryCount: 3,
      userNotification: 'Hit rate limit; retrying...',
    };
  }
  return {
    errorHandling: 'abort',
    userNotification: error.message,
  };
};
```

Distinct from `session.error` events — this hook is **active** (returns a decision), the event is **passive** (notifies you but you can't change behavior). Wire both.

## What hooks are NOT

- **Not for blocking interactive UI gating.** That's `onPermissionRequest` / `onUserInputRequest` / `onElicitationRequest`. Hooks should not block on user input — they're meant to run quickly, return a decision, and continue. Long-running UI prompts inside `onPreToolUse` will stall the agent.
- **Not a polling endpoint.** Don't use `onPostToolUse` to *check* if the agent is done — use `session.idle`.
- **Not where you wire event subscriptions.** Subscribe via `session.on(...)` separately.

## Comparison with Claude SDK hooks

The Claude SDK has a richer hook surface (PreToolUse, PostToolUse, Stop, SubagentStop, Notification, PreCompact, SessionStart, UserPromptSubmit). Copilot consolidates: no Stop / SubagentStop (use `session.idle` event), no Notification (use `session.error` / `system.notification` events), no PreCompact (use `session.compaction_start` event).

| Claude SDK hook | Copilot equivalent |
|---|---|
| `PreToolUse` | `onPreToolUse` (richer return shape) |
| `PostToolUse` | `onPostToolUse` |
| `UserPromptSubmit` | `onUserPromptSubmitted` |
| `SessionStart` | `onSessionStart` |
| `SessionEnd` | `onSessionEnd` (Claude doesn't have this) |
| `Stop` | observe `session.idle` event |
| `SubagentStop` | observe `subagent.completed` event |
| `Notification` | observe `system.notification` event |
| `PreCompact` | observe `session.compaction_start` event |
| (none) | `onErrorOccurred` (Claude has no equivalent) |
