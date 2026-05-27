# Usage limits (rate limits)

How MultiTable surfaces Hermes' usage limits in the always-present per-session indicator. The
provider-agnostic build-out (normalized type, WS event, store, badge) lives in
[`docs/reference/USAGE_LIMITS.md`](../../../../docs/reference/USAGE_LIMITS.md) — **this file is the
Hermes-specific source + capture path only.**

## Status today: `capabilities.usageLimits = false`

**Hermes has no live limit feed over ACP.** Set `usageLimits: false` in the adapter's capabilities
so the UI hides the badge for Hermes sessions (graceful, no errors). This is the same posture as
`costUsd: false` ([`hermes.ts:139`](../../../packages/daemon/src/agent/providers/hermes.ts)).

Why there's nothing live to wire:

- ACP defines **no rate-limit RPC and no rate-limit `session/update` kind.** The closest is
  `usage_update` ([`hermes.ts:755-760`](../../../packages/daemon/src/agent/providers/hermes.ts),
  currently a no-op falling through to `default`) — but that's a **per-turn token-usage refresh**
  (context/token accounting), **not** subscription windows or reset countdowns. Don't mistake it
  for a limit feed.
- Per-turn token usage *is* available (`result.usage` →
  [`hermes.ts:408-413`](../../../packages/daemon/src/agent/providers/hermes.ts)), but tokens are
  **cost accounting, not limits**. Do **not** synthesize a "% used" from token counts — there's no
  window, no cap, no reset to anchor it to. That would be a fabricated number.
- The real limits are the **SuperGrok / X Premium+ subscription** quota, billed through Hermes'
  **xAI OAuth** integration (see [`reference/xai-grok-oauth.md`](xai-grok-oauth.md)). That lives on
  xAI's account/billing surface, not on the ACP wire.

## The out-of-band path (the template now exists — Grok shipped it)

Grok Build already ships this exact pattern in
[`grok-usage.ts`](../../../packages/daemon/src/agent/providers/grok-usage.ts) (xAI gRPC-web billing
RPC + `fetchUsageLimits` + the manager's event-driven refresh on turn-complete). Hermes is **blocked only on its credential
shape**: confirm what `~/.hermes/auth.json` stores and whether that xAI token authenticates against
the same `grok.com` billing RPC. Once confirmed, Hermes' `fetchUsageLimits` can largely reuse Grok's
fetch logic with a Hermes-specific credential reader, and `capabilities.usageLimits` flips to `true`.

The codexbar pattern: read the provider's own local credentials and call its account/billing API
directly, independent of any turn. For Hermes that means:

1. Read the OAuth token from **`~/.hermes/auth.json`** (the machine-wide credential `hermes login`
   writes; one per machine — see the OAuth reference).
2. Call xAI's account/usage endpoint for the SuperGrok subscription (verify the exact endpoint
   against a live token; xAI's billing is `x.ai/billing`, account-level).
3. Normalize the response into a `UsageLimitSnapshot` (`windows[]` with `usedPercent` + `resetsAt`,
   `planType` = the subscription tier) and return it from the optional adapter hook
   `fetchUsageLimits?(s)`.
4. The manager calls `fetchUsageLimits?` on every `turn-complete` (and on session open) and feeds
   the result through `applyUsageLimits` — the *same* normalized pipe Claude/Codex use. When this
   lands, flip `capabilities.usageLimits` to `true`.

This is **out of scope for v1** of the indicator. Document it; don't build it speculatively. If you
do wire it, keep it Hermes-only (its own creds path, its own endpoint) — don't share code with
Grok Build even though both are xAI (see [[feedback_separate_sdks]]).

## Don't

- **Don't set `usageLimits: true` until a real feed exists.** A `true` capability with no data
  shows an empty/"—" badge forever.
- **Don't derive "% used" from `result.usage` tokens.** Tokens ≠ subscription quota.
- **Don't reach into Grok Build's `~/.grok/` creds or copy its billing code.** Separate provider,
  separate path.
