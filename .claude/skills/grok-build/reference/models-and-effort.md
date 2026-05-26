# Models, `/model` switching, and reasoning effort

> Research-derived; **`VERIFY`** against `grok inspect` + a live `grok agent stdio`.

## The model: `grok-build-0.1`

| Fact | Value |
|---|---|
| Canonical model id | `grok-build-0.1` (released 2026-05-20; CLI launched 2026-05-14) |
| Context window | 256K tokens |
| Input | text + image |
| Published pricing | $1.00 / 1M input, $2.00 / 1M output, $0.20 / 1M cached input |
| SWE-bench Verified | ~70.8% (xAI's claim; marketing, not load-bearing) |

Grok Build is also **model-pluggable**: `/model <name>` in the TUI switches the active model, and `grok -p "…" -m <model>` selects one in headless mode. xAI's docs show non-xAI ids working too (`claude-sonnet-4`, `gpt-5`, `local/llama-4`). For MultiTable's catalog we seed the **xAI** model(s) only — don't try to enumerate every BYO model Grok *could* route to.

## Catalog / discovery wiring

Mirror the existing provider-catalog system ([`../../../packages/daemon/src/providers/`](../../../../packages/daemon/src/providers/)):

- **`baselines.ts`** — add a `GROK_BASELINE: BaselineModel[]` seed (at minimum `grok-build-0.1`), and extend `baselineFor(provider)` with a `case 'grok'`.
- **`discovery.ts`** — add `discoverGrok(env): Promise<DiscoveredModel[]>`. **VERIFY** whether Grok exposes a model-list command (e.g. `grok models --json`, or an ACP `agentCapabilities.models` field on `initialize`). If there's no machine-readable list, `discoverGrok` returns the baseline (the catalog layers baseline → cache → discovery, so returning `[]`/baseline is safe).
- **`catalog.ts`** — add `'grok'` to the `Provider` type; the EventEmitter layering needs no other change.
- **`api/providers.ts`** — add `'grok'` to `VALID_PROVIDERS`. `GET /grok/models` and `POST /refresh` then work for free (cache-served; never block on CLI calls — see CLAUDE.md "Don't reintroduce per-request CLI calls").

Each `DiscoveredModel.effortLevels` declares the supported reasoning tiers the UI's `ThinkingEffortBadge` filters to — see below.

## Reasoning effort — the open question

`ThinkingEffort` is `'low' | 'medium' | 'high' | 'xhigh' | 'max'`; the session field is `ThinkingEffort | null`. Each adapter declares `capabilities.thinkingEffort: 'native' | 'unsupported'`.

**For Grok, this is unverified.** grok-build-0.1 is a "fast" coding model and xAI has not published a reasoning-effort knob for the agent-stdio surface. Two outcomes:

1. **No knob exposed** → `capabilities.thinkingEffort = 'unsupported'`; the UI renders the toggle disabled; the adapter ignores `s.thinkingEffort`. **This is the v1 default** until proven otherwise.
2. **A knob exists** (an effort field on `session/prompt`/`turn` params, or a `/reasoning`-style slash command) → `thinkingEffort = 'native'`; plumb the value through. If it's a slash-command prefix, send it **only when the effort changes** (cache `lastSentEffort` per session) and strip it in `grokParser.ts` so old transcripts don't show the prefix as user-typed — and change the parser regex in lockstep with the adapter format. If a tier (e.g. `max`) is rejected by Grok, drop it rather than mapping it.

Do **not** copy Hermes' `/reasoning <level>` prefix mechanism speculatively — it's Hermes-specific. Verify Grok's own mechanism first.

## `modelSwitchScope`

Set `capabilities.modelSwitchScope`:
- `'per-session'` if the model is fixed when the ACP session is created (likely — ACP sets model at `session/new`).
- `'per-turn'` only if `session/prompt` accepts a per-turn model override over the agent-stdio surface (`VERIFY` — the TUI `/model` may not translate to stdio).

Default `'per-session'` until verified.
