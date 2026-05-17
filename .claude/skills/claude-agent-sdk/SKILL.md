---
name: claude-agent-sdk
description: Authoritative reference for working on MultiTable's Claude Agent SDK integration (`@anthropic-ai/claude-agent-sdk`). Trigger when the user mentions the agent SDK, `query()`, streaming, permission modes, `canUseTool`, `AskUserQuestion`, elicitation, hooks, abort/stop, plan mode, sessions, subagents, MCP, or modifying anything under `packages/daemon/src/agent/` or `packages/daemon/src/hooks/`.
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
---

# Claude Agent SDK reference for MultiTable

Pinned SDK version: **`@anthropic-ai/claude-agent-sdk@0.2.119`** (see [`package.json`](../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json)). Type signatures in this skill are quoted from the local `sdk.d.ts` so they always match what we have installed — re-verify after any SDK upgrade.

This skill exists because MultiTable's daemon-side SDK integration has bitten us repeatedly on the same four things: streaming preview lifecycle, intercepting `AskUserQuestion`, knowing when a stream is active vs. completed, and stopping a turn mid-stream. Don't re-derive — read the relevant chapter below before changing `agent/manager.ts`, `hooks/permissionManager.ts`, or `hooks/elicitationManager.ts`.

## Quick task → file map

| What you want to do | Read |
|---|---|
| Understand the `query()` call we make | [`reference/query-and-options.md`](reference/query-and-options.md) |
| Add or fix streaming preview behavior | [`reference/streaming-and-lifecycle.md`](reference/streaming-and-lifecycle.md) + [`multitable/streaming-state-machine.md`](multitable/streaming-state-machine.md) |
| Add a permission mode toggle (plan / acceptEdits / etc.) | [`reference/permissions-modes.md`](reference/permissions-modes.md) |
| Intercept `AskUserQuestion` or any other interactive prompt | [`reference/canusetool-and-elicitation.md`](reference/canusetool-and-elicitation.md) + [`multitable/permission-and-elicitation-wiring.md`](multitable/permission-and-elicitation-wiring.md) |
| Add an SDK lifecycle hook (e.g. `Notification`, `PreCompact`) | [`reference/hooks.md`](reference/hooks.md) |
| Resume / fork / list sessions | [`reference/sessions.md`](reference/sessions.md) |
| Stop a turn mid-stream, or fix abort regressions | [`reference/abort-and-stop.md`](reference/abort-and-stop.md) |
| Add a custom MCP tool | [`reference/custom-tools-mcp.md`](reference/custom-tools-mcp.md) |
| Use subagents | [`reference/subagents.md`](reference/subagents.md) |
| Display or accumulate cost | [`reference/cost-tracking.md`](reference/cost-tracking.md) |
| Customize the system prompt or list slash commands | [`reference/system-prompts-slash-commands.md`](reference/system-prompts-slash-commands.md) |
| Find where event X is emitted / forwarded | [`multitable/event-map.md`](multitable/event-map.md) |
| Get oriented in the daemon's agent code | [`multitable/architecture.md`](multitable/architecture.md) |
| Touch the Codex provider | [`multitable/codex-provider-notes.md`](multitable/codex-provider-notes.md) |
| Diagnose a bug we've seen before | [`pitfalls.md`](pitfalls.md) |

## Decision tree: which lever to pull?

```
Need to BLOCK a tool call?
├── Always block, no UI? ─── Options.disallowedTools (static rule)
├── Block based on input shape (regex, file path)? ─── hooks.PreToolUse with permissionDecision: 'deny'
└── Ask the user every time? ─── canUseTool callback

Need to RUN code on a lifecycle event (turn start, tool result, compact, notification)?
└── Options.hooks  (NEVER for interactive UI gating; hooks should not block on user input)

Need the agent to ASK the user a structured question?
├── Built-in AskUserQuestion tool? ─── Intercept in canUseTool (toolName === 'AskUserQuestion')
└── MCP server elicitation/create? ─── onElicitation callback

Need to STOP the turn mid-stream?
├── From the daemon? ─── currentTurn.abortController.abort()
└── From the SDK directly? ─── Query.interrupt()  (we don't use this; we own the controller)

Need to RESUME a prior conversation?
├── Most recent? ─── Options.continue: true
├── Specific id? ─── Options.resume: claudeSessionId
└── Branch from a prior point? ─── Options.resume + Options.forkSession: true

Need PLAN mode (read-only thinking)?
└── Options.permissionMode: 'plan'  (reset per-turn, or call Query.setPermissionMode mid-stream)
```

## Three rules that get violated most

1. **The canonical assistant message is the source of truth, not the stream.** Streaming `assistant-delta` is a preview. Always clear streaming state in the `finally` block of the turn — never rely on `message_stop` alone, because the SDK may end the iterator before sending one (abort, network drop, error).

2. **`canUseTool` is the universal prompt-interception point** for *tools the agent decides to call*. `AskUserQuestion` is just a tool name routed through `canUseTool` — branch on `toolName === 'AskUserQuestion'` and translate the structured questions into UI prompts. Never auto-defer or auto-allow it; the prompt is the whole point.

3. **`onElicitation` is for MCP elicitation requests**, not the same channel as `canUseTool`. It's a separate Promise-returning callback for form/url-shaped requests from MCP servers. Wire it through `ElicitationManager`, not `PermissionManager`.

## Ground truth files

When in doubt about behavior, these are authoritative (in this order):

1. `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — the actual installed types.
2. [`packages/daemon/src/agent/manager.ts`](../../../packages/daemon/src/agent/manager.ts) — how MultiTable wires the SDK.
3. [`docs/reference/archive/SDK_MIGRATION_PLAN.md`](../../../docs/reference/archive/SDK_MIGRATION_PLAN.md) — historical migration notes; explains *why* certain choices exist.
4. The Anthropic public docs (URLs cited inside each reference file). Slower to update than the type defs; cross-check before trusting.
