# Permission modes

Anthropic doc: https://docs.claude.com/en/api/agent-sdk/permissions

From [`sdk.d.ts:1757`](../../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts):

```ts
export declare type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';
```

## What each mode does

| Mode | Tools auto-allowed | `canUseTool` invoked? | Use when |
|---|---|---|---|
| `default` | None | Yes, for anything not in `allowedTools` | Interactive UI; user approves each unfamiliar tool. **MultiTable's current default.** |
| `acceptEdits` | `Edit`, `Write`, `MultiEdit`, filesystem ops (`mkdir`, `rm`, `mv`, etc.) | Yes for non-edit tools | Trusted edit flows where you don't want to approve every line change. |
| `plan` | Read-only tools only (`Read`, `Glob`, `Grep`, `LS`, `WebSearch`, etc.) | Anything that would mutate is **denied**, doesn't reach `canUseTool` | "Think but don't act." Agent produces a plan; user approves before executing. |
| `bypassPermissions` | **All tools** | Generally not invoked | Headless / CI / heavily sandboxed environments. ⚠️ Read warnings below. |
| `dontAsk` | None — denies anything not in `allowedTools` | **Never invoked** (denies instead of asking) | Headless mode where prompting is impossible; want explicit allowlist + hard-deny otherwise. |
| `auto` (TS only) | Model-classified | Sometimes | Newer; lets the model + bridge classify low-risk requests. |

## Order of evaluation

For each tool call:

1. **`hooks.PreToolUse`** runs first. Can return `permissionDecision: 'allow'` / `'deny'` / `'ask'` / `'defer'` and short-circuit. See [`hooks.md`](hooks.md).
2. **`disallowedTools`** — if matched, hard-deny. Wins over modes.
3. **`permissionMode`** — applied. May resolve as allow/deny without further work.
4. **`allowedTools`** — if matched and not denied above, auto-allow.
5. **`canUseTool`** — invoked only if not resolved above.

Two practical implications:

- `disallowedTools` is the only way to block specific tools under `bypassPermissions`. `allowedTools` does **not** constrain bypassPermissions; unlisted tools fall through to the mode and get approved anyway.
- A `PreToolUse` hook returning `'deny'` always wins, even over `bypassPermissions`.

## Plan mode specifics

Plan mode is the right answer for "let the user review what the agent is about to do before it does it." Read-only tools execute; mutating tools are denied with an explanation Claude can read. Then:

- The user reviews the resulting plan.
- The user flips the mode to `default` or `acceptEdits` and triggers another turn ("now do it").

To toggle plan mode in MultiTable, you have two options:

**Per-turn (today's pattern):** wrap the `permissionMode` in `Options` based on a session field. Modify [`agent/manager.ts:285`](../../../../packages/daemon/src/agent/manager.ts) to read `s.permissionMode` instead of hardcoded `'default'`. Each new `sendTurn` picks up the current mode.

**Mid-stream (streaming-input mode only):** if you switch the prompt to `AsyncIterable<SDKUserMessage>`, you can call `Query.setPermissionMode('plan')` on the in-flight `query()` (see [`sdk.d.ts:1977`](../../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts)). Today our prompt is a string, so this method isn't reachable — switching to streaming input is a non-trivial refactor of `sendTurn`.

For "auto mode" semantics — i.e., "let the agent run with minimal interruption" — `acceptEdits` is closer to what most products call auto-mode. `bypassPermissions` is the truly hands-off variant; reach for it only when a hook layer or sandbox guarantees safety.

## `bypassPermissions` warnings

Worth tattooing somewhere:

1. **`allowedTools` does NOT constrain it.** If you write `allowedTools: ['Read']` and `permissionMode: 'bypassPermissions'`, `Bash` and `Write` are still approved.
2. **Hooks still run.** A `PreToolUse` hook that denies `Bash` will still block the call, regardless of mode. Use this for hard guardrails when running in bypass.
3. **`canUseTool` is generally NOT invoked.** Don't rely on it for safety.

## Switching modes mid-turn

`Query.setPermissionMode(mode)` exists but is only available in streaming-input mode. From `sdk.d.ts:1972-1977`:

```ts
/**
 * Change the permission mode for the current session.
 * Only available in streaming input mode.
 */
setPermissionMode(mode: PermissionMode): Promise<void>;
```

In single-message mode (our current setup), each `query()` call has a fixed mode for its duration. Different turn = new `query()` = new mode pass-through.

## Per-tool dynamic decisions

If you need to deny a tool *only when* its input matches some pattern (e.g., block `Write` to `.env*`), that's not a mode — that's either a hook or a `canUseTool` branch. See [`hooks.md`](hooks.md) and [`canusetool-and-elicitation.md`](canusetool-and-elicitation.md).
