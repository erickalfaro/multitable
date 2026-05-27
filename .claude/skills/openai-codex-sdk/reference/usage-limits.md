# Usage limits (rate limits)

How MultiTable surfaces Codex's usage limits in the always-present per-session indicator. The
provider-agnostic build-out (normalized type, WS event, store, badge) lives in
[`docs/reference/USAGE_LIMITS.md`](../../../../docs/reference/USAGE_LIMITS.md) — **this file is the
Codex-specific source + capture path only.**

> **Heads-up on this skill's framing.** The top of `SKILL.md` describes the *old* stateless
> `@openai/codex-sdk` (`codex exec`). That dep was removed; the live adapter
> ([`codex.ts`](../../../packages/daemon/src/agent/providers/codex.ts)) drives a **long-lived
> `codex app-server` child over JSON-RPC** via `CodexAppServerClient`. Rate limits ride *that*
> transport — both a server→client notification and a client→server request — so the "no
> long-lived child / no requests" guidance does **not** apply here. See
> [`multitable/codex-adapter-architecture.md`](../multitable/codex-adapter-architecture.md).

## Where the data comes from

Two channels, both already in the generated protocol (`codex-protocol/`):

1. **Push** — the `account/rateLimits/updated` `ServerNotification`
   ([`ServerNotification.ts:70`](../../../packages/daemon/src/agent/providers/codex-protocol/ServerNotification.ts)):
   ```ts
   export type AccountRateLimitsUpdatedNotification = { rateLimits: RateLimitSnapshot };
   ```
2. **Pull** — the `account/rateLimits/read` `ClientRequest` (params `undefined`,
   [`ClientRequest.ts:81`](../../../packages/daemon/src/agent/providers/codex-protocol/ClientRequest.ts))
   → `GetAccountRateLimitsResponse`:
   ```ts
   export type GetAccountRateLimitsResponse = {
     rateLimits: RateLimitSnapshot;                                   // single-bucket back-compat view
     rateLimitsByLimitId: { [limitId: string]?: RateLimitSnapshot } | null;  // multi-bucket
   };
   ```

The payload, in both cases (`codex-protocol/v2/`, **generated — never hand-edit**):

```ts
export type RateLimitSnapshot = {
  limitId: string | null; limitName: string | null;
  primary: RateLimitWindow | null; secondary: RateLimitWindow | null;
  credits: CreditsSnapshot | null; planType: PlanType | null;
  rateLimitReachedType: RateLimitReachedType | null;
};
export type RateLimitWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
export type CreditsSnapshot = { hasCredits: boolean; unlimited: boolean; balance: string | null };
export type PlanType = "free" | "go" | "plus" | "pro" | … | "enterprise" | "unknown";
```

## The capture path

Add a `case 'account/rateLimits/updated'` to `handleNotification`
([`codex.ts:453`](../../../packages/daemon/src/agent/providers/codex.ts)), normalize the snapshot,
and call `cb.applyUsageLimits(...)`:

```ts
case 'account/rateLimits/updated': {
  const { rateLimits } = n.params as AccountRateLimitsUpdatedNotification;
  cb.applyUsageLimits(normalizeCodexLimits(rateLimits));
  return;
}

function normalizeCodexLimits(rl: RateLimitSnapshot): UsageLimitSnapshot {
  const windows: UsageLimitWindow[] = [];
  if (rl.primary)   windows.push({ label: rl.limitName ?? 'Primary',   usedPercent: rl.primary.usedPercent,   resetsAt: rl.primary.resetsAt,   windowDurationMins: rl.primary.windowDurationMins });
  if (rl.secondary) windows.push({ label: 'Secondary', usedPercent: rl.secondary.usedPercent, resetsAt: rl.secondary.resetsAt, windowDurationMins: rl.secondary.windowDurationMins });
  return {
    status: 'live',
    source: 'codex',
    windows,
    planType: rl.planType ?? null,
    creditsRemaining: rl.credits?.balance != null ? Number(rl.credits.balance) : null, // balance is a STRING
    capturedAt: Date.now(),
  };
}
```

For a value **before the first turn**, pull on provision: add
`getAccountRateLimits()` → `requireTransport().request<GetAccountRateLimitsResponse>('account/rateLimits/read', undefined)`
to `CodexAppServerClient`, call it once on warmup, normalize `.rateLimits`, and feed it through the
same `cb.applyUsageLimits(...)`.

And in the adapter's `capabilities` block: `usageLimits: true`.

## The gotcha that will silently eat this feature

`account/rateLimits/updated` is **account-scoped — it has no `threadId`**. But
`CodexAppServerClient.dispatchNotification`
([`codex-app-server/client.ts:160-176`](../../../packages/daemon/src/agent/providers/codex-app-server/client.ts))
reads `params.threadId` off every notification and **drops anything without one** (the comment at
L21-24 is explicit: "Non-thread-scoped notification (account/\*, configWarning, app/list/\*) …
dropped"). The per-thread `subscribe(threadId, listener)` fan-out (L272 / used at `codex.ts:307`)
can **never** deliver it.

**Fix:** add an account-listener channel to the client — e.g. `subscribeAccount(listener)` plus a
branch in `dispatchNotification` that routes `n.method.startsWith('account/')` to it instead of
dropping. Then the adapter registers one account listener (in warmup, not per-thread) and applies
the snapshot.

**Scope:** the snapshot is **account-wide, not per-thread** — it's the same for every Codex session.
Cache the latest on the adapter and fan it to *all* Codex `AgentSession`s (approximate per-session
attribution is fine; it matches codexbar). Don't try to attribute it to one thread.

## What Codex gives you that others don't

- **`primary` + `secondary` windows** (e.g. a short rolling window and a weekly one) — map both.
- **`planType`** (Codex plan tier) and **`credits`** (`balance` is a *string*) — surface in the
  popover header.
- **`rateLimitReachedType`** tells you *why* you're blocked (credits depleted vs usage cap) — useful
  for the alert copy, optional for the indicator.

## Don't

- **Don't hand-edit `codex-protocol/*`** — it's `ts-rs`-generated (`codex app-server generate-ts`).
  Consume the types; normalize in `codex.ts`.
- **Don't fold limits into `thread/tokenUsage/updated`** (`codex.ts:584`) — that's per-thread token
  accounting (cost), a different concern. Limits come on `account/rateLimits/*`.
