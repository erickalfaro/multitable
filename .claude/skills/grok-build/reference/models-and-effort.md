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

## Reasoning effort — NATIVE

`grok --help`:
```
--effort <LEVEL>   [possible values: low, medium, high, xhigh, max]
```
These are **exactly** MultiTable's `ThinkingEffort` tiers — no dropping/mapping needed (unlike Hermes, which rejects `max`). `capabilities.thinkingEffort = 'native'`.

Wiring: the adapter passes `effort: s.thinkingEffort` into `session/new` (verified that Grok accepts `effort` there). The session cache key includes `effort`, so changing it re-issues `session/new`/`session/load` with the new value. There is **no** `/reasoning`-style prompt prefix (that's a Hermes mechanism — do not copy it).

## Model switching

`session/new` accepts a `model` param (verified). `capabilities.modelSwitchScope = 'per-session'`; the cache key includes `model`, so a model change re-creates/re-loads the session with the new id.

## Catalog / discovery wiring

- **`baselines.ts`** — `GROK_BASELINE` seeds `grok-build` with the full effort range (`low`/`medium`/`high`/`xhigh`/`max`).
- **`discovery.ts`** — `discoverGrok(env)` tries `grok models --json` defensively and resolves to `[]` otherwise (Grok exposes its model list via `session/new`, not a standalone command), so the baseline shows through.
- **`catalog.ts`** / **`api/providers.ts`** — `'grok'` is in `Provider` / `VALID_PROVIDERS`; `GET /grok/models` and `POST /refresh` are cache-served.
