# Streaming and turn lifecycle

Anthropic doc: https://docs.claude.com/en/api/agent-sdk/streaming-vs-single-mode

## The two-track model

A single Claude turn produces **two parallel streams** of information:

1. **Token-level previews** (`stream_event` messages, only emitted when `includePartialMessages: true`). Cumulative text deltas while the model is generating.
2. **Canonical messages** (`assistant`, `user`, `result` messages). Final, structured, the source of truth.

These are not redundant. The preview is for UI feedback; the canonical message is what you persist, dedupe, and bill. They are also not synchronized — the canonical assistant message lands shortly after the preview's `message_stop`, but you can't assume they arrive in any particular interleaving with tool calls.

**Rule:** treat preview text as ephemeral display state. The moment the canonical assistant message arrives (or the iterator returns), throw the preview away.

## SSE events under `stream_event`

`SDKPartialAssistantMessage` (sdk.d.ts:2970):

```ts
{
  type: 'stream_event',
  event: BetaRawMessageStreamEvent,  // discriminated union
  parent_tool_use_id: string | null,
  uuid: UUID,
  session_id: string,
  ttft_ms?: number,                  // time to first token, on first delta
}
```

`event.type` is one of:

| `event.type` | Meaning | Carries |
|---|---|---|
| `message_start` | Top of the assistant turn | `message.id`, `message.usage` |
| `content_block_start` | A new block is starting | `index`, `content_block: { type: 'text' \| 'tool_use' \| 'thinking' }` |
| `content_block_delta` | Token chunk for the active block | `index`, `delta: { type: 'text_delta', text } \| { type: 'input_json_delta', partial_json } \| { type: 'thinking_delta', thinking }` |
| `content_block_stop` | Active block complete | `index` |
| `message_delta` | Top-of-message metadata update | `delta`, `usage` |
| `message_stop` | Whole assistant message done | (no payload) |

Tool-input deltas (`input_json_delta`) stream the **JSON arguments** the model is composing for a tool call. We don't currently render these for Claude (only Codex has tool-input previews) — see [`agent/manager.ts:482-538`](../../../../packages/daemon/src/agent/manager.ts) for what we do consume.

## MultiTable's stream-event handling

[`agent/manager.ts:482-538`](../../../../packages/daemon/src/agent/manager.ts) (`handleStreamEvent`):

| event.type | Action | Lines |
|---|---|---|
| `content_block_start` (text only) | Init `s.streamingText = ''`, set `s.streamingBlockIndex = idx`, emit `assistant-delta` with `''` | 492-508 |
| `content_block_delta` (text_delta) | Append `delta.text` to `s.streamingText`, emit `assistant-delta` with cumulative text | 510-519 |
| `content_block_stop` | Mark `s.streamingBlockIndex = null`, **leave `s.streamingText` intact** so the preview stays on screen | 521-527 |
| `message_stop` | Wipe both fields | 529-533 |

Why leave the text up after `content_block_stop`? Because the canonical assistant message hasn't arrived yet — a brief gap with empty text would flicker the UI. The text is replaced by the canonical message when it lands ([`agent/manager.ts:639-650`](../../../../packages/daemon/src/agent/manager.ts)) or wiped by the finally block on turn end (see below).

## The end-of-turn invariant

The turn is over when `for await (const msg of query())` returns. Not when `message_stop` arrives, not when the result message lands — when the iterator returns.

[`agent/manager.ts:354-378`](../../../../packages/daemon/src/agent/manager.ts) is the load-bearing `finally` block:

```ts
} finally {
  if (stuckTimer) clearTimeout(stuckTimer);
  s.currentTurn = null;
  // Safety: turn ended (success or error) — wipe any leftover streaming
  // text so the UI doesn't keep showing a stale partial.
  if (s.streamingText !== '' || s.streamingBlockIndex !== null) {
    s.streamingText = '';
    s.streamingBlockIndex = null;
    this.emit('assistant-delta', { sessionId, text: '' });
  }
  this.emit('tool-delta', { sessionId, payload: null });
  this.emit('reasoning-delta', { sessionId, text: '' });
  if (s.state === 'running') {
    s.state = 'stopped';
    this.emit('state-changed', { sessionId, state: 'stopped' as ProcessState });
  }
  s.lastActivity = Date.now();
  // ... db update
  this.emit('turn-complete', { sessionId });
}
```

This is what guarantees the preview is cleared **even if** `message_stop` never arrives (network drop, abort, error mid-stream). Don't move the streaming-clear logic out of `finally` — that's how we get stuck previews.

## Active vs completed: how to tell

For "is the agent currently working on a turn?", check `s.currentTurn !== null`. This stays true from `sendTurn()` start until the `finally` block clears it.

For "is text streaming right now?", check `s.streamingBlockIndex !== null` AND `s.streamingText !== ''`. The block-index goes null at `content_block_stop` while the text persists; that combination means "preview is visible but not accumulating."

**Do not** equate "stream active" with "turn running." Many turn segments aren't streamed text — tool calls, tool results, thinking blocks. Use the right field for the question.

## Event lifecycle in order

For a typical turn (text answer + one tool call + result):

```
emit  state-changed { state: 'running' }              // sendTurn start
emit  user-message  { ... optimistic prompt ... }
─── for await msg of query() ─────────────────────
SDK   system.init                                       → caches claudeSessionId
SDK   stream_event content_block_start (text)          → emit assistant-delta ''
SDK   stream_event content_block_delta (text_delta)... → emit assistant-delta '...'
SDK   stream_event content_block_stop                  → preview text stays; index=null
SDK   stream_event message_stop                        → wipe streaming fields
SDK   assistant message  (text + tool_use blocks)      → emit assistant-message
SDK   user message  (tool_result block)                → emit tool-event
SDK   stream_event ... (next assistant message preview)
SDK   assistant message  (final text)                  → emit assistant-message
SDK   result success                                   → emit turn-result
─── iterator returns ───────────────────────────────
finally:
emit  assistant-delta '' (if needed)
emit  state-changed { state: 'stopped' }
emit  turn-complete
```

See the full SDK-event-to-WS-event mapping in [`../multitable/event-map.md`](../multitable/event-map.md).

## Common mistakes

- **Treating `content_block_stop` as turn-end.** It's per-block. A turn can have many blocks (text + tool_use + text + tool_use + text). Use the `result` message and/or iterator return.
- **Clearing streaming state on every assistant message.** Subagent messages have `parent_tool_use_id` set; if you clear on those you wipe the parent's preview. Only clear on the parent stream's events — check `parent_tool_use_id == null`.
- **Buffering the cumulative text yourself.** The SDK gives you deltas; **we** maintain the cumulative buffer in `s.streamingText`. Re-emitting just the delta to the WS client would force the UI to maintain its own buffer — currently the contract is "the daemon emits cumulative text; UI just renders."
