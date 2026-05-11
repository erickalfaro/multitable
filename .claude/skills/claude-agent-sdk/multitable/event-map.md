# Event map

The complete table: SDK message → manager `emit(...)` → WS rebroadcast → web handler. This is the answer to "where does event X come out the other side?"

## SDK → manager → WS

| SDK input | Manager emit | WS broadcast type | Manager line | server.ts line |
|---|---|---|---|---|
| `system.init` | (caches `claudeSessionId`) | — | 552-616 | — |
| `system.notification` | `notification` | `session:notification` | 552-616 | — |
| `system.compact_boundary` | `status` | `session:status` | 552-616 | 390 |
| `system.api_retry` | `alert` | `session:alert` | 618-628 | 382 |
| `system.task_*` | `task-event` | `session:task-event` | 618-628 | 395 |
| `assistant` (canonical) | `assistant-message` | `session:assistant-message` | 630-650 / 649 | 288 |
| `user` (tool_result + text) | `tool-event` (for tool_result) / `user-message` (for text) | `session:tool-event` / `session:user-message` | 656-702 / 672 / 315 | 319 / 315 |
| `result` | `turn-result` + `state-snapshot` | `session:turn-result` + `session:state-updated` | 704-735 / 723 / 733 | 324 / 358 |
| `stream_event content_block_start (text)` | `assistant-delta` (empty) | `session:assistant-delta` | 492-508 / 498 | 292 |
| `stream_event content_block_delta (text_delta)` | `assistant-delta` (cumulative) | `session:assistant-delta` | 510-519 / 518 | 292 |
| `stream_event content_block_stop` | (clears `streamingBlockIndex` only) | — | 521-527 | — |
| `stream_event message_stop` | `assistant-delta` (empty) | `session:assistant-delta` | 529-533 / 532 | 292 |
| `rate_limit_event` | `alert` | `session:alert` | 618-628 | 382 |
| `auth_status` | `alert` | `session:alert` | 618-628 | 382 |
| `tool_progress` | `tool-progress` | `session:tool-progress` | 618-628 | 400 |

## Manager-driven events (not from SDK)

These fire from the manager itself, not from an SDK message:

| Trigger | Emit | WS broadcast | Line |
|---|---|---|---|
| `sendTurn` start | `state-changed` (running) | `process-state-changed` | 220 |
| `sendTurn` start | `user-message` (optimistic prompt) | `session:user-message` | 233 |
| `sendTurn` end (finally) | `state-changed` (stopped) | `process-state-changed` | 369 |
| `sendTurn` end (finally) | `assistant-delta` (empty, if needed) | `session:assistant-delta` | 362 |
| `sendTurn` end (finally) | `tool-delta` (null) | `session:tool-delta` | 365 |
| `sendTurn` end (finally) | `reasoning-delta` (empty) | `session:reasoning-delta` | 366 |
| `sendTurn` end (finally) | `turn-complete` | `session:turn-complete` | 377 |
| `sendTurn` error catch | `tool-event` (system error msg) | `session:tool-event` | 343 |
| `sendTurn` error catch | `turn-error` | `session:turn-error` | 345 |
| `sendTurn` error catch | `state-changed` (errored) | `process-state-changed` | 346 |

## Hook-driven events

`makeHooks` in [`agent/manager.ts:1195-1439`](../../../../packages/daemon/src/agent/manager.ts) fires these:

| Hook | Emit | WS broadcast | Line |
|---|---|---|---|
| `PreToolUse` | `state-snapshot` (currentTool set) | `session:state-updated` | 1196-1204 |
| `PostToolUse` | `state-snapshot` (toolCount++) | `session:state-updated` | 1206-1217 |
| `Notification` | `alert` | `session:alert` | 1256-1276 |
| `SubagentStart` / `SubagentStop` | `state-snapshot` | `session:state-updated` | 1236-1254 |
| `SessionEnd` | `session-ended` | (broadcast) | 1282-1291 |
| `PreCompact` / `PostCompact` | `status` | `session:status` | 1388-1419 |
| `TaskCreated` / `TaskCompleted` | `alert` | `session:alert` | 1324-1369 |
| `PostToolUseFailure` / `StopFailure` / `PermissionDenied` | `alert` | `session:alert` | 1293-1322 / 1371-1386 / 1309-1322 |

