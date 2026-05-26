# Modes: `code` / `plan` / `ask`

Grok Build has **three native modes**. MultiTable does **not** invent or translate modes — the value passed to the adapter is forwarded verbatim, and the adapter declares the native set in `capabilities.modes` (see [`../../../packages/daemon/src/agent/providers/types.ts`](../../../../packages/daemon/src/agent/providers/types.ts), `ModeOption`).

| Grok mode | Behavior (per xAI docs) | Switch via |
|---|---|---|
| `code` | **Default.** Reads, edits, and runs commands automatically (Grok self-gates which calls prompt — see [`../pitfalls.md`](../pitfalls.md) §6). | default; `/code` (`VERIFY`) |
| `plan` | Shows diffs before applying; **requires approval** before writing. xAI markets a real plan mode: review/edit/approve the plan before execution. | `/plan` or `--mode plan` |
| `ask` | **Read-only**, no file modifications. | `/ask` (`VERIFY`) |

## Proposed `capabilities.modes`

```ts
modes: [
  {
    value: 'code',
    label: 'Code',
    description: 'Grok reads, edits, and runs commands automatically; it prompts only for calls it deems sensitive.',
    tone: 'standard',
  },
  {
    value: 'plan',
    label: 'Plan',
    description: 'Grok proposes a plan and shows diffs before applying — changes require your approval.',
    tone: 'safe',
  },
  {
    value: 'ask',
    label: 'Ask (read-only)',
    description: 'Read-only — Grok answers and inspects but makes no file modifications.',
    tone: 'safe',
  },
],
```

Tones drive UI coloring only (`ModeTone` in `types.ts`); `code` is `standard` (amber), the two non-mutating modes are `safe`. There is no `danger`-tier mode for Grok in v1 (no equivalent of Codex's `danger-full-access` / Claude's `bypassPermissions`). **VERIFY** whether Grok has a "full access / yolo" mode worth exposing as `elevated`/`danger`.

## `planMode`: native or simulated? — the key VERIFY

`ProviderCapabilities.planMode` is `'native' | 'simulated' | 'none'`:

- If Grok exposes mode switching **over the agent-stdio ACP surface** — i.e. a `session/set_mode` RPC, a `mode`/`modeId` param on `session/new`, or `availableModes` + `current_mode_update` in the session — then `planMode: 'native'` and the adapter sends the mode through ACP on session start / mode flip.
- If `plan`/`ask` are **TUI-only** (the `/plan` slash command and `--mode` flag only work in the interactive UI, not the stdio agent), then `planMode: 'simulated'` (or `'none'`) and the modes are advisory passthrough, like Hermes.

**This is unverified.** The ACP spec *does* define session modes (`availableModes`, `setSessionMode`, `current_mode_update`), and Grok advertises "full ACP support," so `'native'` is plausible — but confirm against a live `grok agent stdio` before claiming it. Until then, default the capability to `'simulated'` (safe: the UI shows the modes but doesn't promise enforcement) and leave a `// VERIFY: flip to 'native' if session/set_mode works` marker.

## Mode change mechanics in MultiTable

- `PUT /api/sessions/:id/mode` validates the value against `capabilities.modes` and emits `session:mode-changed` (provider-agnostic manager behavior — don't special-case Grok).
- If `planMode === 'native'`: on a mode flip the adapter should push the new mode to the live ACP session (`session/set_mode`) — or, if Grok options are immutable post-session-start (the Codex constraint), bust the cached session id so the next turn re-creates the session in the new mode. **VERIFY** which model Grok follows; record it in the session-cache key (key by `{sessionId, mode}` so a flip can bust the cache, exactly as the cache is structured for the ACP sibling adapter).
- If `planMode === 'simulated'`: modes are advisory, same session id across flips, no ACP call.

## What modes are NOT

Not a permission allowlist, not a sandbox enum we set, not a substitute for `session/request_permission`. Even in `code` mode Grok still emits permission server-requests for calls it flags; even in `ask` mode the enforcement is Grok's, not ours. Don't conflate mode with the per-call approval channel ([`../multitable/permission-wiring.md`](../multitable/permission-wiring.md)).
