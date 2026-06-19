# Cursor modes & tool gating

Cursor gates tools by **mode + a config allowlist**, all OS/CLI-enforced. In
headless `--print` mode there is **no interactive per-call approval** — the CLI
cannot prompt without a TTY. So MultiTable mirrors Codex: mode selects the gate,
no `PermissionManager` routing.

## MultiTable modes → CLI flags (`cursor-cli/args.ts`)

| MultiTable `mode` | CLI flag | Behavior |
| --- | --- | --- |
| `force` | `--force` | Run everything — all tools (edit, shell) run without prompting. **Default for new sessions.** |
| `default` | *(none)* | Cursor's default permission mode; non-allowlisted shell/edits are auto-`rejected` (honors `~/.cursor/cli-config.json` `permissions.allow`). |
| `plan` | `--mode plan` | Read-only planning: analyze + propose, no edits. |
| `ask` | `--mode ask` | Read-only Q&A for explanations. |

Always also pass `--print --output-format stream-json --stream-partial-output`
and `--trust` (headless workspace trust). `--resume <id>` when continuing.

`capabilities.planMode = 'native'` (real `--mode plan`). `perCallApproval =
'sandbox'` (mode/allowlist-gated, not callback). `modelSwitchScope = 'per-turn'`
(each turn is a fresh spawn, so `--model` can change between turns).

## Why `force` is the default

In `default` mode the allowlist (`~/.cursor/cli-config.json` → `permissions.allow`,
e.g. `["Shell(ls)"]`) is typically near-empty, so most shell/edit calls return
`result.rejected` and the agent appears to "silently fail". `--force` makes a new
session usable out of the box. Decision recorded with the user; all modes remain
switchable in the UI. See `db/store.ts` `initialMode` for cursor → `'force'`.

## Sandbox (not wired in v1)

`--sandbox enabled|disabled` toggles Cursor's OS sandbox (`cliSandboxDefaultEnabled`
in server config). v1 leaves it at Cursor's default → `capabilities.hardSandbox =
false`. If wired later, add a flag in `args.ts` and flip the capability.