## Permission/elicitation events

From [`hooks/permissionManager.ts`](../../../../packages/daemon/src/hooks/permissionManager.ts) and [`hooks/elicitationManager.ts`](../../../../packages/daemon/src/hooks/elicitationManager.ts):

| Trigger | Emit (on the manager) | WS broadcast |
|---|---|---|
| New permission prompt | `permission:prompt` | `permission:prompt` |
| Permission resolved (responded) | `permission:resolved` | `permission:resolved` |
| Permission timed out | `permission:expired` | `permission:expired` |
| New elicitation prompt | `elicitation:prompt` | `session:elicitation:prompt` |
| Elicitation resolved | `elicitation:resolved` | `session:elicitation:resolved` |
| Elicitation expired | `elicitation:expired` | `session:elicitation:expired` |

WS rebroadcast happens in [`server.ts:250-260`](../../../../packages/daemon/src/server.ts) for elicitations and in similar handlers for permissions.

## Codex provider events

[`agent/providers/codex.ts`](../../../../packages/daemon/src/agent/providers/codex.ts) routes through `AdapterCallbacks` ([`agent/manager.ts:389-462`](../../../../packages/daemon/src/agent/manager.ts)):

| Codex event | AdapterCallback | Emit | WS broadcast |
|---|---|---|---|
| `thread.started` | `onSessionIdAssigned` | `session-updated` | `session:updated` |
| `item.started` (assistant) | `emitAssistantDelta` | `assistant-delta` | `session:assistant-delta` |
| `item.updated` (assistant) | `emitAssistantDelta` | `assistant-delta` | `session:assistant-delta` |
| `item.completed` (assistant) | `emitAssistantMessage` | `assistant-message` | `session:assistant-message` |
| `item.*` (tool/reasoning) | `emitToolDelta` / `emitReasoningDelta` | `tool-delta` / `reasoning-delta` | `session:tool-delta` / `session:reasoning-delta` |
| `turn.completed` | `emitTurnResult` | `turn-result` | `session:turn-result` |
| (post-stream reconcile) | `emitReconciled` | `reconciled` | `session:reconciled` |
| (post-stream rekey) | `emitMessageRekeyed` | `message-rekeyed` | `session:message-rekeyed` |

## WS inbound messages (UI → daemon)

| Type | Routed to | File |
|---|---|---|
| `subscribe` / `unsubscribe` | `WsClientState.subscribedProcess` | `pty/stream.ts` |
| `session:send` | `agentManager.sendTurn` | `pty/stream.ts:251-293` |
| `pty-input` / `pty-resize` | `PtyManager` (commands/terminals only) | `pty/stream.ts` |
| `permission:respond` | `permissionManager.respond` | `pty/stream.ts` / `server.ts` |
| `permission:answer-question` | `permissionManager.respondAskQuestion` | `pty/stream.ts` / `server.ts` |
| `elicitation:respond` | `elicitationManager.respond` | `pty/stream.ts` / `server.ts` |

## Quick lookups

- **"Where does the streaming preview clear?"** — `assistant-delta` with empty `text`. Three sources: `message_stop` event ([`manager.ts:529-533`](../../../../packages/daemon/src/agent/manager.ts)), canonical assistant arrival ([`manager.ts:644-646`](../../../../packages/daemon/src/agent/manager.ts)), turn-end finally ([`manager.ts:359-362`](../../../../packages/daemon/src/agent/manager.ts)).
- **"Where does an AskUserQuestion become a UI prompt?"** — `permission:prompt` event with `kind: 'ask-question'` from [`permissionManager.ts:313-319`](../../../../packages/daemon/src/hooks/permissionManager.ts).
- **"Where does a tool result become a chat bubble?"** — `tool-event` from [`manager.ts:672`](../../../../packages/daemon/src/agent/manager.ts), parsed in `web/.../ToolCallCard.tsx`.

## Single-delivery rule

`pty-output` events are sent **directly** to the subscribed client in [`pty/stream.ts handleSubscribe`](../../../../packages/daemon/src/pty/stream.ts), not via the broadcast path. Don't accidentally broadcast them too — there's a load-bearing comment about a double-delivery bug from before this rule was enforced.

Session events (`session:*`) are broadcast via `broadcastForProcess` so all clients (e.g., multiple browser tabs) see them. That's correct.
