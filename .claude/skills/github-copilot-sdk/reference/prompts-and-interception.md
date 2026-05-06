# Prompts and interception — the three "ask" channels

This is the chapter to read when intercepting `AskUserQuestion`-equivalents, gating tools, or wiring MultiTable's `PermissionManager` / `ElicitationManager` to the Copilot adapter. The Copilot SDK has **three orthogonal callback channels** for agent → host requests, plus a separate **host → agent** UI surface that is easy to confuse with them.

## The three agent → host channels

Each is a function on `SessionConfig`. The agent **blocks** on each request until your handler resolves. There is **no host-side timeout**. Forgetting to wire any of the three causes the agent to hang the first time it tries to use it.

| Channel | Field | Mandatory? | Purpose |
|---|---|---|---|
| Permissions | `onPermissionRequest: PermissionHandler` | **Yes — crashes if missing** | Coarse-grained gate on side effects (kinds: `shell`, `write`, `read`, `mcp`, `url`, `custom-tool`, `memory`, `hook`) |
| User input | `onUserInputRequest: UserInputHandler` | No (but agent hangs) | Free-text or multiple-choice question to the user |
| Elicitation | `onElicitationRequest: ElicitationHandler` | No (but agent hangs) | Structured form or URL flow (often initiated by MCP servers) |

### 1. `onPermissionRequest` — coarse permission gate

```ts
type PermissionHandler = (req: PermissionRequest, ctx: { sessionId: string })
  => Promise<PermissionRequestResult> | PermissionRequestResult;

type PermissionRequest = {
  kind: 'shell' | 'write' | 'read' | 'mcp' | 'url' | 'custom-tool' | 'memory' | 'hook';
  toolCallId?: string;
  // Plus kind-specific fields (e.g. command for 'shell', path for 'write')
};

type PermissionRequestResult =
  | { kind: 'approved' }
  | { kind: 'denied-interactively-by-user' }
  | { kind: 'denied-no-approval-rule-and-could-not-request-from-user' }
  | { kind: 'denied-by-rules' }
  | { kind: 'denied-by-content-exclusion-policy' }
  | { kind: 'no-result' };
```

For dev / headless use, the SDK exports `approveAll`:

```ts
import { approveAll } from '@github/copilot-sdk';
const session = await client.createSession({
  onPermissionRequest: approveAll,
  // ...
});
```

For MultiTable, route this through the existing `PermissionManager` so users see the same prompt UI as Claude tool calls. The `PermissionRequest.kind` doesn't map 1:1 to a Claude `toolName`, so the `PermissionPrompt` payload needs a Copilot-flavored variant — see [`multitable/integration-plan.md`](../multitable/integration-plan.md).

### 2. `onUserInputRequest` — free-text / multiple-choice question

This is the **closest equivalent to Claude SDK's `AskUserQuestion` tool**. The agent emits one when it wants the user to answer a question (free text or pick from a list).

```ts
type UserInputHandler = (req: UserInputRequest, ctx: { sessionId: string })
  => Promise<UserInputResponse> | UserInputResponse;

type UserInputRequest = {
  question: string;
  choices?: string[];           // present → multiple choice
  allowFreeform?: boolean;      // when choices are present, also allow typing in
};

type UserInputResponse = {
  answer: string;
  wasFreeform: boolean;         // true if the user typed in instead of picking a choice
};
```

Wiring example:

```ts
const session = await client.createSession({
  onPermissionRequest: approveAll,
  onUserInputRequest: async (req, ctx) => {
    if (req.choices) {
      // pop a multi-choice picker; allow typing if allowFreeform is true
      const picked = await ui.pickList(ctx.sessionId, req.question, req.choices, req.allowFreeform);
      return { answer: picked.value, wasFreeform: picked.wasFreeform };
    }
    // otherwise free-text input
    const answer = await ui.textInput(ctx.sessionId, req.question);
    return { answer, wasFreeform: true };
  },
});
```

In MultiTable, this should re-use the existing `PermissionManager` infrastructure (it already supports `displayName`, `subtitle`, `blockedPath`, `extras` on the prompt payload). The mapping:

- `question` → prompt title
- `choices` → multiple-choice buttons
- `allowFreeform` → also show a text input
- Resolve when the user picks/types → call back with `UserInputResponse`

The matching event for observability is `user_input.requested` → `user_input.completed` (carries `answer`).

### 3. `onElicitationRequest` — structured form / URL

For MCP-initiated requests (a server wants the user to fill out a form or visit a URL).

```ts
type ElicitationHandler = (ctx: ElicitationContext) => Promise<ElicitationResult> | ElicitationResult;

type ElicitationContext = {
  sessionId: string;
  message: string;
  requestedSchema?: ElicitationSchema;   // JSON-Schema-ish
  mode: 'form' | 'url';
  elicitationSource: { kind: 'mcp', serverName: string } | { kind: 'agent' };
  url?: string;                          // present when mode === 'url'
};

type ElicitationResult =
  | { action: 'accept', content: Record<string, unknown> }
  | { action: 'decline' }
  | { action: 'cancel' };
```

