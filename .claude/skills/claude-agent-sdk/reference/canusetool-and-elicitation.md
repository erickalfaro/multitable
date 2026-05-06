# `canUseTool`, `AskUserQuestion`, and `onElicitation`

Anthropic doc: https://docs.claude.com/en/api/agent-sdk/permissions

This is the chapter on intercepting **any** prompt the agent surfaces — interactive permission requests, structured questions, MCP elicitations.

## The three interception channels

| Channel | What it intercepts | Where in MultiTable |
|---|---|---|
| `Options.canUseTool` | Every tool call not auto-allowed by mode/allowedTools/hooks. **Includes `AskUserQuestion`.** | [`hooks/permissionManager.ts:requestFromSdk`](../../../../packages/daemon/src/hooks/permissionManager.ts) |
| `Options.onElicitation` | MCP `elicitation/create` requests (form-style or URL-redirect prompts from MCP servers) | [`hooks/elicitationManager.ts:requestFromSdk`](../../../../packages/daemon/src/hooks/elicitationManager.ts) |
| `Options.hooks.{PermissionRequest, Notification}` | Lifecycle observation; can short-circuit some flows | [`agent/manager.ts:makeHooks`](../../../../packages/daemon/src/agent/manager.ts) |

These are independent. A tool call goes through `canUseTool`; an MCP elicitation goes through `onElicitation`; a `Notification` (e.g., "Claude needs your attention") goes through hooks. Different things. Wire them all when the daemon needs full UI control.

## `canUseTool` — the contract

From [`sdk.d.ts:146`](../../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts):

```ts
export declare type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;       // e.g. when Bash tries to access path outside allowed dirs
    decisionReason?: string;    // why was this prompt triggered
    title?: string;             // bridge-rendered prompt sentence — preferred over reconstructing
    displayName?: string;       // short noun phrase for buttons ("Read file")
    description?: string;       // human subtitle
    toolUseID: string;          // unique per tool call
    agentID?: string;           // set if running inside a subagent
  }
) => Promise<PermissionResult>;
```

`PermissionResult` ([`sdk.d.ts:1779`](../../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts)):

```ts
type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    }
  | {
      behavior: 'deny';
      message: string;     // REQUIRED — this string is read by Claude as the tool result
      interrupt?: boolean;
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    };
```

Critical detail: on `deny`, the `message` field is fed back to Claude as the tool's result. Use this to communicate **why** so the model can adapt — "User denied: don't try to write to /etc/passwd" — or, in our case, to smuggle structured data back (see AskUserQuestion below).

## How MultiTable wires `canUseTool`

[`agent/manager.ts:makeCanUseTool`](../../../../packages/daemon/src/agent/manager.ts) returns a closure that delegates to:

```ts
this.permManager.requestFromSdk(
  sessionId, claudeSessionId, toolName, toolInput, signal, extras
);
```

`PermissionManager.requestFromSdk` ([`hooks/permissionManager.ts:468-559`](../../../../packages/daemon/src/hooks/permissionManager.ts)) does the heavy lifting:

1. **Auto-defer check** ([`permissionManager.ts:500-502`](../../../../packages/daemon/src/hooks/permissionManager.ts)): if the tool is read-only (`Read`, `Grep`, `Glob`, `LS`, `TodoRead`, `TodoGet`, `WebSearch`) AND any path in the input is inside `cwd` AND the tool is **not** `AskUserQuestion`, allow immediately without UI.
2. **Session allow-list check** ([`permissionManager.ts:505-507`](../../../../packages/daemon/src/hooks/permissionManager.ts)): if the user previously hit "always allow" for this tool in this session, allow.
3. **Dedup** ([`permissionManager.ts:509-516`](../../../../packages/daemon/src/hooks/permissionManager.ts)): build a key from `sessionId|toolName|JSON(input)` and coalesce identical pending prompts.
4. **Build the prompt** with `kind: 'permission'` (default) or `kind: 'ask-question'` (for `AskUserQuestion`). See special handling below.
5. **Emit `permission:prompt`** to the UI.
6. **Return a Promise** that resolves when the UI calls `respond()` / `respondAskQuestion()`, or auto-allows on 110s timeout, or denies on abort.

## `AskUserQuestion` — the special case

`AskUserQuestion` is a built-in tool the agent invokes when it needs structured user input. The model passes:

```ts
{
  questions: [
    {
      question: "How should I format the output?",
      header: "Format",                // ≤12 char chip label
      options: [
        { label: "Summary",  description: "Brief overview" },
        { label: "Detailed", description: "Full breakdown" }
      ],
      multiSelect: false
    },
    // ... up to 4 questions
  ]
}
```

The right pattern for handling this from the daemon side:

1. **Don't auto-defer.** [`permissionManager.ts:500`](../../../../packages/daemon/src/hooks/permissionManager.ts) explicitly excludes `AskUserQuestion` from the read-only auto-defer set.
2. **Don't auto-allow on timeout** the same way as a tool. (Currently we do auto-allow on timeout for any prompt — see pitfalls.md for why this is OK in practice but worth thinking about.)
3. **Surface it as a structured prompt.** [`permissionManager.ts:313-319`](../../../../packages/daemon/src/hooks/permissionManager.ts) builds a `PermissionPrompt` with `kind: 'ask-question'` and a parsed `questions` array.
4. **When the user responds, encode their answers into the deny message.** [`permissionManager.ts:372-408`](../../../../packages/daemon/src/hooks/permissionManager.ts) (`respondAskQuestion`) serializes:

   ```ts
   const askPayload = {
     questions: questions.map((q, i) => ({
       question: q.question,
       header: q.header,
       answer: answers[i] || [],
     })),
   };
   resolveAllSdk(entry, { kind: 'deny', message: JSON.stringify(askPayload) });
   ```

   The SDK feeds this `message` back to Claude as the tool result. Claude reads the JSON and proceeds with the answers. This mirrors the CLI's `buildAskQuestionResponse` semantics — **deny + reason = answer**.

This is the answer to "how do we intercept ANY prompt." Every interactive prompt the agent invokes flows through `canUseTool`. The pattern is always:

- Detect the tool name (or any other signal in `extras`).
- Route to a specialized prompt UI on the WS layer.
- Translate the user's response back into a `PermissionResult`.

## `onElicitation` — the contract

This is a **separate** channel from `canUseTool`, used when an MCP server requests user input via `elicitation/create`. It's how MCP servers ask form-shaped questions or redirect the user to a URL for OAuth-style flows.

From the SDK: `Options.onElicitation: (request, signal) => Promise<ElicitResult>` where:

```ts
type ElicitResult = {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, string | number | boolean | string[]>;
};
```

`request` carries:
- `serverName` — which MCP server is asking
- `message` — human-readable prompt
- `mode` — `'form' | 'url'`
- `requestedSchema` — JSON schema for the expected `content`
- `title`, `displayName`, `description` — UI hints
- `url` — for `mode: 'url'` redirects
- `elicitationId` — server-assigned correlation id

## How MultiTable wires `onElicitation`

[`agent/manager.ts:makeOnElicitation`](../../../../packages/daemon/src/agent/manager.ts) returns a closure that calls [`elicitationManager.ts:requestFromSdk`](../../../../packages/daemon/src/hooks/elicitationManager.ts):

```ts
requestFromSdk(sessionId, request, signal): Promise<ElicitResolution> {
  const id = uuidv4();
  const prompt: ElicitationPrompt = { /* ... */ };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      this.pending.delete(id);
      this.emit('elicitation:expired', id);
      resolve({ action: 'decline' });   // Auto-decline on 110s timeout
    }, TIMEOUT_MS);

    signal.addEventListener('abort', () => resolve({ action: 'cancel' }));

    this.pending.set(id, { prompt, resolve, timer, abortCleanup });
    this.emit('elicitation:prompt', prompt);
  });
}
```

Same pattern as `PermissionManager` — emit a prompt, hold the Promise, resolve on UI response or timeout. The differences from `canUseTool`:

- **No dedup** — each elicitation is independent.
- **Resolution is `{ action, content }`** instead of allow/deny.
- **Different WS event name** (`session:elicitation:*` vs `session:permission:*`).

## Adding a new prompt type

If you find a new SDK callback or tool that needs UI gating:

1. **Is it a tool the agent calls?** → Add a branch in `canUseTool`. Build a new `PermissionPrompt` `kind` and a matching `respond*` method on `PermissionManager`.
2. **Is it an SDK-level callback (like `onElicitation`)?** → Make a new manager modeled after `ElicitationManager`. Wire it in `makeXyz` on `AgentSessionManager`. Add WS event names.
3. **Is it a lifecycle event?** → Add a hook in `makeHooks`. Don't try to gate user input from a hook — hooks shouldn't block on UI.

## Common mistakes

- **Wiring `AskUserQuestion` like a regular tool.** It looks like a tool — same `canUseTool` channel — but the user response has to come back as JSON in the deny `message`. If you allow it and just pass `updatedInput` back, the model sees "user approved your call to AskUserQuestion" without the answers, and may re-ask or get confused.
- **Auto-deferring `AskUserQuestion`.** Defeats the entire point. The auto-defer check at [`permissionManager.ts:500`](../../../../packages/daemon/src/hooks/permissionManager.ts) explicitly excludes it; if you ever generalize that check, keep the carve-out.
- **Sending `behavior: 'allow'` for an `AskUserQuestion`.** Equivalent to "the user pressed approve without answering." Use the deny+JSON payload pattern.
- **Forgetting to honor `signal`.** Both `canUseTool` and `onElicitation` get an `AbortSignal`. When the turn aborts (user clicks Stop), the signal fires; we should remove the pending prompt and resolve the Promise with deny/cancel. We do this — see [`permissionManager.ts:568-589`](../../../../packages/daemon/src/hooks/permissionManager.ts) and [`elicitationManager.ts:77-86`](../../../../packages/daemon/src/hooks/elicitationManager.ts).
