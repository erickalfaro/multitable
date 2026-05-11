# Modes (plan / chat / auto) and the permission model

## TL;DR

**The Copilot SDK has no native `mode: 'plan' | 'chat' | 'auto'` field on `SessionConfig`.** The TUI's "Plan Mode" (Shift-Tab) and "Autopilot" are CLI-side runtime behaviors, not SDK-exposed enums. To get plan/chat/auto semantics in MultiTable, **compose them** out of three primitives:

1. **`hooks.onPreToolUse`** — per-call pre-flight returning `'allow' | 'deny' | 'ask'`.
2. **`onPermissionRequest`** — coarse permission gate (catches `'ask'` from `onPreToolUse`, plus everything not gated by it).
3. **`SessionConfig.tools` and `mcpServers`** — what tools the agent has at all.

There IS some runtime mode wiring exposed via events — `session.mode_changed { from, to }`, `exit_plan_mode.requested/completed`, `auto_mode_switch.requested/completed` — but driving these *from* the SDK (vs. observing them) is undocumented as of this writing. Don't grep upstream for `--plan` flag in the Node SDK source; it isn't there.

## Recipes for plan / chat / auto

These are the recommended approximations for MultiTable's UI mode toggle. All three are config you set at `createSession` time; switching modes mid-session means recreating the session (which is cheap because `start()` already happened on the client).

### Plan mode (read-only thinking before execution)

The agent reasons and proposes a plan but does not modify the workspace.

```ts
const planSession = await client.createSession({
  sessionId,
  model: 'gpt-5',
  systemMessage: {
    mode: 'append',
    content:
      'You are in PLAN MODE. Do not modify any files, run any shell commands, ' +
      'or make any network requests. Use only read-only tools to analyze the ' +
      'workspace and produce a step-by-step plan in plain markdown. ' +
      'Wait for the user to approve before taking any actions.',
  },
  onPermissionRequest: approveAll,   // permission prompts won't fire because we deny earlier
  onUserInputRequest: askUser,
  onElicitationRequest: handleElicitation,
  hooks: {
    onPreToolUse: async ({ toolName }) => {
      const READ_ONLY = new Set(['view', 'grep', 'glob', 'read_file', 'list_dir']);
      if (READ_ONLY.has(toolName)) return { permissionDecision: 'allow' };
      return {
        permissionDecision: 'deny',
        permissionDecisionReason: 'Plan mode: tool execution blocked. Propose this in your plan instead.',
      };
    },
  },
});
```

To execute the plan, **destroy the plan session** (`await planSession.disconnect()`) and create a new session with auto/chat mode using the same `sessionId` so the conversation history continues.

### Chat mode (conversational, no tools)

No tools at all — the model can only talk.

```ts
const chatSession = await client.createSession({
  sessionId,
  model: 'gpt-5',
  tools: [],                         // no custom tools
  mcpServers: {},                    // no MCP servers
  onPermissionRequest: approveAll,   // never fires; nothing to gate
  onUserInputRequest: askUser,
  onElicitationRequest: handleElicitation,
  hooks: {
    onPreToolUse: async () => ({
      permissionDecision: 'deny',
      permissionDecisionReason: 'Chat mode: no tool execution.',
    }),
  },
  systemMessage: {
    mode: 'append',
    content: 'You are in CHAT MODE. Answer questions but do not call any tools.',
  },
});
```

### Auto mode (full autonomy, no per-call prompts)

```ts
const autoSession = await client.createSession({
  sessionId,
  model: 'gpt-5',
  onPermissionRequest: approveAll,
  onUserInputRequest: askUser,
  onElicitationRequest: handleElicitation,
  // hooks.onPreToolUse omitted → every tool runs without per-call gating.
  // Agent still has to surface user input / elicitation requests when it wants
  // to actually ASK the user something — those don't auto-resolve.
});
```

Note that "auto" still requires `onUserInputRequest` and `onElicitationRequest` handlers — the agent will hang if it ever wants to ask the user something and you've not wired those. `approveAll` only covers `onPermissionRequest`.

### "Ask every time" mode (default for prod / first-time users)

```ts
const askSession = await client.createSession({
  sessionId,
  model: 'gpt-5',
  onPermissionRequest: routeToUiPrompt,    // every kind asks the user
  onUserInputRequest: askUser,
  onElicitationRequest: handleElicitation,
  hooks: {
    onPreToolUse: async ({ toolName }) => ({ permissionDecision: 'ask' }),
    // Falls through to onPermissionRequest for every tool.
  },
});
```