In MultiTable, route through `ElicitationManager` (which already exists for the Claude SDK's `onElicitation`). The schemas are MCP-shaped — render with the same form generator we use for Claude elicitation requests.

## Don't confuse: `session.ui.*` is HOST → AGENT

`session.ui` is a property on `CopilotSession` for **pushing** UI requests *into* the agent's context. This is the OPPOSITE direction from the three handlers above.

```ts
interface SessionUiApi {
  confirm(message: string): Promise<boolean>;
  select(message: string, choices: string[]): Promise<number>;
  input(message: string): Promise<string>;
  elicitation(params: ElicitationParams): Promise<ElicitationResult>;
}

// Example: a custom tool wants to ask the user for confirmation INSIDE the tool handler
const lookupAndConfirm = defineTool('lookup_and_confirm', {
  // ...
  handler: async (args, ctx) => {
    const ok = await ctx.session.ui.confirm('Proceed with deletion?');
    if (!ok) return { content: [{ type: 'text', text: 'cancelled' }] };
    // ...
  },
});
```

The naming is confusingly symmetric. To keep them straight:

- **`session.ui.*`** — *the host*, often via a custom tool handler, pushes a UI prompt into the agent. The result is consumed by the host code that called it.
- **`onUserInputRequest` / `onElicitationRequest`** — *the agent* asks the host. The host fulfills the request via the handler and the agent consumes the result.

## Per-tool gating via `hooks.onPreToolUse`

Independent of the three "ask" channels, you can intercept every tool call before it runs:

```ts
const session = await client.createSession({
  onPermissionRequest: approveAll,
  hooks: {
    onPreToolUse: async ({ toolName, toolArgs }) => {
      if (toolName === 'bash' && /\brm\s+-rf\b/.test(toolArgs.command || '')) {
        return { permissionDecision: 'deny', permissionDecisionReason: 'rm -rf is blocked' };
      }
      if (toolName === 'write_file' && toolArgs.path?.startsWith('/etc/')) {
        return { permissionDecision: 'ask' };   // falls through to onPermissionRequest
      }
      return { permissionDecision: 'allow' };
    },
  },
});
```

`permissionDecision` values:
- `'allow'` — skip `onPermissionRequest`, run the tool.
- `'deny'` — block; the agent gets the deny reason and continues.
- `'ask'` — fall through to `onPermissionRequest` (the user sees a prompt).

You can also rewrite the call:

```ts
return {
  permissionDecision: 'allow',
  modifiedArgs: { ...toolArgs, command: sanitize(toolArgs.command) },
  additionalContext: 'Sanitized command for safety',
};
```

`onPreToolUse` is async; it can call out to a backend, prompt a UI, etc. It runs for **every** tool call (built-in, MCP, custom). Per-tool bypass via `defineTool({ skipPermission: true })` skips both `onPreToolUse` AND `onPermissionRequest`.

## Decision tree: which interception layer?

```
Block ALL writes / shell / mcp regardless of input?
  ─── onPreToolUse → { permissionDecision: 'deny' }
      (Same as Claude's `hooks.PreToolUse` with permissionDecision: 'deny'.)

Allow some, deny some, ask others based on shape?
  ─── onPreToolUse with branching logic returning 'allow' / 'deny' / 'ask'.
      For 'ask' cases the user sees a permission prompt via onPermissionRequest.

Always show the user a permission prompt for kind X?
  ─── onPreToolUse → 'ask' for that kind, then handle in onPermissionRequest.
      Or just rely on onPermissionRequest alone (skip onPreToolUse).

Agent wants to ask the user a free-text or multi-choice question?
  ─── onUserInputRequest. The agent asks; you reply.

MCP server wants the user to fill out a form?
  ─── onElicitationRequest. Mode = 'form' or 'url'.

Custom tool wants to ask the user mid-execution?
  ─── ctx.session.ui.confirm/select/input/elicitation INSIDE the tool handler.
```

## Common mistakes when wiring all this up

1. **Wiring only `onPermissionRequest`.** The first time the agent emits a `user_input.requested` or `elicitation.requested` event, the session hangs forever. Always wire all three.
2. **Confusing `session.ui.*` with `on*Request`.** Both have similar names (`session.ui.input` vs `onUserInputRequest`) but flow opposite directions. Wrong direction = either crashes the tool or silently ignores the agent.
3. **Resolving handlers synchronously when they should be async.** A handler that returns immediately with `{ kind: 'approved' }` (e.g. `approveAll`) is fine, but anything that needs UI must be `async` and Promise-returning. The agent **blocks**.
4. **Approving by default.** `approveAll` is a development convenience. In production, even read-only tool kinds should be reviewed at least once and remembered (an "always allow file reads" rule should live in MultiTable's allowlist, not in `approveAll`).
5. **Treating `onPreToolUse` as observability.** It blocks the tool call until it returns. If you `await` slow remote validation in there, you'll add the latency to every tool. Use `hooks.onPostToolUse` for observability that doesn't gate execution.
