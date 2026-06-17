# CursorAdapter integration

`packages/daemon/src/agent/providers/cursor.ts` implements `ProviderAdapter`
(`name = 'cursor'`). Registered in `agent/manager.ts` as
`cursor: new CursorAdapter()`. The manager stays provider-agnostic; only the
adapter map + a hydration branch change.

## Turn loop (one-shot child)

`runTurn(s, text, ctrl, cb)`:

1. If `s.userMessages.length === 1` → `cb.maybeRenameFromFirstPrompt(text)`.
2. `buildCursorArgs({ mode: s.mode, model: s.model, resumeId: s.agentSessionId, cwd })`
   (`cursor-cli/args.ts`). Always `--print --output-format stream-json
   --stream-partial-output --trust`; `--resume <id>` when set; mode flag per
   `reference/modes.md`; `--model <id>` when set.
3. `runCursor(...)` (`cursor-cli/runner.ts`) spawns the resolved `cursor-agent`,
   inherits `process.env`, sets `cwd`, line-reads stdout → typed events. `ctrl`
   abort → `child.kill`.
4. Normalize events → callbacks (see `reference/protocol.md` table). Maintain
   per-turn buffers: `assistantText`, `reasoningText`, `Map<callId, toolMeta>`.
   - `system/init`: if `session_id !== s.agentSessionId` → `onSessionIdAssigned`.
   - `thinking/delta`: accumulate → `emitReasoningDelta`.
   - `assistant` additive piece: accumulate → `emitAssistantDelta`. Skip
     consolidated (`model_call_id`) lines for delta purposes (pitfalls #2).
   - `tool_call`: started → `tool_use` message + `setCurrentTool`; completed →
     `tool_result` message (render `result.success`/`result.rejected`) +
     `incrementToolCount` + `setCurrentTool(null)`.
   - `result`: `applyUsage` (tokens; `costUsd:0`), then push canonical reasoning
     + assistant `Message[]` (clear the live deltas with `emit*Delta('')`), then
     `emitTurnResult`, `emitStateSnapshot`.
5. On non-`success` result or child-exit-without-result → throw (manager emits
   `session:turn-error`). On auth failure emit an `auth` alert first.

There is **no per-session child pool** and **no `clientFor`** — each turn is
independent. `reset(s)` just drops any cached resume bookkeeping (the on-disk
chat persists regardless). No `shutdown()` needed (no long-lived child).

## Capabilities (rationale)

```
costUsd: false               // no USD in stream-json
usageLimits: false           // no live feed (reference/usage-limits.md)
planMode: 'native'           // --mode plan
perCallApproval: 'sandbox'   // mode/allowlist-gated; headless has no callback
userQuestion: 'unsupported'  // no AskUserQuestion event in headless mode
elicitation: false
subagents: 'none'
midTurnInput: false          // one-shot child; no mid-stream steering
byok: false                  // machine-wide Cursor login / CURSOR_API_KEY
hardSandbox: false           // --sandbox left at default in v1
hooks: 'none'
streamingDeltaSemantics: 'additive'
modelSwitchScope: 'per-turn' // fresh spawn each turn
thinkingEffort: 'unsupported'// effort is encoded in the model id
modes: [default(Agent), plan, ask, force(Run everything, danger)]
```

Default mode for new sessions = `force` (`db/store.ts` `initialMode`).
