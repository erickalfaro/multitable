# Streaming events and turn lifecycle

This is the chapter to read when fixing a bug that looks like:

- "the assistant text is duplicated / scrambled / missing chunks"
- "the composer unlocked too early / too late"
- "the user's next message disappeared into the previous turn"
- "the streaming preview never clears"

## The model: push-only events, three terminator signals

`session.send({ prompt })` returns a `messageId` immediately. **Everything else is event-driven.** The session is an event broker, not an iterable. Subscribe with:

```ts
const off = session.on('assistant.message_delta', (e) => {
  buffer += e.data.deltaContent;       // ADDITIVE — see below
});
// later:
off();
```

There are **three completion signals** with different meanings:

| Signal | Persisted? | Meaning |
|---|---|---|
| `assistant.turn_end` | yes | One LLM call finished. The agent loop may continue (next call → tool → next call). **NOT safe to send next user message.** |
| `session.task_complete` | yes | The model itself emitted a "task is done" signal. Optional; only fires if the model decides. Autopilot mode nudges the model toward emitting this. |
| `session.idle` | **no — ephemeral** | The agent loop is fully ended. **THIS is when the composer unlocks and the next user message can be sent.** |

`session.sendAndWait` waits on `session.idle`. Mirror it in custom code.

## Streaming text deltas — additive, not cumulative

`SessionConfig.streaming: true` enables delta events. Three flavors, all additive:

```ts
// Each event carries a CHUNK to APPEND. NOT the full accumulated text.
'assistant.message_delta':   { deltaContent: string }    // user-visible message text
'assistant.reasoning_delta': { deltaContent: string }    // model's reasoning trace
'assistant.streaming_delta': { deltaContent: string }    // raw token-level (lower level)
'tool.execution_partial_result': { partialOutput: string }  // streaming tool output
```

This is **the opposite of Codex** (`item.updated.item.text` is cumulative — replace your buffer). If you copy the codex adapter's delta-handling code into a Copilot adapter, you will get this wrong. The pattern:

```ts
let live = '';
const offDelta = session.on('assistant.message_delta', (e) => {
  live += e.data.deltaContent;
  cb.emitAssistantDelta(live);   // forward growing live preview to the chat UI
});

const offFinal = session.on('assistant.message', (e) => {
  // CANONICAL message — replace your live buffer with this.
  // Even with streaming on, this event still fires and carries the full content.
  cb.emitAssistantMessage([{ id, ts, kind: 'assistant', text: e.data.content, ... }]);
  cb.emitAssistantDelta('');     // clear the live preview slot
  live = '';
});
```

Why replace, not just stop appending: deltas can have whitespace/formatting drift versus the canonical message. The model may emit a final cleanup pass that's slightly different from the concatenation of deltas.

## Complete event taxonomy (high-signal subset)

Source: `nodejs/src/generated/session-events.ts` (~60 variants). All events share `{ type, data, id, timestamp, parentId, agentId? }`. Grouped by domain:

### Session lifecycle
| Event | Data | Meaning |
|---|---|---|
| `session.start` | `{ context, version, model }` | Created |
| `session.resume` | `{ eventCount, pendingWork, model }` | `resumeSession()` finished |
| `session.idle` *ephemeral* | — | **Loop fully ended; safe to send next** |
| `session.error` | `{ category, code, message, stack }` | Recoverable error |
| `session.shutdown` | `{ type, codeChanges, modelMetrics, ... }` | Session terminated |
| `session.title_changed` *ephemeral* | `{ title }` | Title updated |
| `session.info`, `session.warning` | `{ category, message, url }` | Info |
| `session.model_change` | `{ cause, reasoningEffort }` | Model switched |
| `session.mode_changed` | `{ from, to }` | Plan-mode toggle (CLI-driven) |
| `session.plan_changed` | `{ op }` | Plan file edited |
| `session.workspace_file_changed` | `{ path }` | Agent wrote a file |
| `session.handoff` | `{ repository, summary }` | Handoff to remote |
| `session.truncation` | `{ tokens, messages }` | Conversation compacted |
| `session.snapshot_rewind` *ephemeral* | `{ targetEvent }` | Rewound |
| `session.context_changed` | `{ cwd }` | cwd changed |
| `session.usage_info` | `{ tokens, cost? }` | Context-window snapshot |
| `session.compaction_start`, `session.compaction_complete` | — | Compaction |
| `session.task_complete` | — | Optional model "done" signal |
| `session.remote_steerable_changed` | `{ enabled }` | Remote steering toggle |

### User
| Event | Data | Meaning |
|---|---|---|
| `user.message` | `{ mode, attachments, content }` | Echo of your `send()` |
| `user.pending_messages_modified` | `{ queue }` | Steering queue changed |

