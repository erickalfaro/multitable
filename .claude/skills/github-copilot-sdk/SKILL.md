---
name: github-copilot-sdk
description: Authoritative reference for working on MultiTable's GitHub Copilot SDK integration (`@github/copilot-sdk`). Trigger when the user mentions the Copilot SDK, `CopilotClient`, `CopilotSession`, `session.send`, `sendAndWait`, `session.idle`, `assistant.message_delta`, `onPermissionRequest`, `onUserInputRequest`, `onElicitationRequest`, plan / autopilot / chat mode for Copilot, session.abort, `~/.copilot/session-state`, or adding/modifying a Copilot provider under `packages/daemon/src/agent/providers/`.
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
---

# GitHub Copilot SDK reference for MultiTable

Pinned SDK package: **`@github/copilot-sdk`** (Node ≥ 20.0.0 per `nodejs/package.json` `engines`; the README says 18+ but the engines field is the real floor). Repo: <https://github.com/github/copilot-sdk>, TypeScript source under `nodejs/`. The SDK is in **public preview**. Type signatures and behavior in this skill are quoted from the upstream `nodejs/src/*` source — **re-verify against the locally installed `node_modules/@github/copilot-sdk/dist/*.d.ts` after any version bump.**

This skill is **strictly Copilot-only**. Do **not** import Claude Agent SDK names (`query`, `canUseTool`, `permissionMode: 'plan'`, `Query.interrupt`, `forkSession`) or Codex SDK names (`Thread`, `runStreamed`, `approvalPolicy`, `sandboxMode`, `additionalDirectories`) into Copilot code or reasoning. Each SDK has its own primitives — see [`multitable/claude-codex-comparison.md`](multitable/claude-codex-comparison.md) for the side-by-side.

## The two facts that shape everything

1. **The SDK is a JSON-RPC client driving a long-lived `copilot` CLI child process.** `new CopilotClient()` + `client.start()` spawns the bundled CLI in server mode and opens a `vscode-jsonrpc` `MessageConnection` over stdio (or TCP). Multiple `CopilotSession`s multiplex inside that one child. This is **architecturally different** from Codex (per-turn `codex exec` spawn) and Claude (in-process `query()` async-iterable). One client = one CLI child = many sessions.

2. **`session.send()` returns immediately with a `messageId`. All progress is push-only via `session.on(eventType, handler)`.** There is no AsyncIterable, no Web ReadableStream, no Node `EventEmitter`. Subscribing returns an `unsubscribe` function — there is no `off()`. Drop the unsubscribe and you've leaked a handler for the session's lifetime.

## Quick task → file map

| What you want to do | Read |
|---|---|
| Understand `CopilotClient` / `CopilotSession` / `SessionConfig` | [`reference/api-surface.md`](reference/api-surface.md) |
| Add or fix streaming display, decide when a turn is "done" | [`reference/streaming-and-lifecycle.md`](reference/streaming-and-lifecycle.md) |
| Intercept `AskUserQuestion`-equivalents (3 channels!) | [`reference/prompts-and-interception.md`](reference/prompts-and-interception.md) |
| Stop a turn mid-stream, or resume a prior session | [`reference/abort-and-resume.md`](reference/abort-and-resume.md) |
| Implement plan / chat / auto mode behavior | [`reference/modes-and-permissions.md`](reference/modes-and-permissions.md) |
| Wire auth (GitHub OAuth, BYOK, env vars) and config | [`reference/auth-and-config.md`](reference/auth-and-config.md) |
| Find where sessions live on disk; wire MCP servers | [`reference/persistence-and-mcp.md`](reference/persistence-and-mcp.md) |
| Add lifecycle hooks (PreToolUse, PostToolUse, etc.) | [`reference/hooks.md`](reference/hooks.md) |
| Display cost / token usage | [`reference/cost-and-usage.md`](reference/cost-and-usage.md) |
| Surface usage / rate limits (premium-request quota) in the per-session indicator | [`reference/usage-limits.md`](reference/usage-limits.md) |
| Plan the MultiTable adapter (not yet built) | [`multitable/integration-plan.md`](multitable/integration-plan.md) |
| Map Copilot concepts to existing Claude/Codex adapters | [`multitable/adapter-architecture.md`](multitable/adapter-architecture.md) |
| Translate a Claude or Codex idea into Copilot terms | [`multitable/claude-codex-comparison.md`](multitable/claude-codex-comparison.md) |
| Diagnose a known footgun before changing code | [`pitfalls.md`](pitfalls.md) |

## Decision tree: which lever to pull?

```
Need to BLOCK a tool call?
├── Always block, no UI?           ─── hooks.onPreToolUse → { permissionDecision: 'deny' }
├── Allow without prompting?       ─── defineTool({ ..., skipPermission: true })  OR  onPreToolUse → 'allow'
├── Ask the user every time?       ─── onPreToolUse → { permissionDecision: 'ask' }  → falls through to onPermissionRequest
└── Approve everything (dev)?      ─── onPermissionRequest: approveAll  (built-in)

Need the agent to ASK the user something?
├── Free-text / multiple choice?    ─── onUserInputRequest  (UserInputRequest)
├── Structured form / URL?          ─── onElicitationRequest  (ElicitationContext)
└── Permission for a side effect?   ─── onPermissionRequest  (PermissionRequest)
                                      ALL THREE are mandatory to wire (or the agent hangs).

Need to RUN code on a lifecycle event?
└── SessionConfig.hooks.onSessionStart / onUserPromptSubmitted /
    onPreToolUse / onPostToolUse / onSessionEnd / onErrorOccurred

Need to STOP a turn mid-stream?
└── await session.abort()      (separate method; NO AbortSignal on send())
    The session is still usable — call send() again.

Need to KILL the session entirely?
└── await session.disconnect() (RPC session.destroy; the object is dead)

Need to RESUME a prior conversation?
└── await client.resumeSession(sessionId, config)
    REQUIRES the same sessionId you supplied on createSession.
    BYOK keys must be re-supplied; not persisted.

Need PLAN mode / AUTOPILOT / interactive?
└── NATIVE since 1.0.5: send({ prompt, agentMode: 'interactive'|'plan'|'autopilot' }) per send.
    Plan's execute gate = SessionConfig.onExitPlanModeRequest. (Pre-1.0.5 recipes in
    reference/modes-and-permissions.md are superseded — see pitfalls #12.)
```

