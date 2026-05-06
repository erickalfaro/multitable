# Codex provider notes

For deep Codex SDK details, see the sibling skill: `.claude/skills/openai-codex-sdk/SKILL.md`. This file covers what's specific about MultiTable's Codex wiring and what's shared / different vs. Claude.

## Provider abstraction

[`agent/providers/types.ts`](../../../../packages/daemon/src/agent/providers/types.ts):

```ts
export interface ProviderAdapter {
  runTurn(s: AgentSession, text: string, ctrl: AbortController, cb: AdapterCallbacks): Promise<void>;
  reset?(s: AgentSession): void;
}
```

`AdapterCallbacks` ([`agent/manager.ts:389-462`](../../../../packages/daemon/src/agent/manager.ts)) is the bag the manager passes in — adapters call back into it instead of emitting directly. This lets Claude (which lives inline in the manager) and Codex (which lives in `providers/codex.ts`) share the same WS event surface.

`s.provider` is `'claude' | 'codex'`. Dispatch is one branch in `agent/manager.ts:sendTurn`.

## What's Claude-only

These features live in `agent/manager.ts` and don't apply to Codex:

- `canUseTool` — Codex SDK doesn't expose a host-side approval callback. Codex uses `approvalPolicy: 'never'` hardcoded in `CodexAdapter.getThread`.
- `onElicitation` — Codex doesn't have MCP elicitation flow.
- `Options.hooks` — no equivalent in Codex.
- `permissionMode` — Codex sandbox config is via `sandboxMode: 'workspace-write'` + `additionalDirectories` + `networkAccessEnabled`, not the `PermissionMode` enum.
- `total_cost_usd` — Codex's `Usage` doesn't carry it. The cost-row UI hides for Codex sessions.

## What's shared

These flow through `AdapterCallbacks` and emit the same WS events for both providers:

- `assistant-delta` (live text preview)
- `assistant-message` (canonical)
- `tool-event` (canonical tool result)
- `user-message`
- `turn-result` (cost/usage subset)
- `state-snapshot` (cost/state panel)
- `state-changed`

So the UI doesn't need to branch on provider for the basic chat — it just renders messages.

## Codex-specific WS events

Some events exist for Codex only (Claude doesn't currently surface them):

- `tool-delta` — live tool input preview while Codex is composing a tool call
- `reasoning-delta` — live reasoning text while Codex is thinking
- `reconciled` — emitted after the post-stream reconciliation pass
- `message-rekeyed` — emitted when an optimistic ID is replaced by a canonical one

If we ever want these for Claude, the wiring exists — just emit through `AdapterCallbacks` instead of inline.

## Reconciliation

Codex CLI flushes its session JSONL (`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<thread_id>.jsonl`) **slightly after** the stream closes. Reading immediately after `runStreamed` returns can miss messages.

The adapter handles this with `RECONCILE_DELAY_MS = 250` ([`providers/codex.ts:50`](../../../../packages/daemon/src/agent/providers/codex.ts)) and a debounced reconcile that:

1. Reads the JSONL fresh.
2. Diffs against in-memory `s.messages`.
3. Rekeys optimistic user message IDs to canonical ones.
4. Broadcasts any items the live stream missed.
5. Emits `cb.emitReconciled()` so the UI can sync.

Don't lower the delay below 250ms — file-system flush timing varies and shorter waits start dropping messages.

## Canonical IDs

Codex IDs follow the pattern `codex:{threadId}:t{turnIndex}:{kind}:{seq}` ([`providers/codex.ts:28-32`](../../../../packages/daemon/src/agent/providers/codex.ts)). This deterministic shape lets the live stream and the JSONL parse produce identical IDs, so dedup works without extra coordination.

## Adding a third provider

Pattern:

1. New file `agent/providers/<name>.ts` implementing `ProviderAdapter`.
2. Add a parser under `transcripts/` if the provider has on-disk persistence.
3. Add a dispatch branch in `agent/manager.ts:sendTurn`.
4. Add `<name>` to the `AgentSession.provider` union in `agent/types.ts`.
5. Re-export from `agent/providers/index.ts`.

Use the Codex adapter as the model — it's smaller and more self-contained than the inline-Claude path.

## Don't move Claude into a provider file

Tempting, but the manager and "Claude adapter" are tightly coupled because Claude's flow needs:
- Direct access to `permissionManager` and `elicitationManager` (which the manager owns)
- Direct event emission (the lifecycle hooks fire side effects on `AgentSession`)
- Watchdog timer (5-min no-progress) integrated with permission/elicitation pending state

Pulling that out into a `claude.ts` adapter would require either passing the managers into the adapter (leaky) or duplicating `AdapterCallbacks` to expose all of it (defeats the abstraction). Treat the inline path in `manager.ts` as Claude's adapter.
