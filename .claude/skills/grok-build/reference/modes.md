# Modes: Grok's `--permission-mode` (identical to Claude's enum)

> **VERIFIED on grok v0.2.2.** Earlier drafts of this doc guessed `code`/`plan`/`ask` — that was wrong. Grok Build's `--permission-mode` enum is **exactly Claude's `PermissionMode`**, and `session/new` accepts a `permissionMode` param (the adapter forwards `s.mode` verbatim).

`grok --help` lists:

```
--permission-mode <MODE>   [possible values: default, acceptEdits, auto, dontAsk, bypassPermissions, plan]
--sandbox <PROFILE>        Sandbox profile for filesystem and network access  [env: GROK_SANDBOX=]
```

So Grok has **two** orthogonal axes: a Claude-style **permission mode** (soft gating, what we wire as `modes`) and an OS-enforced **sandbox profile** (deferred to v2 — see below).

MultiTable does **not** invent or translate modes. The adapter declares the native set in `capabilities.modes` (see [`grok.ts`](../../../../packages/daemon/src/agent/providers/grok.ts)) and passes `s.mode` straight into `session/new`'s `permissionMode`.

## The six modes (as declared in the adapter)

| `permissionMode` | Label | Tone | Behavior |
|---|---|---|---|
| `default` | Ask first | standard | Prompts before sensitive tools. |
| `acceptEdits` | Accept edits | elevated | Auto-accepts file edits; still prompts for other sensitive actions. |
| `auto` | Auto | elevated | Proceeds autonomously, prompting only when necessary. |
| `plan` | Plan | safe | Proposes a plan / shows diffs before applying; requires approval. |
| `dontAsk` | Don't ask | danger | Suppresses permission prompts for the session. |
| `bypassPermissions` | Bypass | danger | Runs every tool without asking. |

These reuse Claude's exact values, so `packages/web/src/lib/modeTone.ts`'s `MODE_TONE_FALLBACK` already maps all six — the web side needed **zero** new mode knowledge.

## `planMode` capability = `'native'`

Grok has a real `plan` permission-mode (proposes a plan, shows diffs, requires approval). `capabilities.planMode = 'native'`.

## How a mode change applies

`PUT /api/sessions/:id/mode` validates against `capabilities.modes` and emits `session:mode-changed` (provider-agnostic). The adapter keys its session cache by `{grokSessionId, mode, effort, model}`; when `s.mode` changes the cache misses and `ensureSessionId` re-issues `session/new`/`session/load` with the new `permissionMode`. (Whether Grok re-applies `permissionMode` on `session/load` of an existing session vs. only on a fresh `session/new` is the one residual uncertainty — new sessions definitely get the right mode; verify continuity behavior if a mode flip mid-session ever looks ignored.)

## `--sandbox` (deferred to v2)

The separate `--sandbox <PROFILE>` axis (OS-enforced FS/network confinement, env `GROK_SANDBOX`) is **not wired in v1**: the adapter leaves it at Grok's default and gates via `permissionMode`, so `capabilities.hardSandbox = false`. To wire it later: enumerate the valid profile names (`grok --help` doesn't list them inline), decide whether to expose them as a second UI control or fold into the mode set, and flip `hardSandbox`.

## What modes are NOT

Not a substitute for `session/request_permission`: even in `default` mode Grok only prompts for calls it deems sensitive, and even in `bypassPermissions` the enforcement is Grok's. Don't conflate the mode with the per-call approval channel ([`../multitable/permission-wiring.md`](../multitable/permission-wiring.md)).
