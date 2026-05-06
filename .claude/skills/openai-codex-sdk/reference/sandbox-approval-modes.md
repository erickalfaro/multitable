# Sandbox, approval, and "modes"

This SDK has no host-side approval callback. All gating happens at spawn time via flags. Read this carefully if a feature requires "block this command" or "ask the user before running".

## `SandboxMode`

```ts
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
```

| Mode | Effect |
|---|---|
| `read-only` | Codex can read files but cannot write or run shell commands that mutate state. |
| `workspace-write` | Default for MultiTable. Codex can edit files inside `workingDirectory` (and `additionalDirectories`) and run commands. |
| `danger-full-access` | Codex can do anything, including network and FS outside the workspace. Don't use without an explicit user toggle. |

Sub-options live under `[sandbox_workspace_write]` in the codex config (config-reference docs):

- `network_access: boolean` — exposed as `ThreadOptions.networkAccessEnabled`. Defaults to `false` in workspace-write mode.
- `writable_roots: string[]` — augmented by `ThreadOptions.additionalDirectories` (which emits `--add-dir <path>` per entry).
- `exclude_slash_tmp: boolean`
- `exclude_tmpdir_env_var: boolean`

The latter two are not exposed via `ThreadOptions` and must go through `CodexOptions.config` (which the SDK flattens to `--config sandbox_workspace_write.exclude_slash_tmp=...`).

## `ApprovalMode`

```ts
type ApprovalMode = "never" | "on-request" | "on-failure" | "untrusted";
```

The SDK type accepts all four values. **Only `'never'` actually works from the SDK.** Why:

The SDK closes the spawned codex binary's stdin **immediately** after writing the prompt:

```js
child.stdin.write(args.input);
child.stdin.end();          // dist/index.js — no recovery
```

Approval modes other than `'never'` cause the codex binary to **prompt and block on stdin** when it wants to do something gated. Stdin is closed, so the binary either:

- Hangs forever waiting for an answer that can't come.
- Errors out with "approval requested but stdin is closed".
- Auto-denies the operation, which the agent surfaces as a tool failure.

Behavior is mode-dependent and not deterministic across codex versions. **Just use `'never'`.**

`approvalPolicy: 'never'` is hardcoded in [`packages/daemon/src/agent/providers/codex.ts:266`](../../../../packages/daemon/src/agent/providers/codex.ts#L266). Do not parameterize it.

### "Granular" approval (advanced, config-only)

The codex CLI accepts a richer object form:

```toml
approval_policy = { granular = {
  sandbox_approval = true,
  rules = true,
  mcp_elicitations = true,
  request_permissions = false,
  skill_approval = false,
} }
```

You'd express this from the SDK as:

```ts
new Codex({
  config: {
    approval_policy: { granular: {
      sandbox_approval: true, rules: true, mcp_elicitations: true,
      request_permissions: false, skill_approval: false,
    }},
  },
});
```

But because stdin is still closed, this configures *what* would prompt — none of which can actually run interactively from the SDK. It's only useful if the granular flags can be answered non-interactively (e.g. via `--config rules`).

## "Plan", "Auto", and "Chat" modes — what's real

The Codex developer portal mentions **plan / auto / read-only / full-access** in the context of the **TUI**. None of those names map to first-class SDK options. Here's what's real:

### Plan mode

- TUI feature. Toggled with `Shift+Tab` or `/plan` in the Codex TUI.
- The SDK has **no `--plan` flag** and no `planMode` option.
- The closest config knob: `plan_mode_reasoning_effort` (one of `none | minimal | low | medium | high | xhigh`) — only takes effect when the user toggles plan mode in the TUI. It does nothing on the SDK path because the SDK never enters plan mode.

**To approximate plan mode from the SDK** in MultiTable:

```ts
// Phase 1 — gather context, propose a plan, do not edit:
const plan = codex.startThread({
  workingDirectory: cwd,
  sandboxMode: 'read-only',
  approvalPolicy: 'never',
  modelReasoningEffort: 'high',
});
await plan.runStreamed("Make a plan to fix the failing tests. Do not edit anything.");

// Phase 2 — execute the plan in the same thread with workspace-write:
const exec = codex.resumeThread(plan.id!, {
  workingDirectory: cwd,
  sandboxMode: 'workspace-write',
  approvalPolicy: 'never',
});
await exec.runStreamed("Implement the plan now.");
```

A user-visible "Approve plan? [y/n]" gate is implemented entirely host-side: between phase 1 and phase 2, the daemon waits for a UI confirmation, then resumes.

### Auto mode

"Auto (default)" in the developer portal is just the **default approval+sandbox combination** the TUI ships with (`sandbox_mode = workspace-write`, `approval_policy = on-request`). There is no `--auto` flag and no `autoMode` SDK option. From the SDK, "auto" is whatever flags you set; we approximate it with `sandboxMode: 'workspace-write'` + `approvalPolicy: 'never'`.

### Chat mode

"Chat" refers to the interactive TUI (`codex` with no subcommand). The SDK invokes `codex exec --experimental-json` — the **non-interactive batch** path. There is no chat-mode toggle for the SDK; every `runStreamed`/`run` is one batch invocation that streams its events back.

## Tool gating cheat sheet

Map a "block this category of tool call" requirement to the right knob:

| Requirement | Lever | Where to set |
|---|---|---|
| Block all writes | `sandboxMode: 'read-only'` | `ThreadOptions` |
| Block network in workspace-write | `networkAccessEnabled: false` | `ThreadOptions` |
| Block writes outside cwd | omit the path from `additionalDirectories` | `ThreadOptions` |
| Block specific MCP tool | `disabled_tools: ['<tool>']` | `CodexOptions.config.mcp_servers.<server>` |
| Allow only specific MCP tools | `enabled_tools: ['<tool>']` (applied first) | `CodexOptions.config.mcp_servers.<server>` |
| Block web search | `webSearchMode: 'disabled'` | `ThreadOptions` |
| Stop a running command | `ctrl.abort()` from outside the for-await loop | host code |

## What's *not* a lever

- ❌ `canUseTool(toolName, toolInput)` — does not exist.
- ❌ `onElicitation(request)` — does not exist.
- ❌ `hooks.PreToolUse` / `PostToolUse` / `Notification` — do not exist.
- ❌ `permissionMode: 'plan'` — does not exist.
- ❌ Any TUI command (`/model`, `/plan`, `/compact`) intercepted by the SDK — the SDK's `codex exec` ignores TUI commands; they'd land as plain prompt text.

If a feature spec mentions any of these for a Codex session, the spec is wrong. Either rewrite the requirement against the levers in the table above, or push back.