### Assistant
| Event | Data | Meaning |
|---|---|---|
| `assistant.turn_start` | — | One LLM call begins |
| `assistant.intent` | `{ classification }` | Intent detected |
| `assistant.reasoning` | `{ content }` | Final reasoning block |
| `assistant.reasoning_delta` *ephemeral* | `{ deltaContent }` | Reasoning chunk |
| `assistant.message_start` | — | Message starts |
| `assistant.streaming_delta` *ephemeral* | `{ deltaContent }` | Raw token chunk |
| `assistant.message_delta` *ephemeral* | `{ deltaContent }` | Message text chunk |
| `assistant.message` | `{ content, toolRequests }` | **Canonical final message for this turn** |
| `assistant.turn_end` | — | One LLM call done (NOT loop done) |
| `assistant.usage` | `{ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, duration, ... }` | Per-call usage |
| `model.call_failure` | `{ error }` | Model API call failed |
| `agent.abort` | `{ reason: 'user initiated', ... }` | Loop aborted |

### Tools
| Event | Data | Meaning |
|---|---|---|
| `tool.user_requested` | `{ toolCallId }` | User-initiated tool invocation |
| `tool.execution_start` | `{ toolName, args, toolCallId }` | Tool starting (full args, not streamed) |
| `tool.execution_partial_result` *ephemeral* | `{ partialOutput }` | Streaming tool output (additive!) |
| `tool.execution_progress` | `{ progress }` | Progress update |
| `tool.execution_complete` | `{ result, status }` | Final tool result |
| `tools.updated` | `{ tools }` | Tool catalog refreshed |

### Permissions / prompts
| Event | Data | Meaning |
|---|---|---|
| `permission.requested` | `{ kind, toolCallId? }` | Tool needs approval (paired with `onPermissionRequest`) |
| `permission.completed` | `{ result }` | Resolved |
| `user_input.requested` | `{ question, choices?, allowFreeform }` | Agent asked the host (paired with `onUserInputRequest`) |
| `user_input.completed` | `{ answer }` | Resolved |
| `elicitation.requested` | `{ message, requestedSchema, mode, source, url? }` | Form/URL request (paired with `onElicitationRequest`) |
| `elicitation.completed` | `{ result }` | Resolved |

### Sub-agents / skills / hooks / MCP
| Event | Meaning |
|---|---|
| `subagent.{started,completed,failed,selected,deselected}` | Sub-agent lifecycle |
| `skill.invoked`, `skills.loaded` | Built-in skill flow |
| `hook.start`, `hook.end` | Per-hook execution trace |
| `sampling.{requested,completed}` | MCP sampling |
| `mcp_oauth.required`, `mcp_oauth.completed` | MCP OAuth flow |
| `mcp_servers.loaded`, `mcp_server_status.changed` | MCP connectivity |
| `external_tool.{requested,completed}` | Host-defined tool dispatch |
| `command.{queued,execute,completed}`, `commands.changed` | Slash command flow |
| `auto_mode_switch.{requested,completed}` | Rate-limit fallback toggling |
| `capabilities.changed` | Capabilities toggled |
| `exit_plan_mode.{requested,completed}` | Plan mode exit flow |
| `background_tasks.changed` | Background queue |
| `custom_agents.updated` | Custom agent catalog |
| `extensions.loaded` | Extensions discovered |

## Recommended turn-tracking state machine

```
idle
  └── on send() → in_flight
                     ├── on assistant.message_delta → render live preview (ADDITIVE append)
                     ├── on assistant.message       → store canonical, clear preview
                     ├── on tool.execution_start    → setCurrentTool(toolName)
                     ├── on tool.execution_partial_result → live tool preview
                     ├── on tool.execution_complete → push tool_use+tool_result, clear preview
                     ├── on session.error           → record, but don't transition yet
                     ├── on agent.abort             → mark aborted
                     └── on session.idle            → idle (ALWAYS clean up here in a finally-equivalent)
```

The Copilot equivalent of "always clear streaming state in `finally`" (which is the rule for Claude/Codex) is: **always do final cleanup in the `session.idle` handler.** Belt-and-braces: also do it in your local `try/catch` around the `send()` call in case the connection breaks before `idle` fires.

## Polling: don't

There is no polling endpoint, no `getTurnStatus()`. Everything is push. The only "queue state" surfacing is the `user.pending_messages_modified` event for steering/enqueue tracking. If you ever feel the need to poll, you've forgotten to subscribe to `session.idle`.

## What's NOT delivered when a turn aborts

- No `assistant.usage` may fire if the abort interrupted before the LLM call completed (mirrors Codex).
- `assistant.message` may not fire if the abort lands mid-stream — you'll have a live `assistant.message_delta` accumulator and no canonical replacement. **Reconcile from the highest-numbered checkpoint in `~/.copilot/session-state/<id>/checkpoints/` if you need the canonical text.**
- `session.idle` **does** still fire after abort — use it as the universal cleanup signal regardless of success/failure.
