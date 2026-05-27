# Usage limits (rate limits / quota)

How a (not-yet-built) Copilot adapter should surface usage limits in MultiTable's always-present
per-session indicator. The provider-agnostic build-out (normalized type, WS event, store, badge)
lives in [`docs/reference/USAGE_LIMITS.md`](../../../../docs/reference/USAGE_LIMITS.md) — **this
file is the Copilot-specific source + capture path only.** Token/cost accounting is the sibling doc
[`cost-and-usage.md`](cost-and-usage.md); **limits ≠ cost** — keep them separate.

> **Status: forward-looking.** The Copilot adapter doesn't exist yet. When it's built, wire the
> indicator from day one (the requirement in `CLAUDE.md` → "Provider skill folders (required)"):
> advertise `capabilities.usageLimits = true` and feed `applyUsageLimits(...)`.

## Where the data comes from

Copilot bills against a **premium-request quota** (the GitHub Copilot subscription), and the SDK
exposes it through two channels (both already noted in [`cost-and-usage.md`](cost-and-usage.md)):

1. **In-band push** — `assistant.usage` events carry `quotaSnapshots` (and `copilotUsage`)
   alongside the per-call cost/token fields. Accumulate/replace the latest snapshot as the turn
   progresses.
2. **Pull (RPC)** — `account.getQuota` for an authoritative, turn-independent reading:
   ```ts
   const quota = await client.rpc.sendRequest('account.getQuota', {});
   // → AccountGetQuotaResult: { totalPremiumRequests, usedPremiumRequests, ... }
   ```

There is **no** separate "reset countdown" event the way Codex carries `resetsAt`; the quota is a
billing-period counter. Surface `usedPercent` from `usedPremiumRequests / totalPremiumRequests`,
and `resetsAt` only if the quota result exposes a period-end (else leave it `null`).

## The capture path (when the adapter exists)

```ts
function normalizeCopilotQuota(q: { totalPremiumRequests?: number; usedPremiumRequests?: number }): UsageLimitSnapshot {
  const total = q.totalPremiumRequests ?? 0;
  const used = q.usedPremiumRequests ?? 0;
  return {
    status: 'live',
    source: 'copilot', // extend the source union when the provider lands
    windows: [
      {
        label: 'Premium requests',
        usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
        resetsAt: null, // unless the quota result exposes a period end
      },
    ],
    creditsRemaining: total > 0 ? total - used : null,
    capturedAt: Date.now(),
  };
}
```

- On `assistant.usage`, if `quotaSnapshots` is present, normalize and `cb.applyUsageLimits(...)`.
- On warmup / provision, call `account.getQuota` once and feed the same pipe (so the badge has data
  before the first turn).

## Don't confuse these three

| SDK source | What it is | Goes to |
|---|---|---|
| `assistant.usage.quotaSnapshots` / `account.getQuota` | **Subscription quota** (premium requests) | the **usage-limits indicator** (`applyUsageLimits`) |
| `assistant.usage.cost` / token counts | per-call **cost** | the cost panel (`applyUsage`) — see [`cost-and-usage.md`](cost-and-usage.md) |
| `session.usage_info` (`tokenLimit`, `currentTokens`) | **context-window** fill (compaction approaching) | a context-window indicator, *not* the usage-limits badge |

Wiring `session.usage_info` into the limits badge would be wrong — that's the conversation's token
window, not the account's subscription quota.
