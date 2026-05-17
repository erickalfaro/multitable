# xAI Grok OAuth — auth, models, feature matrix

The target use case (per the [adapter's top comment](../../../../packages/daemon/src/agent/providers/hermes.ts) and [`x.ai/news/grok-hermes`](https://x.ai/news/grok-hermes), May 15 2026): drive **xAI Grok 4.3** through Hermes' **OAuth-authenticated xAI integration** — no API key, billed against the user's **SuperGrok / X Premium+** subscription.

Canonical docs: [Hermes xAI Grok OAuth guide](https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth).

## One-time user setup (outside MultiTable)

The operator runs **one** of these in a terminal, once per machine:

- `hermes model` → pick **"xAI Grok OAuth (SuperGrok Subscription)"** → approve at `accounts.x.ai` → pick a model, **or**
- `hermes auth add xai-oauth` → log in manually.

Tokens land in **`~/.hermes/auth.json`** and Hermes **refreshes the access token automatically** before expiry and reactively on a 401. MultiTable never touches `auth.json`; we only read the auth *state* Hermes reports during the ACP `initialize` handshake.

## How the adapter pins the provider

We do **not** trust the operator's Hermes shell defaults (`hermes config set model.provider …` could route turns to a different backend). The transport spawns the child with an env overlay:

```ts
envOverlay: { HERMES_INFERENCE_PROVIDER: 'xai-oauth', TERMINAL_CWD: cwd }
```

- `HERMES_INFERENCE_PROVIDER=xai-oauth` pins inference to the xAI OAuth provider at the Hermes runtime layer, above the user's config.
- `TERMINAL_CWD=cwd` makes Hermes discover project context files from the project root even on code paths that read the env var instead of `os.getcwd()` (the spawn cwd *is* the project root too — belt and suspenders; see [`../multitable/adapter-architecture.md`](../multitable/adapter-architecture.md)).

`envOverlay` is **merged onto** `process.env` in the transport (`{ ...process.env, ...envOverlay }`), not a replacement — `HOME`/`PATH` survive, so the child can find `~/.hermes/` and `hermes`'s own subprocesses work.

## Auth-state detection (`ensureReady`)

During `initialize`, Hermes returns `authMethods[]`. The client picks the **first method whose `id` is not `hermes-setup`** as the working auth path:

- A real provider id (e.g. `"xai-oauth"`) → `authenticate({ methodId })` → `HermesAuthState = { kind: 'ready', methodId }`.
- Only `hermes-setup` advertised (a "go run `hermes model`" terminal-setup signal, `type: 'terminal'`) → `{ kind: 'needsSetup', methodIds }`. For the daemon this is equivalent to "no credentials."
- `authenticate` rejected → also `{ kind: 'needsSetup', … }`.

`HermesAdapter.runTurn` turns `needsSetup` into a **persistent typed alert** and throws *before* any session is created:

- methods include `hermes-setup` → body: *"Run `hermes model` and pick \"xAI Grok OAuth (SuperGrok Subscription)\" to sign in."*
- otherwise → body: *"No usable auth method advertised by hermes acp — run `hermes doctor` to diagnose."*

A spawn/init failure (binary missing) emits a separate persistent `auth` alert with the install one-liner:

```
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

When you change auth wording, change it in `hermes.ts:runTurn` (the alert bodies), not in the client.

## Grok models in Hermes (xAI Grok OAuth provider)

Per the OAuth guide:

| Role | Model id |
|---|---|
| **Default** (pinned top of `hermes model` list) | `grok-4.3` |
| Reasoning variant | `grok-4.20-0309-reasoning` |
| Non-reasoning variant | `grok-4.20-0309-non-reasoning` |
| Multi-agent variant | `grok-4.20-multi-agent-0309` |

The adapter's fallback when `s.model` is unset is the string **`'grok-4.3'`** (used as the `model` field on the canonical assistant `Message`). `capabilities.modelSwitchScope` is `'per-session'`. Model selection itself flows through MultiTable's provider catalog + the Hermes `/model` slash-command — the adapter does not translate model ids.

> ⚠️ `grok-4.20-multi-agent-*` re-purposes the reasoning-effort parameter to control **agent collaboration count**, not thinking depth (per [xAI's reasoning spec](https://docs.x.ai/developers/model-capabilities/text/reasoning)). The `/reasoning` prefix we send still goes through, but its *meaning* changes on that model — note this if a user reports "high effort did something weird on multi-agent."

## Feature matrix (xAI Grok OAuth via Hermes)

| Feature | Supported? | Notes for us |
|---|---|---|
| Reasoning | ✅ | via `/reasoning` + reasoning-capable models — see [`reasoning-effort.md`](reasoning-effort.md) |
| Tool calling | ✅ | xAI Responses API; surfaces as ACP `tool_call`/`tool_call_update` |
| Streaming | ✅ | ACP `agent_message_chunk` (additive) |
| Prompt caching | ✅ | tokens land in `usage.cacheCreationInputTokens` / `cacheReadInputTokens` when present |
| Image generation | ✅ | `grok-imagine-image`; **not surfaced** in our v1 chat (no image-block rendering) |
| TTS | ✅ | xAI `/v1/tts`; out of scope for the adapter |
| X search | ✅ | `x_search` tool, **disabled by default**, enable via `hermes tools` (operator-side, not ours) |
| **USD cost** | ❌ | no per-turn dollar figure; `capabilities.costUsd === false`, `costUsd: 0` everywhere |

## Persistence layout (`~/.hermes/`)

| Path | What |
|---|---|
| `~/.hermes/auth.json` | OAuth tokens (Hermes-managed, auto-refreshed). We never write it. |
| `~/.hermes/config.yaml` | `model.provider`, `model.default`, `agent.reasoning_effort`, etc. We override `provider` via env, not this file. |
| `~/.hermes/state.db` | ACP session store. `session/load` re-attaches by session id from here. |
| `~/.hermes/sessions/session_<id>.json` | Per-session transcript (OpenAI chat-completions shape). [`hermesParser.ts`](../../../../packages/daemon/src/transcripts/hermesParser.ts) reads this for hydration. |

The session id is the canonical identifier across `state.db` and the `sessions/` JSON; `AgentSession.agentSessionId` mirrors it.
