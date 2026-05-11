# Permission and elicitation wiring

How the daemon bridges synchronous-looking SDK callbacks (`canUseTool`, `onElicitation`) to asynchronous WebSocket UI input.

## The Promise bridge

The SDK's `canUseTool` and `onElicitation` are `(args) => Promise<Result>` callbacks. The SDK awaits them. While the Promise is pending, the SDK is paused — no further `SDKMessage` events emit, the agent is "thinking" from the user's perspective.

The daemon-side trick is: **don't resolve the Promise immediately**. Hold it open, emit a WS event to the UI, wait for the user, then resolve.

```
SDK calls canUseTool(args)
  ↓
PermissionManager.requestFromSdk(...)
  ↓
Build PermissionPrompt + assign uuid
  ↓
new Promise<PermissionResult>((resolve) => {
  pending.set(id, { ..., sdkResolvers: [resolve] })
  emit('permission:prompt', prompt)
})
  ↓ (await Promise)
WS broadcasts 'permission:prompt' event to subscribed clients
  ↓
UI renders the permission card
  ↓
User clicks "Allow" / "Deny" / "Always allow"
  ↓
WS sends 'permission:respond' message
  ↓
permissionManager.respond(id, decision)
  ↓
Resolves the held Promise with { kind: 'allow' | 'deny', ... }
  ↓
SDK callback returns the PermissionResult
  ↓
SDK proceeds (or denies the tool call)
```

## `PermissionManager` internals

[`hooks/permissionManager.ts`](../../../../packages/daemon/src/hooks/permissionManager.ts).

### Auto-defer set

Lines 10-18:

```ts
const AUTO_DEFER_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'TodoRead', 'TodoGet', 'WebSearch',
]);
```

Plus the path check ([`permissionManager.ts:31-40`](../../../../packages/daemon/src/hooks/permissionManager.ts)) — only defer if every path-shaped argument is inside `cwd`. This is what keeps the UI quiet for read-only actions in-tree without blanket-allowing reads outside the project.

`AskUserQuestion` is **explicitly excluded** from auto-defer ([`permissionManager.ts:500`](../../../../packages/daemon/src/hooks/permissionManager.ts)) — answering questions is the entire point of the prompt.

### Per-session always-allow

When the user clicks "Always allow this tool":
- `decision === 'always-allow'` ([`permissionManager.ts:346-352`](../../../../packages/daemon/src/hooks/permissionManager.ts))
- Adds `toolName` to `sessionAllowList.get(sessionId)`
- Subsequent prompts for the same `(sessionId, toolName)` short-circuit on the allow list ([`permissionManager.ts:505-507`](../../../../packages/daemon/src/hooks/permissionManager.ts))

This list is **per session, in-memory**. Lost on daemon restart. Different from `addRules` permission updates that the SDK supports — those persist via `Options.persistPermissions`. We don't currently use those; if we ever want sticky cross-session decisions, that's the SDK feature.

### Dedup

[`permissionManager.ts:509-516`](../../../../packages/daemon/src/hooks/permissionManager.ts):

```ts
const dedupKey = `${sessionId}|${tool_name}|${JSON.stringify(input)}`;
const existing = findByDedup(dedupKey);
if (existing) {
  existing.sdkResolvers.push(resolve);  // attach to the already-pending prompt
  return;
}
```

Two SDK callbacks for the same exact tool call (rare but possible during retries) coalesce onto one UI prompt. When the user responds, all SDK resolvers fire with the same decision.

### Timeout

110 seconds ([`permissionManager.ts:7,541-543`](../../../../packages/daemon/src/hooks/permissionManager.ts)). On expiry, **auto-allow** ([`permissionManager.ts:416-417`](../../../../packages/daemon/src/hooks/permissionManager.ts)):

```ts
sendAll(entry, (eventName) => buildAllowBody(eventName));
resolveAllSdk(entry, { kind: 'allow', updatedInput: entry.prompt.toolInput });
```

Why auto-allow instead of auto-deny? Practical bias toward "agent keeps moving when user is AFK." Pair with hard `disallowedTools` for irreversible actions.

### Abort handling

When the turn aborts (user clicks Stop), the `signal` passed into `canUseTool` fires. [`permissionManager.ts:568-589`](../../../../packages/daemon/src/hooks/permissionManager.ts) attaches an `addEventListener('abort', ...)` that:

1. Removes the SDK resolver from the pending entry.
2. Resolves with `{ kind: 'deny', message: 'Cancelled' }`.
3. If the entry has no remaining resolvers (no other SDK callback is waiting) AND no UI responders, deletes the entry entirely (cleans up the UI prompt too).

This is what makes mid-stream stop work cleanly with prompts open.

### `AskUserQuestion` special case

[`permissionManager.ts:313-319`](../../../../packages/daemon/src/hooks/permissionManager.ts) builds the prompt with `kind: 'ask-question'`:

```ts
const prompt: PermissionPrompt = {
  id, sessionId, claudeSessionId,
  toolName: tool_name,
  toolInput: input,
  ...(isAskQuestion
    ? { kind: 'ask-question' as const, questions: parseAskQuestions(input) }
    : { kind: 'permission' as const }),
};
```

UI renders a structured questionnaire. When the user submits answers:

WS message `permission:answer-question` → `permissionManager.respondAskQuestion(id, answers)` ([`permissionManager.ts:372-408`](../../../../packages/daemon/src/hooks/permissionManager.ts)):

```ts
const askPayload = {
  questions: questions.map((q, i) => ({ question, header, answer: answers[i] })),
};
resolveAllSdk(entry, { kind: 'deny', message: JSON.stringify(askPayload) });
```

The `deny.message` is what the SDK feeds Claude as the tool result. Claude reads the JSON, parses the answers, proceeds. **Deny = answer**, by SDK convention.

## `ElicitationManager` internals

[`hooks/elicitationManager.ts`](../../../../packages/daemon/src/hooks/elicitationManager.ts).

Simpler than `PermissionManager`:

- One `Pending` entry per elicitation (no dedup — each MCP elicitation is independent).
- 110s timeout → auto-decline (vs. auto-allow for permissions; declining is the safer default for form input).
- Abort signal → cancel.
- Single `resolve` per pending entry.

The contract is `{ action: 'accept' | 'decline' | 'cancel', content?: Record }`. UI builds the form from `requestedSchema` and submits via WS `elicitation:respond` → `elicitationManager.respond(id, action, content)`.

## When to add a new prompt manager

If you encounter a new SDK callback that needs UI plumbing (e.g., a future `onApprovalRequest`, `onClarification`), follow the pattern:

1. New manager class extending `EventEmitter`.
2. `requestFromSdk(...)` returns a Promise + emits `<kind>:prompt`.
3. `respond(...)` resolves the Promise + emits `<kind>:resolved`.
4. Timeout + abort handling that resolves with the safe default.
5. Add WS event names in [`server.ts`](../../../../packages/daemon/src/server.ts).
6. Construct in `index.ts`, pass to `AgentSessionManager`.
7. In `agent/manager.ts`, add `makeOnXyz(sessionId)` that delegates to `xyzManager.requestFromSdk`.

## Don't conflate the channels

Common mistake: trying to handle MCP elicitations in `PermissionManager`. The shapes are different (action vs. allow/deny, schema-driven content vs. tool input), the semantics are different (MCP server protocol vs. tool gating), and the timeouts have different defaults. Two managers, two WS event families. Keep them separate.

Same for `Notification` hooks — they don't gate anything, they're observability. Don't try to make them block on UI input from a hook callback. Hooks have a 60s default timeout and the SDK doesn't expect them to be interactive.
