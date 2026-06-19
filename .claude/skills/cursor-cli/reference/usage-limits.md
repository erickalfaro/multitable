# Cursor usage limits

**Status: OFF for Cursor.** `capabilities.usageLimits = false`; the
`UsageLimitBadge` is hidden for Cursor sessions. This file documents why and the
out-of-band path that would surface limits later, per `docs/reference/USAGE_LIMITS.md`.

## Why there is no live feed

The headless stream-json protocol carries **no rate-limit / usage-limit event**.
The terminal `result` line reports per-turn token counts
(`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`) — those feed
`applyUsage` (cumulative tokens) but say nothing about remaining quota or reset
windows. There is also **no USD cost** field (`capabilities.costUsd = false`).

Cursor enforces usage at the **account/plan level** (per-user / team plan,
included requests, usage-based pricing) and surfaces it on the web dashboard at
`cursor.com` (Settings → Usage), not over the CLI wire.

## Out-of-band path (future)

To surface limits we would implement `fetchUsageLimits(s)` (the optional
`ProviderAdapter` hook the manager polls on turn-complete / session-open) reading
account usage out-of-band — the same shape Grok uses (`grok-usage.ts` queries
xAI billing). Candidate Cursor sources:

- The Cursor billing/usage API behind the logged-in session
  (`serverConfigCache.backendUrl` = `https://api2.cursor.sh`), authenticated with
  the cached token referenced by `~/.cursor/cli-config.json`.
- Whatever endpoint the dashboard's Usage page calls.

Until that's reverse-engineered and confirmed stable, keep `usageLimits = false`
and do **not** call `applyUsageLimits`. Normalize into a `UsageLimitSnapshot`
(`source: 'cursor'`) when implemented.
