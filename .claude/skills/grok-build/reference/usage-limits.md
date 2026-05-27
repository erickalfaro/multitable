# Usage limits (rate limits)

How MultiTable surfaces Grok Build's usage limits in the always-present per-session indicator. The
provider-agnostic build-out (normalized type, WS event, store, badge) lives in
[`docs/reference/USAGE_LIMITS.md`](../../../../docs/reference/USAGE_LIMITS.md) — **this file is the
Grok-Build-specific source + capture path only.** Keep it isolated from Hermes even though both are
xAI/ACP (see [[feedback_separate_sdks]]).

## Status: `capabilities.usageLimits = true` — fetched OUT-OF-BAND

`grok agent stdio` has **no** limit feed (no rate-limit RPC, no rate-limit `session/update` kind;
the `usage_update` case in `grok.ts` is a no-op; `_meta` tokens are *cost*, not limits — don't
synthesize a "% used" from them). So we get limits the codexbar way: read Grok's own credentials and
hit xAI's billing API directly, independent of any turn. Lives in
[`grok-usage.ts`](../../../packages/daemon/src/agent/providers/grok-usage.ts); the adapter's
`fetchUsageLimits()` just calls `fetchGrokUsage()`, and the manager refreshes it event-driven — on
every `turn-complete` and once when a session opens (not on a timer).

### The wire contract (mirrored from codexbar's `GrokWebBillingFetcher`)

- **Credential**: `~/.grok/auth.json` is a **map keyed by scope URL**. Prefer the OIDC (SuperGrok)
  entry (`https://auth.x.ai::…`), fall back to the legacy session entry
  (`https://accounts.x.ai/sign-in`); the bearer is the entry's **`key`** field; `auth_mode: 'oidc'`
  → "SuperGrok". (NOT `GROK_CODE_XAI_API_KEY` — that's an xAI *API* key, which the consumer billing
  RPC doesn't accept.)
- **Endpoint**: `POST https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` — a
  **Connect/gRPC-web** RPC, **not REST, not `api.x.ai`**. Headers: `Authorization: Bearer <key>`,
  `Origin: https://grok.com`, `Referer: https://grok.com/?_s=usage`,
  `Content-Type: application/grpc-web+proto`, `x-grpc-web: 1`, `x-user-agent: connect-es/2.1.1`.
  Body is the **5-byte empty gRPC-web frame** `[0,0,0,0,0]`.
- **Response**: gRPC-web framed protobuf. There's no generated proto, so (like codexbar) we
  brute-force-scan the data frame for a percent float (0–100, field path ending in #1, shallowest
  wins) and a varint unix-seconds reset timestamp. One window only `{usedPercent, resetsAt}`.

### Caveats

- The protobuf scan is a **heuristic** — validate the number against grok's own usage display; the
  field-path rule may need tightening if xAI changes the response.
- gRPC status 16 / HTTP 401-403 → token expired → `grok login`. We fail safe to `null` (badge shows
  "—"), never garbage.
- Still **Grok-only** — its own `~/.grok/` creds + its own module. Hermes is a separate provider;
  do not share `grok.ts` code with it even though both are xAI.
