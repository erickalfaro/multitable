# Events and streaming — `ThreadEvent` and `ThreadItem`

All shapes quoted from `node_modules/@openai/codex-sdk/dist/index.d.ts` (v0.128.0).

## The event union

```ts
type ThreadEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent
  | ThreadErrorEvent;

type ThreadStartedEvent = { type: "thread.started"; thread_id: string };
type TurnStartedEvent   = { type: "turn.started" };
type TurnCompletedEvent = { type: "turn.completed"; usage: Usage };
type TurnFailedEvent    = { type: "turn.failed";   error: { message: string } };
type ItemStartedEvent   = { type: "item.started";   item: ThreadItem };
type ItemUpdatedEvent   = { type: "item.updated";   item: ThreadItem };
type ItemCompletedEvent = { type: "item.completed"; item: ThreadItem };
type ThreadErrorEvent   = { type: "error"; message: string };

type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};
```

Quoted descriptions from the .d.ts JSDoc:

- `thread.started`: "Emitted when a new thread is started **as the first event**."
- `turn.started`: "Emitted when a turn is started by sending a new prompt to the model. A turn encompasses all events that happen while the agent is processing the prompt."
- `turn.completed`: "Emitted when a turn is completed. Typically right after the assistant's response."
- `turn.failed`: "Indicates that a turn failed with an error."
- `item.started`: "Emitted when a new item is added to the thread. **Typically the item is initially 'in progress'**."
- `item.updated`: "Emitted when an item is updated."
- `item.completed`: "Signals that an item has reached a terminal state—either success or failure."
- `error`: "Represents an unrecoverable error emitted directly by the event stream."

### What you can rely on

```
thread.started     (only first turn ever; resumed threads skip this)
turn.started
item.started   ┐
item.updated   ├ many of these per turn, multiple per item
item.completed ┘
…
turn.completed   (carries final Usage)            <— OR
turn.failed      (carries error.message; no usage) <— OR
error            (fatal stream error)
```

### What you can NOT rely on