## Five rules that get violated most

1. **`session.idle` — and ONLY `session.idle` — means the agent loop is fully done.** `assistant.turn_end` is the end of *one* LLM call; the agent loop typically chains many turns (tool → model → tool → model → final). Do not unlock the composer or send the next user message on `assistant.turn_end`. This was bug #1 in Claude/Codex too — the symptom in Copilot is "user message disappears" because it was steered into a turn that wasn't actually finished.

2. **Streaming deltas are ADDITIVE, not cumulative.** `assistant.message_delta.deltaContent` is the chunk to **append** to your buffer. This is the **opposite** of Codex (`item.updated.item.text` is the cumulative body). Mixing the two strategies corrupts the live preview. Always replace your live buffer with `assistant.message.content` when the canonical message arrives, to absorb any whitespace drift.

3. **There are THREE separate "ask the user" channels** — `onPermissionRequest`, `onUserInputRequest`, `onElicitationRequest`. Each is a distinct callback on `SessionConfig`. The agent **blocks indefinitely** waiting on whichever one you forgot to wire (no host-side timeout). `onPermissionRequest` is the only one that's *mandatory at construction* — but if you skip the other two, the agent silently hangs the first time it tries to use them. Wire all three for production.

4. **`onPermissionRequest` is mandatory.** Omitting it doesn't disable permission gating — it crashes when the agent first tries to use a tool. Use the exported `approveAll` for daemon/headless use, or thread it through MultiTable's `PermissionManager`.

5. **Abort is a method, not a signal.** `send()` does **not** accept an `AbortSignal`. Cancel via `await session.abort()`, which fires `agent.abort` and *still* fires `session.idle` afterwards. The session remains valid — you can `send()` again on the same instance.

## Three things to NOT confuse with each other

- **`session.ui.{confirm,select,input,elicitation}`** is **host → agent** (you push a UI request *into* the agent's context). 
- **`onUserInputRequest` / `onElicitationRequest`** is **agent → host** (the agent asks *you* something). 
- **`onPermissionRequest`** is also agent → host but for tool gating specifically (`shell`, `write`, `read`, `mcp`, `url`, `custom-tool`, `memory`, `hook`).

Mixing them up is a recipe for a hung session and a confused chat UI.

## Ground-truth files

When in doubt about behavior, these are authoritative (in this order):

1. **The locally installed types**, once we install the SDK: `node_modules/@github/copilot-sdk/dist/index.d.ts` (and `dist/types.d.ts`, `dist/session.d.ts`).
2. **Generated event taxonomy** (currently upstream-only): `nodejs/src/generated/session-events.ts` — ~60 typed event variants.
3. **Generated RPC method list** (upstream): `nodejs/src/generated/rpc.ts`.
4. **Upstream sources** when the local types are vague: `nodejs/src/client.ts`, `nodejs/src/session.ts`, `nodejs/src/types.ts`. Use `gh api -H "Accept: application/vnd.github.raw" repos/github/copilot-sdk/contents/nodejs/src/<file>` for raw reads — GitHub's blob view truncates files >1000 lines.
5. **Official docs**: `https://github.com/github/copilot-sdk/tree/main/docs` and `https://docs.github.com/en/copilot/how-tos/copilot-sdk/sdk-getting-started`.
6. **Public-preview blog post** (concept overview, not API surface): `https://github.blog/news-insights/company-news/build-an-agent-into-any-app-with-the-github-copilot-sdk/`.

## Where this SDK lives in our codebase

**The integration is LIVE** (SDK 1.0.5, exact-pinned in `packages/daemon/package.json`; shipped 2026-07):

```
packages/daemon/src/
├── agent/providers/copilot.ts      ← CopilotAdapter: singleton CopilotClient (lazy start()),
│                                      per-MT-session CopilotSession cache, native agentMode
│                                      per send, all three ask channels + onExitPlanModeRequest
└── transcripts/copilotParser.ts    ← parses ~/.copilot/session-state/<id>/events.jsonl → Message[]
                                       (NOT checkpoints — see pitfalls #19)
```

Plus registration in `agent/manager.ts` (`copilot: new CopilotAdapter(permManager, elicitManager)`),
hydration branches in `manager.ts` / `api/sessions.ts`, catalog wiring (`providers/baselines.ts`
COPILOT_BASELINE + `discovery.ts` discoverCopilot via a short-lived `client.listModels()` probe),
and the AddAgentModal entry. **Read [`pitfalls.md`](pitfalls.md) #31 first** — the live-verified
1.0.5 gotchas (effort hard-fail + retry, `workingDirectory` naming, missing re-exports,
reasoningText duplication, rich PermissionRequest union, no `autoStart`).

The big architectural difference vs. Codex: Copilot has a **long-lived child** shared across sessions, so the adapter owns the client lifecycle (one `start()` on first use, `stop()` on daemon shutdown), not fresh per turn. [`multitable/integration-plan.md`](multitable/integration-plan.md) is the historical plan (kept for rationale; the shipped adapter deviates where 1.0.5 made things native — see its status header).