In MultiTable, `routeToUiPrompt` is the existing `PermissionManager.requestFromSdk(...)` — the same surface the Claude SDK uses. The `kind` (instead of `toolName`) is what's distinct here; map it to a friendly label in the UI.

## The permission model in detail

There are TWO independent gates per tool call. They run in this order:

```
agent decides to call tool X with args Y
       │
       ▼
hooks.onPreToolUse({ toolName: X, toolArgs: Y })  ← per-call, async, optional
       │
       ├── { permissionDecision: 'allow' }  → run tool (skip onPermissionRequest)
       ├── { permissionDecision: 'deny' }   → block, agent gets reason in tool result
       └── { permissionDecision: 'ask' }    → fall through ↓
                                                │
                                                ▼
                                  onPermissionRequest({ kind, toolCallId? })  ← coarse, async, MANDATORY
                                                │
                                                ├── { kind: 'approved' }              → run tool
                                                └── { kind: 'denied-...' }            → block
```

Per-tool override: `defineTool({ ..., skipPermission: true })` skips **both** gates. Use sparingly.

`PermissionRequest.kind` enum:
- `'shell'` — running a shell command (bash, system invocation)
- `'write'` — modifying a file in the workspace
- `'read'` — reading a file outside an allowlist
- `'mcp'` — invoking an MCP server tool
- `'url'` — fetching a URL (web access)
- `'custom-tool'` — invoking a host-registered tool (`defineTool`)
- `'memory'` — touching the agent's persistent memory
- `'hook'` — running a user-configured hook

Note that `onPermissionRequest` does NOT carry `toolName` directly — it carries the **kind** plus optional `toolCallId`. To do per-tool decisions, gate in `onPreToolUse` instead.

`PermissionRequestResult` enum:
- `'approved'` — run the tool
- `'denied-interactively-by-user'` — user said no
- `'denied-no-approval-rule-and-could-not-request-from-user'` — auto-deny because no path to ask
- `'denied-by-rules'` — denied by an allowlist/policy rule
- `'denied-by-content-exclusion-policy'` — denied by GitHub's content exclusion
- `'no-result'` — fall through with no decision

## Mode toggling at runtime — what we know and don't

The SDK emits these events:
- `session.mode_changed { from, to }` — observe it; how to *trigger* it from the SDK is undocumented.
- `exit_plan_mode.requested` / `exit_plan_mode.completed` — exists; suggests there IS a "plan mode" notion at the CLI level.
- `auto_mode_switch.requested` / `auto_mode_switch.completed` — fires on rate-limit fallbacks (model switching).

Two paths to investigate when adding live mode toggling (do this when we actually wire Copilot, not in advance):

1. **Check `client.rpc`** — the `vscode-jsonrpc` `MessageConnection` is exposed. The generated `nodejs/src/generated/rpc.ts` likely has `ModeSetRequest` or similar. Send the raw RPC.
2. **Check `session.ui.elicitation`** — could push a structured "switch mode" UI request into the agent.

For now, **the safe pattern is: rebuild the session with the appropriate mode-recipe config.** It's cheap (the CLI client is shared; only `createSession` is a fresh RPC call).

## Comparison with the other two SDKs

| Concept | Claude Agent SDK | Codex SDK | Copilot SDK |
|---|---|---|---|
| Plan mode | `Options.permissionMode: 'plan'` (first-class) | None — approximate via `sandboxMode: 'read-only'` | None — approximate via `onPreToolUse: 'deny' for writes` + system prompt |
| Acceptedits / yolo | `permissionMode: 'acceptEdits' \| 'bypassPermissions'` | Hardcoded `approvalPolicy: 'never'` | `onPermissionRequest: approveAll` + omit `onPreToolUse` |
| Per-call host approval | `canUseTool(toolName, input)` | NONE | `hooks.onPreToolUse({ toolName, toolArgs })` (richer than Claude's `canUseTool`) |
| Coarse permission gate | None (per-call only) | `sandboxMode` flags | `onPermissionRequest` (per-kind) |
| Sandbox modes | None | `'read-only' \| 'workspace-write' \| 'danger-full-access'` | None — use permissions instead |
| Network gate | Via hooks | `networkAccessEnabled: false` | `onPreToolUse: 'deny'` for `kind: 'url'` (in `onPermissionRequest`) |

Copilot's permission model is **richer than both Claude and Codex** because it has both a per-call hook (`onPreToolUse` — like Claude's `canUseTool` but with more affordances) AND a coarse kind-based gate (`onPermissionRequest` — kinda like Codex's sandbox but per-prompt). Use both layers; they compose well.
