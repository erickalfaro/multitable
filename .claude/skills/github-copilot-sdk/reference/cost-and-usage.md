# Cost and usage tracking

## Two events, two scopes

| Event | Scope | Typical fields |
|---|---|---|
| `assistant.usage` | Per LLM API call (one inside an agent loop turn) | `model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, duration, initiator, apiCallId, providerCallId, parentToolCallId, quotaSnapshots, copilotUsage` |
| `session.shutdown` | Cumulative for the entire session | `type, totalPremiumRequests, totalApiDurationMs, sessionStartTime, codeChanges, modelMetrics, currentModel` |

Plus an ephemeral context-window snapshot:

| Event | Scope | Fields |
|---|---|---|
| `session.usage_info` | Live snapshot during a turn | `tokenLimit, currentTokens, messagesLength` |

## Wiring per-turn cost

Mirror what the Codex adapter does: accumulate `assistant.usage.cost` and token counts as the turn progresses, then emit a `session:turn-result` when the loop ends (`session.idle`).

```ts
let turnCost = 0;
let turnTokensIn = 0;
let turnTokensOut = 0;
let turnCacheRead = 0;
let turnCacheCreate = 0;

const offUsage = session.on('assistant.usage', (e) => {
  const u = e.data;
  turnCost += u.cost ?? 0;
  turnTokensIn += u.inputTokens ?? 0;
  turnTokensOut += u.outputTokens ?? 0;
  turnCacheRead += u.cacheReadTokens ?? 0;
  turnCacheCreate += u.cacheWriteTokens ?? 0;
  cb.emitStateSnapshot();
});

const offIdle = session.on('session.idle', () => {
  cb.applyUsage({
    tokensIn: turnTokensIn,
    tokensOut: turnTokensOut,
    cacheCreationTokens: turnCacheCreate,
    cacheReadTokens: turnCacheRead,
    costUsd: turnCost,
  });
  cb.emitTurnResult({
    subtype: 'success',
    totalCostUsd: turnCost,
    usage: {
      inputTokens: turnTokensIn,
      outputTokens: turnTokensOut,
      cacheCreationInputTokens: turnCacheCreate,
      cacheReadInputTokens: turnCacheRead,
    },
    text: null,
  });
  // reset for the next turn
  turnCost = 0;
  turnTokensIn = 0;
  turnTokensOut = 0;
  turnCacheRead = 0;
  turnCacheCreate = 0;
});
```

## Cost field unit

The `cost` field on `assistant.usage` is documented as a number; **the units are not explicitly stated** in the public docs as of this writing. Treat it as USD by default (matches Claude SDK convention) but verify against a known billed call before depending on it. **If unit is uncertain at write time, hide the dollar row in the cost UI for Copilot sessions** — same rule we apply to Codex (`Usage` has no USD field at all there).

For BYOK sessions, `cost` is whatever the provider reports — typically USD for OpenAI/Anthropic, depends on Azure pricing for Azure provider.

## Quota lookups

Independent of per-turn usage, the SDK exposes:

```ts
// Via raw RPC (no high-level helper):
const quota = await client.rpc.sendRequest('account.getQuota', {});
// → AccountGetQuotaResult: { totalPremiumRequests, usedPremiumRequests, ... }
```

Useful for surfacing "X premium requests remaining" in the UI. Not needed for v1.

## Context-window utilization

`session.usage_info` fires throughout a turn with `{ tokenLimit, currentTokens, messagesLength }`. Wire it to a "context window: 14k / 200k" indicator so users can see compaction approaching. The session itself emits `session.compaction_start` / `session.compaction_complete` when it auto-compacts (controlled by `infiniteSessions: true` default).

## Cumulative session metrics

`session.shutdown` fires once when a session ends. Persist to MultiTable's per-session cost row:

```ts
session.on('session.shutdown', (e) => {
  const m = e.data;
  db.updateSessionMetrics(sessionId, {
    totalPremiumRequests: m.totalPremiumRequests ?? 0,
    totalApiDurationMs: m.totalApiDurationMs ?? 0,
    codeChanges: m.codeChanges ?? 0,
  });
});
```

Note that `session.shutdown` does NOT include a cumulative `cost` field — only `assistant.usage` carries cost, per call. To get a session total, sum `assistant.usage.cost` over the lifetime (which is exactly what the per-turn accumulator above does, just summed).

## Comparing across providers (in MultiTable's cost UI)

| Field | Claude SDK | Codex SDK | Copilot SDK |
|---|---|---|---|
| Per-turn cost USD | `result.total_cost_usd` | not surfaced | sum of `assistant.usage.cost` over turn (units unconfirmed) |
| Input tokens | `usage.input_tokens` | `usage.input_tokens` | `assistant.usage.inputTokens` |
| Output tokens | `usage.output_tokens` | `usage.output_tokens + reasoning_output_tokens` | `assistant.usage.outputTokens` |
| Cache read tokens | `usage.cache_read_input_tokens` | `usage.cached_input_tokens` | `assistant.usage.cacheReadTokens` |
| Cache create tokens | `usage.cache_creation_input_tokens` | not surfaced | `assistant.usage.cacheWriteTokens` |
| Reasoning tokens | not surfaced | `usage.reasoning_output_tokens` | (presumably included in `outputTokens`) |
| Per-call vs per-turn | per-turn (one event) | per-turn (one event) | **per-call** (multiple events per agent loop) |

The "per-call vs per-turn" difference is the gotcha: with Copilot, `assistant.usage` fires multiple times per `session.send`, once per LLM API call inside the agent loop. Don't display each one as a separate row — accumulate.
