# Cost tracking

Anthropic doc: https://docs.claude.com/en/api/agent-sdk/cost-tracking

## The big disclaimer

`SDKResultMessage.total_cost_usd` is a **client-side estimate** computed from prices bundled at SDK build time. It is NOT authoritative for billing. For real billing, use the [Usage and Cost API](https://docs.claude.com/en/api/usage-cost-api).

This matters in MultiTable's cost panel: we show estimates, not ground truth. If a user disputes a number, point them at platform.claude.com — never claim our number is the bill.

## Token sources

Two places carry usage:

1. **Per-message** on `SDKAssistantMessage.message.usage`:
   ```ts
   { input_tokens, output_tokens, cache_read_input_tokens?, cache_creation_input_tokens? }
   ```
2. **Per-turn** on `SDKResultMessage.usage` (aggregate across all assistant messages in the turn).

`SDKResultMessage.modelUsage` breaks down per model:
```ts
{
  [modelName]: {
    costUSD: number,
    inputTokens: number,
    outputTokens: number,
    cacheReadInputTokens: number,
    cacheCreationInputTokens: number,
  }
}
```

If your turn uses multiple models (e.g., Opus for the parent, Haiku for a subagent), `modelUsage` is the only way to see the breakdown.

## Cache tokens

Two distinct counters. Both reduce billed input but at different rates:

- `cache_creation_input_tokens` — first time a chunk is cached. **Charged at a higher rate** than regular input (the cache write cost).
- `cache_read_input_tokens` — subsequent reads from the cache. **Charged at a lower rate** than regular input.

To see actual cost benefit, compare `cache_read_input_tokens` against what those tokens would cost as fresh input. The SDK doesn't compute this for you — you'd need to know the model's pricing tiers.

## 1-hour cache TTL

By default, caches live for 5 minutes. To extend to 1 hour:

```bash
ENABLE_PROMPT_CACHING_1H=1 node ...
```

Tradeoff: higher write cost (longer-lived caches cost more to create), more reads benefit (longer hit window). Right for long-lived sessions; not for one-shot scripts.

## Counting tokens correctly

**Watch out for parallel tool calls.** When the model issues multiple tool calls in one assistant message, all of them share the same `message.id`. If you sum usage per assistant message, you'll double-count.

Pattern from MultiTable ([`tracker/`](../../../../packages/daemon/src/tracker/)):
```ts
const seenIds = new Set<string>();
let totalInput = 0, totalOutput = 0;

for (const msg of assistantMessages) {
  if (seenIds.has(msg.id)) continue;
  seenIds.add(msg.id);
  totalInput += msg.usage.input_tokens;
  totalOutput += msg.usage.output_tokens;
}
```

## How MultiTable surfaces cost

Three places:

1. **Live state snapshot** ([`agent/manager.ts:730-733`](../../../../packages/daemon/src/agent/manager.ts)): emits `state-snapshot` with current totals after each `result` message. UI subscribes via `session:state-updated` and renders in the cost panel.
2. **Per-turn result** ([`agent/manager.ts:723`](../../../../packages/daemon/src/agent/manager.ts)): emits `turn-result` with `{ subtype, totalCostUsd, usage, text }`.
3. **Transcript scan** (post-hoc): [`hooks/costParser.ts`](../../../../packages/daemon/src/hooks/costParser.ts) walks the JSONL to recompute totals from disk. Used for `/cost` and the cost-panel-on-load.

The "live" path and the JSONL-scan path can disagree by a few cents in edge cases — the SDK's in-memory aggregation occasionally rounds differently than our parser. Treat the JSONL scan as canonical.

## Codex sessions

Codex sessions don't populate USD cost (the SDK doesn't expose it). The cost row is hidden in the cost UI for Codex (`AgentSession.provider === 'codex'`). Token counts still populate.

## Common mistakes

- **Showing `total_cost_usd` as if it's the bill.** Add a "(estimate)" suffix or tooltip explaining.
- **Summing `result.total_cost_usd` across forked sessions twice.** Forks share early history; the SDK doesn't dedup. If you fork and resume, you'll bill the shared prefix in both.
- **Ignoring `cache_creation_input_tokens` thinking they're "free."** They cost more than regular input, not less. Cache reads are the cheap path.
