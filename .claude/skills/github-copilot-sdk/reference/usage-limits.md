# Usage limits (rate limits / quota)

How a (not-yet-built) Copilot adapter should surface usage limits in MultiTable's always-present
per-session indicator. The provider-agnostic build-out (normalized type, WS event, store, badge)
lives in [`docs/reference/USAGE_LIMITS.md`](../../../../docs/reference/USAGE_LIMITS.md) — **this
file is the Copilot-specific source + capture path only.** Token/cost accounting is the sibling doc
[`cost-and-usage.md`](cost-and-usage.md); **limits ≠ cost** — keep them separate.

> **Status: LIVE** (adapter shipped 2026-07 against SDK 1.0.5). `capabilities.usageLimits = true`;
> the manager's out-of-band poll calls `CopilotAdapter.fetchUsageLimits(...)`.

## Where the data comes from (verified on 1.0.5)

Copilot bills against a **premium-request quota** (the GitHub Copilot subscription). In SDK 1.0.5
the ONLY live source is the **pull RPC** — `assistant.usage` events carry cost/token fields and
`copilotUsage.totalNanoAiu`, but **no quota snapshot** (the in-band `quotaSnapshots` this doc used
to describe does not exist on the event):

```ts
const result = await client.rpc.account.getQuota({});
// → AccountGetQuotaResult: { quotaSnapshots: Record<string, AccountQuotaSnapshot> }
//   keyed by quota type — 'premium_interactions' is the one that matters.
// AccountQuotaSnapshot: { isUnlimitedEntitlement, entitlementRequests, usedRequests,
//   usageAllowedWithExhaustedQuota, remainingPercentage, overage,
//   overageAllowedWithExhaustedQuota, resetDate? /* ISO string */ }
```

## The capture path (as shipped — `copilot.ts` `normalizeQuota` / `fetchUsageLimits`)

- `fetchUsageLimits` **never spawns the CLI child just to poll** — if the client hasn't been
  started by a turn yet it returns the last-known snapshot (`null` on first boot; the badge shows
  once the first Copilot turn runs).
- Normalization picks the `premium_interactions` snapshot (fallback: first entry):
  `usedPercent = round(100 - remainingPercentage)` (or `used/entitlement` if the percentage is
  absent; `0` when `isUnlimitedEntitlement`), `resetsAt = Date.parse(resetDate)` when present,
  `creditsRemaining = entitlementRequests - usedRequests`, `source: 'copilot'`, `status: 'live'`.
- Verified live: a real account returned `creditsRemaining` + a valid `resetsAt` through
  `GET /api/sessions/:id/usage-limits`.

## Don't confuse these three

| SDK source | What it is | Goes to |
|---|---|---|
| `assistant.usage.quotaSnapshots` / `account.getQuota` | **Subscription quota** (premium requests) | the **usage-limits indicator** (`applyUsageLimits`) |
| `assistant.usage.cost` / token counts | per-call **cost** | the cost panel (`applyUsage`) — see [`cost-and-usage.md`](cost-and-usage.md) |
| `session.usage_info` (`tokenLimit`, `currentTokens`) | **context-window** fill (compaction approaching) | a context-window indicator, *not* the usage-limits badge |

Wiring `session.usage_info` into the limits badge would be wrong — that's the conversation's token
window, not the account's subscription quota.
