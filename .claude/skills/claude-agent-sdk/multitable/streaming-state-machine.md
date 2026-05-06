# Streaming state machine

How `s.streamingText` and `s.streamingBlockIndex` interact across stream events.

## The two fields

From [`agent/types.ts`](../../../../packages/daemon/src/agent/types.ts):

```ts
streamingText: string;          // accumulated partial text, cumulative
streamingBlockIndex: number | null;   // index of the active text block, null when none
```

- `streamingText`: the cumulative buffer. We re-emit this whole string on every delta so the UI just renders it raw (the UI doesn't maintain its own buffer).
- `streamingBlockIndex`: which content block in the assistant message is currently streaming. Useful for "is text currently flowing?" — that's `streamingBlockIndex !== null`.

These together encode three states:

| `streamingText` | `streamingBlockIndex` | Meaning |
|---|---|---|
| `''` | `null` | Idle — no preview |
| non-empty | non-null | Live streaming — text is currently being produced |
| non-empty | `null` | Block ended but canonical message hasn't arrived; preview is on-screen but frozen |

The third state is intentional. We don't wipe the text the instant the block ends, because we'd flicker the UI for the brief gap before the canonical assistant message lands. We only wipe when:
1. The canonical message arrives (it has the full text anyway), or
2. The turn ends (`finally`).

## Transitions

[`agent/manager.ts:482-538`](../../../../packages/daemon/src/agent/manager.ts) (handleStreamEvent):

```
SDK event                        | streamingText  | streamingBlockIndex | emit
─────────────────────────────────┼────────────────┼─────────────────────┼───────────────────────
content_block_start (text)       | '' (reset)     | idx                 | assistant-delta ''
content_block_delta (text_delta) | += delta.text  | (unchanged)         | assistant-delta <text>
content_block_stop               | (unchanged)    | null                | (none)
message_stop                     | ''             | null                | assistant-delta ''
```

Then [`agent/manager.ts:639-650`](../../../../packages/daemon/src/agent/manager.ts) (canonical assistant arrival):

```
Canonical assistant message      | streamingText  | streamingBlockIndex | emit
─────────────────────────────────┼────────────────┼─────────────────────┼───────────────────────
assistant message arrives        | ''             | null                | assistant-delta ''
                                 |                |                     | + assistant-message <full>
```

And [`agent/manager.ts:354-378`](../../../../packages/daemon/src/agent/manager.ts) (finally — runs on success, error, abort):

```
End of turn (any reason)         | streamingText  | streamingBlockIndex | emit
─────────────────────────────────┼────────────────┼─────────────────────┼───────────────────────
finally                          | '' (if needed) | null (if needed)    | assistant-delta '' (if changed)
```

## Why three clearance points?

| Clearance | Catches |
|---|---|
| `message_stop` event | Normal turn-end with full SDK cooperation |
| Canonical assistant arrival | Stream wrapped up but `message_stop` may have been swallowed |
| `finally` block | Abort / network drop / iterator threw — neither of the above fired |

The `finally` is the safety net. It is the **only** clearance point that always runs, regardless of how the turn ends. Don't move clearance logic out of `finally` — see [`pitfalls.md`](../pitfalls.md) for the bug pattern this fixes.

## Tool-input deltas (Codex only)

Codex streams tool input with similar deltas, surfaced via `tool-delta` events. We track them in `s.streamingToolPayload` (analogous to `streamingText`) but Codex-only — Claude's `input_json_delta` events arrive but we don't render them today.

If you ever wire up Claude tool-input previews:
- Add a parallel field `s.streamingToolInput: { idx, json } | null`.
- Handle `content_block_start (tool_use)` / `content_block_delta (input_json_delta)` / `content_block_stop`.
- Clear in the same three places.

## Reasoning deltas (Codex only)

Same pattern with `s.streamingReasoning` for Codex reasoning blocks. Claude's `thinking_delta` events would map to a similar field if we wanted to show thinking in real-time — currently we just let the canonical thinking block render once it lands.

## Multi-block messages

A single assistant message can have multiple text blocks separated by tool calls:

```
Block 0: "I'll start by reading the file."  (text)
Block 1: tool_use {Read: ...}
Block 2: tool_result (in next user message)
Block 3: "OK, I see the issue. Let me fix it."  (text)
Block 4: tool_use {Edit: ...}
...
```

Each block has its own `(start, [deltas...], stop)` cycle. Between blocks, `streamingBlockIndex` may transiently go null. That's expected. The canonical assistant message at the end carries all blocks.

## Subagent streams

Subagent stream events have `parent_tool_use_id !== null`. We **do not** clear the parent's `streamingText` when subagent stream events arrive — they're a separate stream. [`agent/sdkAdapter.ts`](../../../../packages/daemon/src/agent/sdkAdapter.ts) routes them with the parent id preserved on the resulting `Message`, but the streamingText fields on `AgentSession` track only the parent stream.

This is a deliberate simplification — subagent live previews aren't surfaced in our UI today. If you want subagent streaming, add a parallel set of fields keyed by `parent_tool_use_id` (or by subagent id) and emit a different event family.

## Common mistakes

- **Resetting `streamingText` on every `content_block_start`.** That wipes prior block text. We do reset, but only because we replace it with empty before the new block streams. Keep this exact behavior — don't try to be clever.
- **Forgetting to emit on the final clear.** UI relies on receiving `assistant-delta { text: '' }` to drop the preview. Skipping that emission leaves stale text on screen.
- **Coupling streamingText to `currentTurn`.** They are independent. `currentTurn` says "the agent is working on a turn." `streamingText` says "this preview is currently visible." A turn can be running with no streaming text (waiting on a tool result). A streaming text can briefly outlive the iterator (theoretically — finally clears it).
- **Clearing in too many places.** Three is enough. More clearances make race conditions harder to reason about. Stick to: `message_stop`, canonical arrival, `finally`.
