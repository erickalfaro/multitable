---
name: openai-codex-sdk
description: Authoritative reference for working on MultiTable's OpenAI Codex SDK integration (`@openai/codex-sdk`). Trigger when the user mentions the Codex SDK, `Codex`, `Thread`, `runStreamed`, `ThreadEvent`, `ThreadItem`, sandbox/approval policy, `~/.codex/sessions`, `resumeThread`, `codex exec`, plan-mode for Codex, or modifying anything under `packages/daemon/src/agent/providers/codex.ts` or `packages/daemon/src/transcripts/codexParser.ts`.
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
---

# OpenAI Codex SDK reference for MultiTable

Pinned SDK version: **`@openai/codex-sdk@0.128.0`** (see `node_modules/@openai/codex-sdk/package.json`). Every type signature and behavior in this skill is quoted from the local `dist/index.d.ts` / `dist/index.js` so it matches what we have installed — re-verify after any SDK upgrade.

This skill is **strictly Codex-only**. Do not import Claude Agent SDK concepts (`canUseTool`, `onElicitation`, hooks, plan mode, `AskUserQuestion`) into Codex code or reasoning. Codex has none of those primitives. For Claude SDK work see [`claude-agent-sdk/SKILL.md`](../claude-agent-sdk/SKILL.md).

## The one fact that shapes everything

The Codex TypeScript SDK is a **stateless wrapper around `codex exec --experimental-json`**. Every `runStreamed()` / `run()` call:

1. Spawns a fresh `codex` child process.
2. Writes the prompt to its stdin.
3. **Closes stdin immediately** (no further input is possible).
4. Reads JSONL events from stdout until EOF.
5. Kills the child on completion / abort.

There is **no long-lived child** and **no host-side approval callback**. All approval / tool gating decisions are made in-process inside the spawned `codex` binary based on flags set at spawn time. This single fact is why `approvalPolicy` must be `'never'`, why there is no `canUseTool`, and why "intercepting a tool call before execution" is fundamentally not a thing in this SDK.

## Quick task → file map

| What you want to do | Read |
|---|---|
| Understand the `Codex` / `Thread` / option surface | [`reference/api-surface.md`](reference/api-surface.md) |
| Fix a streaming display bug, audit `item.updated` handling | [`reference/events-and-streaming.md`](reference/events-and-streaming.md) |
| Decide on sandbox / approval / "plan mode" semantics | [`reference/sandbox-approval-modes.md`](reference/sandbox-approval-modes.md) |
| Stop a turn mid-stream, or resume an aborted thread | [`reference/abort-and-resume.md`](reference/abort-and-resume.md) |
| Wire auth, env, baseUrl, MCP servers, web search | [`reference/auth-config-mcp.md`](reference/auth-config-mcp.md) |
| Use `outputSchema` for structured responses | [`reference/structured-output.md`](reference/structured-output.md) |
| Get oriented in `agent/providers/codex.ts` | [`multitable/codex-adapter-architecture.md`](multitable/codex-adapter-architecture.md) |
| Understand why we reconcile from disk after every turn | [`multitable/reconcile-and-jsonl.md`](multitable/reconcile-and-jsonl.md) |
| Diagnose a bug we've already seen | [`multitable/known-bugs.md`](multitable/known-bugs.md) + [`pitfalls.md`](pitfalls.md) |

## Decision tree: which lever to pull?

```
Need to BLOCK a tool call?
├── Block writes entirely?     ─── ThreadOptions.sandboxMode: 'read-only'
├── Block network in workspace? ─── ThreadOptions.networkAccessEnabled: false
├── Block paths outside cwd?   ─── do NOT add them to additionalDirectories
├── Block specific MCP tools?  ─── CodexOptions.config.mcp_servers.<name>.disabled_tools / enabled_tools
└── Block reactively?          ─── watch the event stream and ctrl.abort() on undesirable item.started

Need the agent to ASK the user a question?
└── NOT POSSIBLE in @openai/codex-sdk. There is no host-side prompt callback.
    The user-visible TUI "/plan" → "approve plan" flow is a TUI feature, not an SDK primitive.

Need to RUN code on a lifecycle event?
└── NOT POSSIBLE. There are no hooks. Watch ThreadEvent stream from your for-await loop.

Need to STOP a turn mid-stream?
└── Pass an AbortController.signal as TurnOptions.signal to runStreamed/run.
    The signal is forwarded to child_process.spawn; child gets SIGTERM.

Need to RESUME a prior conversation?
└── codex.resumeThread(threadId, options?) — id is the codex internal session_id
    (NOT a file path). Persisted at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.

Need PLAN mode (read-only thinking before execution)?
└── No SDK primitive. Approximate by spawning the thread with:
    sandboxMode: 'read-only'  +  modelReasoningEffort: 'high'
    Then resumeThread() with sandboxMode: 'workspace-write' to execute the plan.
```

