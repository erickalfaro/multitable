# Usage-limits indicator

The always-present, per-session indicator that shows the **active provider/model's current usage
limits** — percent used + reset countdown for the most-constraining window — modeled on the
per-provider session/weekly meters in [`steipete/codexbar`](https://github.com/steipete/codexbar).
This doc is the **provider-agnostic** build-out spec. Each provider's *own* data source, wire
shape, and capture path live in that provider's skill (`.claude/skills/<provider>/reference/usage-limits.md`).

> **Requirement for every provider.** A provider integration is **not complete** until it either
> (a) advertises `capabilities.usageLimits = true` and feeds a normalized `UsageLimitSnapshot`
> through `applyUsageLimits(...)`, or (b) advertises `capabilities.usageLimits = false` and
> documents *why* (no live feed today) plus the out-of-band path that would surface limits later.
> This mirrors the "Provider skill folders (required)" rule in `CLAUDE.md`.

## The one shape everything normalizes to

Providers expose limits in wildly different shapes (Claude: a single `rate_limit_info`; Codex:
`primary`/`secondary` windows + credits; Hermes/Grok: nothing live). The daemon collapses all of
them into one normalized snapshot so the UI stays provider-agnostic
([`packages/daemon/src/agent/types.ts`](../../packages/daemon/src/agent/types.ts)):

```ts
export interface UsageLimitWindow {
  label: string;                       // 'Session' | 'Weekly' | 'Primary' | a provider rateLimitType …
  usedPercent: number;                 // 0..100
  resetsAt: number | null;             // ms-epoch, or null if unknown
  windowDurationMins?: number | null;  // rolling-window length (Codex windowDurationMins)
}

export interface UsageLimitSnapshot {
  status: 'live' | 'unavailable' | 'stale';
  source: 'claude' | 'codex' | 'hermes' | 'grok';
  windows: UsageLimitWindow[];         // UI picks max(usedPercent) for the badge; popover lists all
  planType?: string | null;
  creditsRemaining?: number | null;
  capturedAt: number;                  // ms-epoch
}
```

The latest snapshot lives **in memory** on `AgentSession.usageLimits` (`UsageLimitSnapshot | null`).
It is deliberately **not persisted to SQLite** — limits are live/ephemeral and a stale countdown
across a daemon restart misleads. Late-joining / refreshed clients hydrate via the REST endpoint
below.

## End-to-end data flow

```
provider (in-band event  ──┐
          or out-of-band   │   adapter normalizes →   manager           server          web
          credential read) ├─► cb.applyUsageLimits ──► s.usageLimits ──► broadcast ────► usageLimitsBySession
                           │                          + emit('usage-     'session:usage-  ──► <UsageLimitBadge>
                           │                          limits-changed')   limits-changed')
GET /api/sessions/:id/usage-limits  (refresh / late-join hydration; returns s.usageLimits ?? null)
```

### 1. Adapter contract — `packages/daemon/src/agent/providers/types.ts`

- `AdapterCallbacks.applyUsageLimits(snapshot: UsageLimitSnapshot): void` — **dedicated** callback.
  Do **not** overload `applyUsage` (that one is cumulative and writes `cost_records`; a limit
  snapshot is a wholesale replace that can arrive *outside* a turn).
- `ProviderCapabilities.usageLimits: boolean` — drives conditional UI (badge hidden when `false`).
- `ProviderAdapter.fetchUsageLimits?(s): Promise<UsageLimitSnapshot | null>` — **the out-of-band
  fetch**, the codexbar pattern: read the provider's own local credentials and call its usage API
  directly, independent of any turn. This is the **primary, reliable** source (the in-band
  `rate_limit_event` only fires sometimes and never gives the full multi-window picture). The
  manager refreshes it **event-driven** (`refreshUsageLimits(provider)`) — **on every
  `turn-complete`** (the moment limits change) and **once when a session opens / at boot**
  (`refreshAllUsageLimits`), **not** on a timer. It fetches **once per provider** (account-wide;
  a per-provider in-flight guard collapses rapid turns) and fans the snapshot to all that
  provider's sessions via `applyUsageLimits`. Implemented for Claude (`GET /api/oauth/usage`),
  Codex (`account/rateLimits/read`), and Grok (xAI gRPC-web billing — see `grok-usage.ts`);
  Hermes pending its `~/.hermes/` cred shape.

### 2. Manager + WS — `manager.ts`, `server.ts`

- `manager.ts` (next to the `applyUsage` callback impl): `applyUsageLimits` sets `s.usageLimits`
  and `this.emit('usage-limits-changed', { sessionId, snapshot })`.
- `server.ts` (next to the `mode-changed` / `thinking-effort-changed` rebroadcasts):
  `agentManager.on('usage-limits-changed', …)` → `broadcast('session:usage-limits-changed',
  { sessionId, snapshot })`.
- A **dedicated** WS event, **not** folded into the hot `snapshotStats` / `session:state-updated`
  path: limit snapshots arrive on a different cadence (including outside turns) and carry a richer
  shape; keep the hot path lean.
- `api/sessions.ts`: `GET /:id/usage-limits` → `agentManager.get(id)?.usageLimits ?? null` (mirrors
  the existing `/cost` endpoint) for refresh / late-join hydration.

### 3. Web — `packages/web/src`

- `lib/types.ts`: mirror `UsageLimitWindow` + `UsageLimitSnapshot`; add `usageLimits: boolean` to
  `ProviderCapabilities`.
- `stores/appStore.ts`: `usageLimitsBySession: Record<string, UsageLimitSnapshot | null>` +
  `setUsageLimits(sessionId, snapshot)` action.
- `App.tsx`: a `session:usage-limits-changed` handler (mirror the `session:mode-changed` handler)
  → `setUsageLimits(...)`.
- `components/main-pane/UsageLimitBadge.tsx`: modeled on `ThinkingEffortBadge.tsx`. Reads
  `usageLimitsBySession[session.id]`; **hides** when `capabilities.usageLimits !== true`; collapsed
  label is the most-constraining window `${Math.round(usedPercent)}%` + a **live** reset countdown
  (scope the ticking timer to the badge — don't re-render the header each second); amber→red tone
  ramp; a popover lists every window + `planType` / `creditsRemaining`. Read-only (no PUT). Shows
  "—" only when the capability is `true` but `status === 'unavailable'`.
- Placement: `components/main-pane/SessionHeaderBar.tsx` mobile Row 2 (after `ModeBadge`) and the
  desktop home where `ModeBadge`/`ModelChip` render.

## Per-provider data source (summary — depth in each provider's skill)

All endpoints/credential formats below are reverse-engineered from
[`steipete/codexbar`](https://github.com/steipete/codexbar) (the reference the feature is modeled on).

| Provider | `usageLimits` | Primary source (out-of-band, refreshed on turn-complete) | Credential | Skill |
|---|---|---|---|---|
| Claude | `true` | `GET https://api.anthropic.com/api/oauth/usage` (`anthropic-beta: oauth-2025-04-20`) → `five_hour` + `seven_day[_opus/_sonnet]` windows `{utilization, resets_at}`. (Also in-band `rate_limit_event` for instant mid-turn updates + alerts.) | `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` (or `CLAUDE_CODE_OAUTH_TOKEN`) | [`claude-agent-sdk/reference/usage-limits.md`](../../.claude/skills/claude-agent-sdk/reference/usage-limits.md) |
| Codex | `true` | `account/rateLimits/read` over the app-server (+ `account/rateLimits/updated` push) → `primary`/`secondary` windows, `credits`, `planType` | `~/.codex/auth.json` (app-server reads it) | [`openai-codex-sdk/reference/usage-limits.md`](../../.claude/skills/openai-codex-sdk/reference/usage-limits.md) |
| Grok Build | `true` | `POST https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` (gRPC-web; empty frame; heuristic protobuf scan — `grok-usage.ts`) → one window `{usedPercent, resetsAt}` | `~/.grok/auth.json` (map keyed by scope; OIDC entry's `key`) | [`grok-build/reference/usage-limits.md`](../../.claude/skills/grok-build/reference/usage-limits.md) |
| Hermes | `false` (pending) | Same xAI billing as Grok, but `~/.hermes/auth.json` token shape not yet confirmed | `~/.hermes/auth.json` (shape TBD) | [`hermes-grok/reference/usage-limits.md`](../../.claude/skills/hermes-grok/reference/usage-limits.md) |
| GitHub Copilot | (when built) | `assistant.usage.quotaSnapshots` + `account.getQuota` RPC | GitHub OAuth | [`github-copilot-sdk/reference/cost-and-usage.md`](../../.claude/skills/github-copilot-sdk/reference/cost-and-usage.md) |

## Two gotchas that span providers

1. **Capture the *healthy* snapshot, not just the warning.** Claude's existing
   `handleRateLimitEvent` discarded the `status === 'allowed'` case (it only alerted near/over the
   limit). An *always-present* indicator needs the healthy snapshot too. Don't gate the snapshot on
   "near the limit" — only gate the *alert*.
2. **Account-scoped data is not turn-scoped.** Codex's `account/rateLimits/updated` carries no
   `threadId`, so a per-thread fan-out drops it. The snapshot is account-wide (shared across all
   that provider's sessions) — fan it to every session of that provider. Approximate per-session
   attribution is acceptable and matches codexbar.

## Out of scope / follow-ups

- **Hermes**: confirm the `~/.hermes/auth.json` token shape and whether its xAI token authenticates
  against the same `grok.com` billing RPC; then reuse the `grok-usage.ts` fetch path. Capability is
  `false` until confirmed.
- **Grok protobuf parse** (`grok-usage.ts`) is a heuristic mirroring codexbar (no generated proto) —
  validate the percent/reset against grok's own usage display; tighten the field-path heuristic if
  it drifts.
- **Claude token refresh**: we don't refresh the OAuth token (codexbar delegates to the Claude CLI
  too). An expired token → the next refresh 401s → badge goes stale until the CLI refreshes the file.
- Optional SQLite persistence of the last snapshot.
- The GitHub Copilot adapter itself (documented forward-looking; adapter not yet built).
