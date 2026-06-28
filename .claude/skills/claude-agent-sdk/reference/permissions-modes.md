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

Two paths apply mode changes in MultiTable, and they cooperate:

**Per-turn pickup:** [`ClaudeAdapter.runTurn`](../../../../packages/daemon/src/agent/providers/claude.ts) reads `s.mode` once when assembling SDK options. A flip to `s.mode` made between turns is honored on the next `sendTurn` automatically (the field is written by [`AgentSessionManager.setMode`](../../../../packages/daemon/src/agent/manager.ts) and persisted to the DB).

**Mid-turn live apply:** we pump the prompt as `AsyncIterable<SDKUserMessage>` (via the `makePromptStream` helper in `claude.ts`) and capture the returned `Query` handle in `liveQueries`. `ClaudeAdapter.applyModeChangeLive(s, mode)` calls `query.setPermissionMode(mode)` against the live handle, and `setMode` in the manager fires it as a fire-and-forget side effect whenever `s.state === 'running'`. The session field is still updated synchronously, so the next turn is also covered even if the live call rejects.

`Query.setModel(...)` is also exposed on the same handle (see [`sdk.d.ts:2266`](../../../../packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts#L2266)) — there's no manager-side `setModel` wiring today, but adding it follows the same shape as `applyModeChangeLive`.

For "auto mode" semantics — i.e., "let the agent run with minimal interruption" — `acceptEdits` is closer to what most products call auto-mode. `bypassPermissions` is the truly hands-off variant; reach for it only when a hook layer or sandbox guarantees safety.

## `bypassPermissions` warnings

Worth tattooing somewhere:

1. **`allowedTools` does NOT constrain it.** If you write `allowedTools: ['Read']` and `permissionMode: 'bypassPermissions'`, `Bash` and `Write` are still approved.
2. **Hooks still run.** A `PreToolUse` hook that denies `Bash` will still block the call, regardless of mode. Use this for hard guardrails when running in bypass.
3. **`canUseTool` is generally NOT invoked.** Don't rely on it for safety.

## Switching modes mid-turn

`Query.setPermissionMode(mode)` is only available in streaming-input mode. From `sdk.d.ts:2255-2259`:

```ts
/**
 * Change the permission mode for the current session.
 * Only available in streaming input mode.
 */
setPermissionMode(mode: PermissionMode): Promise<void>;
```

MultiTable runs the Claude adapter in streaming-input mode for exactly this reason — the prompt is pumped as `AsyncIterable<SDKUserMessage>` (single yield, then awaits a done-signal) and the returned `Query` handle is stashed in `ClaudeAdapter.liveQueries`. `applyModeChangeLive` calls `setPermissionMode` on the live handle; the manager fires it whenever the user flips the mode badge while `s.state === 'running'`. The per-turn pickup path remains as the fallback, so the next turn is also covered if the live call rejects (and so adapters that don't implement `applyModeChangeLive` — Codex, Hermes — still update on the next turn).

## Per-tool dynamic decisions

If you need to deny a tool *only when* its input matches some pattern (e.g., block `Write` to `.env*`), that's not a mode — that's either a hook or a `canUseTool` branch. See [`hooks.md`](hooks.md) and [`canusetool-and-elicitation.md`](canusetool-and-elicitation.md).