## Four rules that get violated most

1. **`item.updated.item.text` is CUMULATIVE, not a delta.** Each update carries the *entire* accumulated body so far. Replace your in-flight buffer; do not append. The same applies to `command_execution.aggregated_output` and `mcp_tool_call.result`. This is the #1 cause of streaming-display corruption in our codebase.

2. **`approvalPolicy` MUST be `'never'`** (and is hardcoded as such in [`packages/daemon/src/agent/providers/codex.ts`](../../../packages/daemon/src/agent/providers/codex.ts)). Any other value (`'untrusted'`, `'on-request'`, `'on-failure'`) requires the codex binary to read approval responses on stdin — but the SDK closes stdin synchronously after writing the prompt. Other values will hang or auto-fail.

3. **Don't try to build a `canUseTool` equivalent.** There is no host-side hook. The interception layer is sandbox + abort, not callbacks. If a feature request asks "show the user the proposed command and let them approve" we can only do it *reactively* (watch `item.started` for `command_execution`, abort the turn, ask the user, start a new turn).

4. **Treat the on-disk JSONL as the source of truth, not the live event stream.** Codex flushes `~/.codex/sessions/.../rollout-*.jsonl` incrementally, and that file is the codex CLI's own log. Our daemon reconciles from it after every turn (see [`multitable/reconcile-and-jsonl.md`](multitable/reconcile-and-jsonl.md)) because the live event stream can drop items in edge cases.

## Three things the SDK does NOT have (so you can stop looking)

- **No `canUseTool`.** No host-side approval callback. Sandbox + abort is the only gate.
- **No `AskUserQuestion`, no `onElicitation`.** Not in the type union, not in the event stream, not on any item type. If you need user input mid-turn, abort and start a new turn.
- **No `hooks`, no `PreToolUse`/`PostToolUse`/`Notification` callbacks.** The only observability is the `ThreadEvent` async generator yielded by `runStreamed()`.

These names belong to the **Claude Agent SDK**. Don't paste them into Codex code.

## Ground-truth files

When in doubt about behavior, these are authoritative (in this order):

1. `node_modules/@openai/codex-sdk/dist/index.d.ts` — installed type defs.
2. `node_modules/@openai/codex-sdk/dist/index.js` — installed runtime (read this when types are vague, e.g. exact CLI flag emission).
3. [`packages/daemon/src/agent/providers/codex.ts`](../../../packages/daemon/src/agent/providers/codex.ts) — how MultiTable wires the SDK; load-bearing comments at the top of the file.
4. [`packages/daemon/src/transcripts/codexParser.ts`](../../../packages/daemon/src/transcripts/codexParser.ts) — JSONL → `Message[]` parser; the format we trust as "what really happened".
5. [Codex SDK README on GitHub](https://github.com/openai/codex/blob/main/sdk/typescript/README.md).
6. [Codex CLI reference](https://developers.openai.com/codex/cli/reference) and [config reference](https://developers.openai.com/codex/config-reference).

## Where this SDK lives in our codebase

```
packages/daemon/src/
├── agent/
│   ├── manager.ts                  ← dispatches by provider; for codex calls codexAdapter.runTurn()
│   ├── providers/
│   │   ├── codex.ts                ← THE Codex adapter; owns thread cache, event handling, reconcile
│   │   └── types.ts                ← AdapterCallbacks contract
│   └── types.ts                    ← AgentSession (provider: 'claude' | 'codex')
└── transcripts/
    └── codexParser.ts              ← reads ~/.codex/sessions/.../rollout-*.jsonl into Message[]
```

The manager itself is a Claude-shaped SDK orchestrator — when adding Codex behavior, the *only* file that should grow is `providers/codex.ts` and (for parsing) `transcripts/codexParser.ts`. The manager exposes a small `AdapterCallbacks` bag the adapter calls into.