- **`Usage` carries no USD field.** `total_cost_usd` does not exist. The MultiTable cost UI hides the dollar row for Codex sessions; do not reintroduce it.
- **`turn.completed` may not arrive** before the for-await loop ends if the spawn dies abnormally. Code defensively in your `finally` block.
- **`turn.failed` carries no `usage`.** Aborted / failed turns produce no usage record.
- **No fields linking items into subagents** (no `agent_id`, `agent_name`, or `parent_item_id`). See [GitHub issue #20979](https://github.com/openai/codex/issues/20979).

## The item union

```ts
type ThreadItem =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | TodoListItem
  | ErrorItem;

type AgentMessageItem = {
  id: string; type: "agent_message";
  /** Either natural-language text or JSON when structured output is requested. */
  text: string;
};
type ReasoningItem = { id: string; type: "reasoning"; text: string };

type CommandExecutionStatus = "in_progress" | "completed" | "failed";
type CommandExecutionItem = {
  id: string; type: "command_execution";
  command: string;
  /** Aggregated stdout AND stderr captured while the command was running. */
  aggregated_output: string;
  exit_code?: number;     // omitted while still running
  status: CommandExecutionStatus;
};

type FileUpdateChange = { path: string; kind: "add" | "delete" | "update" };
type FileChangeItem = {
  id: string; type: "file_change";
  changes: FileUpdateChange[];
  status: "completed" | "failed";   // emitted ONCE, after the patch
};

type McpToolCallStatus = "in_progress" | "completed" | "failed";
type McpToolCallItem = {
  id: string; type: "mcp_tool_call";
  server: string; tool: string; arguments: unknown;
  result?: { content: ContentBlock[]; structured_content: unknown };
  error?:  { message: string };
  status: McpToolCallStatus;
};

type WebSearchItem = { id: string; type: "web_search"; query: string };
type TodoListItem  = { id: string; type: "todo_list"; items: { text: string; completed: boolean }[] };
type ErrorItem     = { id: string; type: "error"; message: string };
```

## ⚠️ The cumulative-text rule (the #1 streaming bug)

`item.updated.item.text` carries the **entire accumulated body so far**, not a delta against the previous update. The same applies to:

- `command_execution.aggregated_output`
- `mcp_tool_call.result` / `error.message`

Treat `item.updated` payloads as a **replacement** for the current display state of `item.id`. **Do not append.** Appending is what produces "AAA → AAAAAA → AAAAAAAAA → ..."–style corrupted streaming displays.

In MultiTable, [`packages/daemon/src/agent/providers/codex.ts:417`](../../../../packages/daemon/src/agent/providers/codex.ts#L417-L420) (`updateAssistantDelta`) correctly forwards `item.text` as a replacement via `cb.emitAssistantDelta(item.text)`. The frontend handler at [`packages/web/src/App.tsx`](../../../../packages/web/src/App.tsx) treats the value as the new full body. **If you "optimize" this to send deltas, you must also update both ends — and you'll likely just reintroduce the bug.**

## Knowing when the stream is "active" vs "complete"

Active = inside the `for await (const event of events)` loop AND haven't seen `turn.completed` / `turn.failed` / `error`.

The cleanest pattern (mirrors what [`packages/daemon/src/agent/providers/codex.ts:101-148`](../../../../packages/daemon/src/agent/providers/codex.ts#L101-L148) does):

```ts
let didFinish = false;
try {
  const { events } = await thread.runStreamed(text, { signal: ctrl.signal });
  for await (const event of events) {
    handleEvent(event);
    if (event.type === 'turn.completed' || event.type === 'turn.failed') {
      didFinish = true;
    }
  }
  // Loop ended. If didFinish === false, the spawn died without a terminal event.
  scheduleReconcile();   // best-effort: read the on-disk JSONL for any items we missed
} catch (err) {
  // turn.failed / error events are thrown via handleEvent; abort signal also throws.
  scheduleReconcile();
  throw err;
}
```

Pseudocode invariants:

1. **A clean turn always ends the for-await loop.** Either you saw a terminal event, or you got an exception. Never both.
2. **`turn.completed` is the only place `Usage` arrives.** If you don't see one, you have no usage to report.
3. **`item.completed` is the canonical "this item is final" marker.** Use its payload as the source of truth for that item; replace any in-flight preview.

## Live preview state to clear on completion

For each in-flight `item.updated`-driven preview, you must clear it in two places to avoid stuck UI:

1. On the matching `item.completed` for that item — clear the per-item preview slot **before** pushing the canonical message (avoids a one-frame duplicate where both the preview and the final card are visible).
2. In your turn-level `finally` block — wipe any leftover preview unconditionally so an abort or non-terminal exit doesn't leak state into the next turn.

[`packages/daemon/src/agent/providers/codex.ts:329-358`](../../../../packages/daemon/src/agent/providers/codex.ts#L329-L358) does (1); the manager's `finally` does (2) at [`packages/daemon/src/agent/manager.ts:357-366`](../../../../packages/daemon/src/agent/manager.ts#L357-L366).

## Item ids are not globally unique

The SDK's `item.id` (e.g. `item_0`, `item_1`) is a **per-spawn counter**. Every fresh `codex exec` run starts at `item_0` again, so turn 2 of the same thread collides with turn 1. **Don't use `item.id` as a primary key across turns.**

MultiTable mints canonical ids of the form `codex:{threadId}:t{turnIndex}:{kind}:{seq}` that match what [`packages/daemon/src/transcripts/codexParser.ts`](../../../../packages/daemon/src/transcripts/codexParser.ts) computes from the JSONL — so the live event stream and the on-disk reconcile produce identical ids and id-based dedupe works on both paths. See [`multitable/reconcile-and-jsonl.md`](../multitable/reconcile-and-jsonl.md).
