# Models, model switching, and reasoning effort

> **VERIFIED on grok v0.2.2.** Earlier drafts marked effort `'unsupported'` until proven — it's **native**.

## The model: `grok-build`

| Fact | Value (verified) |
|---|---|
| Model id (as reported by `session/new`) | `grok-build` |
| Display name | "Grok Build" — "Best for advanced coding tasks" |
| Context window | **512K** tokens (`_meta.totalContextTokens: 512000`) |
| Agent type | `grok-build-plan` |

`session/new` returns `models: { currentModelId, availableModels: [...] }`. Only `grok-build` is advertised today. The CLI also accepts other model ids via `-m`/`--model`, but for MultiTable's catalog we seed only the xAI model (see `GROK_BASELINE` in [`baselines.ts`](../../../../packages/daemon/src/providers/baselines.ts)).

## Reasoning effort — NATIVE, but SPAWN-TIME

> **CORRECTED on grok 0.2.2.** Effort is **not** a `session/new` param (that's ignored, like `permissionMode`). It's the spawn-time flag `grok agent --reasoning-effort <LEVEL>`.

The accepted levels are **`none | minimal | low | medium | high | xhigh`** — **there is NO `max`** (probe: `--reasoning-effort max` → *"invalid reasoning effort: max (expected one of: none, minimal, low, medium, high, xhigh)"*). So MultiTable's top tier **`max` maps to `xhigh`** (`mapEffortToGrok` in [`grok.ts`](../../../../packages/daemon/src/agent/providers/grok.ts)); `GROK_BASELINE.effortLevels` is capped at `xhigh`. `capabilities.thinkingEffort = 'native'`.

Wiring: `GrokAdapter.buildAgentArgs` appends `--reasoning-effort <mapped>` to the child's spawn args; the child pool is keyed by `(cwd, mode, effort, model)`, so changing effort routes the next turn to a different `grok agent` child. There is **no** `/reasoning`-style prompt prefix (that's a Hermes mechanism — do not copy it), and **no** `effort` field on `session/new`.

## Model switching

`session/new` does **not** honor a `model` param (ignored, like effort/mode). Model is the spawn-time flag `grok agent -m/--model <MODEL>`, also folded into `buildAgentArgs` and the pool key. `capabilities.modelSwitchScope = 'per-session'`. Only `grok-build` is advertised today, so this is mostly forward-plumbing.

## Catalog / discovery wiring

- **`baselines.ts`** — `GROK_BASELINE` seeds `grok-build` with effort `low`/`medium`/`high`/`xhigh` (capped — Grok's `--reasoning-effort` has no `max`).
- **`discovery.ts`** — `discoverGrok(env)` tries `grok models --json` defensively and resolves to `[]` otherwise (Grok exposes its model list via `session/new`, not a standalone command), so the baseline shows through.
- **`catalog.ts`** / **`api/providers.ts`** — `'grok'` is in `Provider` / `VALID_PROVIDERS`; `GET /grok/models` and `POST /refresh` are cache-served.
