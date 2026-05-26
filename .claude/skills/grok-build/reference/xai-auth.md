# Grok Build auth, config, and the billing extension

> Research-derived; **`VERIFY`** against a running `grok` + `grok agent stdio`. xAI's CLI is early beta — paths and flows change.

## Two auth sources (precedence matters)

Grok Build authenticates from the same place its own CLI does, with **two** sources:

1. **OAuth (default, interactive):** `grok auth login` (or just running `grok` the first time) opens a browser and signs in with a **SuperGrok / SuperGrok Heavy / SuperHeavy** subscription. The token is written to **`~/.grok/auth.json`**. This is "always works for subscribers."
2. **API key (headless / CI):** export **`GROK_CODE_XAI_API_KEY`** (the documented Grok-Build env) or **`XAI_API_KEY`**. Keys come from `console.x.ai` → API Keys (shown once).

The `grok agent stdio` child **inherits `process.env`** (like the Codex app-server). So decide and document MultiTable's precedence — recommended: **if an `XAI_API_KEY` / `GROK_CODE_XAI_API_KEY` is present in the daemon env, it wins; otherwise rely on the on-disk `~/.grok/auth.json` OAuth token.** Don't assume only one path exists. **VERIFY** which source `grok agent stdio` actually prefers when both are set.

> Note: `~/.grok/auth.json` (and `~/.grok/auth`) is in Grok's **write-protected** directory set alongside `~/.ssh`, `~/.aws`, `~/.config/gcloud` — Grok itself won't let tools write there. Don't have the adapter mutate it either; treat it as read-only credential state owned by `grok auth`.

## The `~/.grok/` config layout

| Path | Purpose |
|---|---|
| `~/.grok/auth.json` | OAuth token (SuperGrok). Machine-wide; not per-session. |
| `~/.grok/user-settings.json` | User-level settings. |
| `<project>/.grok/settings.json` | Project-level settings, incl. `mcpServers`. |
| `~/.grok/hooks/*.json` | Grok-side lifecycle hooks (post-edit, pre-command, …) — **run inside Grok, not host-brokered to us**. Merged across files. |
| `~/.grok/workspace-trust.json` | Per-directory trust choices (see [`../pitfalls.md`](../pitfalls.md) §9). |
| `~/.grok/` (sessions) | Local session history — **the parser source**; exact subpath/format `VERIFY`. See [`../multitable/persistence-and-parser.md`](../multitable/persistence-and-parser.md). |
| `<project>/.grok/generated-media/` | Default output dir for generated media. |

`grok inspect` prints the detected config sources, MCP servers, skills, plugins, hooks, and AGENTS.md — run it to see what a given cwd resolves to.

## Auth-state detection in the adapter

Auth failures arrive as **JSON-RPC errors**, not a clean flag. Known message (billing path): *"Authentication required to fetch billing data. Run grok login to authenticate."* **VERIFY** the exact code/message for a **prompt-time** auth failure (the one that matters — billing is a side-channel we don't even call in v1).

Adapter behavior:
- On `ensureReady()` / first `session/prompt`, classify an auth-failure error.
- Raise a typed `emitAlert({ category: 'auth', severity: 'attention', persistent: true, … })` with body "Run `grok auth login` (SuperGrok required) or set `GROK_CODE_XAI_API_KEY`."
- **Throw before persisting a session id** — don't mint/persist an `agentSessionId` for an unauthenticated turn. (Mirrors the Hermes `needsSetup` rule, but classify Grok's *own* error strings — don't reuse Hermes' `hermes-setup` method id.)

## The `x.ai/billing` extension (and why cost is off for v1)

ACP extension method `x.ai/billing` (no params) returns:

```json
{
  "billingCycle": { "billingPeriodStart": "…", "billingPeriodEnd": "…" },
  "monthlyLimit": { "val": 99900 },
  "usage": { "includedUsed": { "val": 12345 }, "onDemandUsed": { "val": 0 }, "totalUsed": { "val": 12345 } }
}
```

**But:** in grok 0.1.x it's wired **only into the interactive TUI**; over `grok agent stdio` it returns `-32601 Method not found`. So:

- `capabilities.costUsd = false`. The dollar row is hidden for Grok sessions.
- This is **account/subscription usage**, not per-turn USD anyway — it answers "how much of my monthly quota is left," not "what did this turn cost."
- If you ever surface it (a future "subscription usage" badge), probe **once** with the CodexBar timeouts (8 s init / 12 s billing) and kill the child on timeout; cache `-32601` as "unavailable, don't retry." Don't probe per-turn.

## Model identity

The CLI runs xAI's purpose-built **`grok-build-0.1`** (256K context; text+image input; published pricing $1/$2 per 1M in/out, $0.20/1M cached). It can also drive other models via `/model` (e.g. `claude-sonnet-4`, `gpt-5`, `local/...`). See [`models-and-effort.md`](models-and-effort.md) for catalog/discovery wiring.
