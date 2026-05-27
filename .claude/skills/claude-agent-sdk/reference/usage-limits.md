# Usage limits (rate limits)

How MultiTable surfaces Claude's usage limits in the always-present per-session indicator. The
provider-agnostic build-out (normalized type, WS event, store, badge) lives in
[`docs/reference/USAGE_LIMITS.md`](../../../../docs/reference/USAGE_LIMITS.md) — **this file is the
Claude-specific source + capture path only.**

## Where the data comes from

Claude is the **only** provider that pushes limit data *in-band*, for free, as part of the SDK
message stream. The SDK emits a `rate_limit_event` message carrying `rate_limit_info`
(`SDKRateLimitInfo`, quoted from `sdk.d.ts`):

```ts
{
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;          // ms-epoch when THIS window resets
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage';
  utilization?: number;       // 0..1 — fraction of THIS window consumed
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  overageResetsAt?: number;
  isUsingOverage?: boolean;
  // …overageDisabledReason, surpassedThreshold
}
```

We dispatch this: [`claude.ts`](../../../packages/daemon/src/agent/providers/claude.ts) routes
`case 'rate_limit_event'` → `handleRateLimitEvent(s, msg, cb)`.

**The fact that shapes the capture:** each event reports **one** window (`rateLimitType`), but the
TUI `/usage` dialog shows **all** of them (Current session / Current week / Current week (Opus)).
So we **accumulate latest-per-`rateLimitType`** into a per-session `Map` (`limitWindows`) and emit
the **union**, ordered to match `/usage`, via `CLAUDE_LIMIT_META`. Replacing the snapshot with a
single window (the original bug) made the badge show only the most-recently-reported window — which
is exactly why it didn't match `/usage`.

## The capture path

Accumulate the reported window into a per-session `Map<rateLimitType, UsageLimitWindow>`, emit the
**union** (ordered via `CLAUDE_LIMIT_META`), then fire an alert *only* when near/over the limit:

```ts
const CLAUDE_LIMIT_META: Record<string, { label: string; rank: number }> = {
  five_hour:        { label: 'Current session',          rank: 0 },
  seven_day:        { label: 'Current week (all models)', rank: 1 },
  seven_day_opus:   { label: 'Current week (Opus)',      rank: 2 },
  seven_day_sonnet: { label: 'Current week (Sonnet)',    rank: 3 },
  overage:          { label: 'Overage',                  rank: 4 },
};

private handleRateLimitEvent(s: AgentSession, msg: unknown, cb: AdapterCallbacks): void {
  const info = …; // rate_limit_info
  const utilization = typeof info.utilization === 'number' ? info.utilization : null;
  const limitType = typeof info.rateLimitType === 'string' ? info.rateLimitType : 'limit';

  if (utilization !== null) {
    const windows = this.limitWindows.get(s.id) ?? new Map();
    this.limitWindows.set(s.id, windows);
    windows.set(limitType, {
      label: CLAUDE_LIMIT_META[limitType]?.label ?? limitType,
      usedPercent: Math.round(utilization * 100),
      resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null,
    });
    cb.applyUsageLimits({
      status: 'live',
      source: 'claude',
      windows: [...windows.entries()]
        .sort(([a], [b]) => (CLAUDE_LIMIT_META[a]?.rank ?? 99) - (CLAUDE_LIMIT_META[b]?.rank ?? 99))
        .map(([, w]) => w),
      capturedAt: Date.now(),
    });
  }

  if (status === 'allowed') return; // gate the ALERT only — never the snapshot
  // … existing emitAlert(category:'rate-limit', …) …
}
```

`limitWindows` is **not** cleared on `reset()`/`/clear` — limits are account-wide, not
conversation-scoped. And in the adapter's `capabilities` block: `usageLimits: true`.

## Two gotchas

1. **Don't keep the `if (status === 'allowed') return;` ahead of the snapshot.** That guard was for
   *alerting* near the limit; the always-present indicator needs the healthy snapshot too. Gate the
   alert, not the snapshot. See [`pitfalls.md`](../pitfalls.md).
2. **Don't replace the snapshot with a single window.** Each event is one `rateLimitType`; `/usage`
   shows all windows. Accumulate by type and emit the union, or the badge flip-flops between windows
   and never matches `/usage`.

## The primary source: out-of-band `GET /api/oauth/usage` (matches `/usage` exactly)

`rate_limit_info` is **push-on-response** and unreliable for an always-present badge — a window
appears only once the API includes it on a turn (usually just the binding one), and the SDK exposes
**no** "fetch all windows now" call (`getContextUsage()` is the token *context window*;
`accountInfo()` has `subscriptionType` but no usage). So the **primary, reliable** source is the
out-of-band fetch the manager triggers **event-driven** — on every `turn-complete` and once when a
session opens (not on a timer) — hitting the same endpoint `/usage` itself uses
(`ClaudeAdapter.fetchUsageLimits`):

- **Credential**: `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` (or
  `CLAUDE_CODE_OAUTH_TOKEN` env). API-key-only auth has no subscription usage → returns null (badge
  hides). `~/.claude/auth.json` is **not** it — the OAuth creds live in `.credentials.json`.
- **Request**: `GET https://api.anthropic.com/api/oauth/usage`, headers `Authorization: Bearer …`,
  `anthropic-beta: oauth-2025-04-20` (**required**), `User-Agent: claude-code/<ver>`,
  `Accept`/`Content-Type: application/json`. No `anthropic-version`.
- **Response** (snake_case): `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, … each
  `{ utilization (0–100), resets_at (ISO-8601) }`; `extra_usage { is_enabled, monthly_limit,
  used_credits, … }` in **cents**. `normalizeClaudeUsage` maps these to windows (reusing
  `CLAUDE_LIMIT_META` labels) — this is what makes the badge match `/usage`.
- **No token refresh**: we don't refresh (codexbar delegates to the Claude CLI too). Expired token →
  401 → null → badge stale until the CLI refreshes `~/.claude/.credentials.json`; the next
  turn-complete refresh recovers. Fail-safe: any error → null, never garbage.

The in-band `rate_limit_event` path (above) still runs — it updates the badge **instantly mid-turn**
and drives the rate-limit alert — but the out-of-band fetch is the authoritative, complete picture.

## What Claude does NOT give you

- **No credits / plan type in the event.** Leave `creditsRemaining` / `planType` unset for Claude.
- **No structured multi-window snapshot in one event** — you build it by accumulating across events
  (above). (Codex, by contrast, carries `primary`/`secondary` in a single `RateLimitSnapshot`.)
