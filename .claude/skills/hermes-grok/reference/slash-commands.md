# Hermes slash-commands — what's in scope for us

Hermes has its own in-band slash-command surface (works in its TUI and any messaging interface). Reference: [Hermes slash-commands](https://hermes-agent.nousresearch.com/docs/reference/slash-commands). This page is about **which ones the MultiTable adapter relies on, sends, or must not interfere with** — not a full Hermes manual.

## The only one the adapter sends

| Command | When | Why |
|---|---|---|
| `/reasoning <level>` | Prepended to the prompt body when `thinkingEffort` changed | The only ACP-less way to set Grok reasoning depth. Full details: [`reasoning-effort.md`](reasoning-effort.md). |

The adapter sends **nothing else**. The prompt body is otherwise the user's raw text.

## Commands the adapter deliberately does NOT use (and why)

| Command | Hermes effect | Why we don't touch it |
|---|---|---|
| `/model [name]` | switch model/provider (session, `--global` persists) | Model selection flows through MultiTable's provider catalog + `s.model`; `HERMES_INFERENCE_PROVIDER=xai-oauth` is env-pinned so `/model` switching providers would fight our pin. `modelSwitchScope: 'per-session'`. |
| `/new` | fresh session id + history | Session lifecycle is owned by the manager + `ensureSessionId` (`session/new` vs `session/load`). Sending `/new` in-band would desync our `agentSessionId`. |
| `/resume [name]` | resume a named session | We resume via ACP `session/load`, not the in-band command. |
| `/queue` (`/q`), `/steer` | queue / inject mid-run notes | `capabilities.midTurnInput === false`. Mid-turn steering is out of scope for v1; don't surface a UI affordance that sends these. |
| `/goal <text>` | standing auto-continue goal | Autonomy loop is out of scope; the manager owns turn boundaries. |
| `/codex-runtime …` | toggle OpenAI Codex runtime inside Hermes | Irrelevant to the xAI Grok path. |

If a user pastes one of these into the composer, it goes through as **plain prompt text** — the adapter does not intercept Hermes slash-commands the way the web client intercepts MultiTable-native `/clear` and `/cost`. Hermes itself interprets them on receipt. That's usually fine for `/reasoning`, `/model` etc., but `/new` / `/resume` will desync our session bookkeeping — treat a bug report of "history vanished after I typed /new" as expected behavior, not an adapter bug.

## Persistence semantics (matters for `/reasoning`)

Per the reference, `/reasoning` and `/model` default to **session-scoped** (no `--global`). That's exactly why the adapter caches `lastSentEffort` and only re-sends on change: Hermes keeps the level on the live ACP session, so re-sending every turn is pure transcript noise. A `session/load` re-attaches the session *with its persisted level intact* — but because our cache is keyed by MultiTable `s.id` and is cleared on error/reset, we conservatively re-assert the level after any discontinuity rather than assume Hermes' persisted value is still what the user wants.
