---
name: hermes-grok
description: Authoritative reference for working on MultiTable's Hermes (xAI Grok) provider, driven by `hermes acp` over line-delimited JSON-RPC (Agent Client Protocol). Trigger when the user mentions Hermes, the Hermes adapter, ACP, `hermes acp`, Grok / grok-4.3, xAI OAuth, `session/prompt`, `session/update`, `session/request_permission`, `~/.hermes/`, the `/reasoning` slash command, or modifying anything under `packages/daemon/src/agent/providers/hermes.ts`, `packages/daemon/src/agent/providers/hermes-acp/`, or `packages/daemon/src/transcripts/hermesParser.ts`.
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
---

# Hermes (xAI Grok) provider reference for MultiTable

There is **no pinned SDK**. Hermes is not an npm package — it's an external agent binary (`hermes`, a Python app: `python -m acp_adapter.entry`) that MultiTable drives as a long-lived child over **line-delimited JSON-RPC 2.0 on stdio**, speaking the **Agent Client Protocol (ACP)**. The version is whatever `hermes` is on the operator's `PATH`. Every behavior in this skill is quoted from our own transport/client/adapter code (the authoritative wire contract for *us*) and the Hermes/xAI docs cited inline — re-verify against a running `hermes acp` after any upstream Hermes release.

This skill is **strictly Hermes-only**. Do not import Claude Agent SDK concepts (`query()`, `canUseTool` as an SDK callback, `onElicitation`, SDK `hooks`, `permissionMode`, `AskUserQuestion`) or Codex SDK concepts (`Thread`, `runStreamed`, `sandboxMode`, cumulative-text rule) into Hermes code or reasoning. Hermes' surface is ACP, and it differs from both. For Claude see [`claude-agent-sdk/SKILL.md`](../claude-agent-sdk/SKILL.md); for Codex see [`openai-codex-sdk/SKILL.md`](../openai-codex-sdk/SKILL.md).

## The one fact that shapes everything

Hermes is an **ACP agent behind a long-lived stdio child**, and **one child is spawned per project working directory — not one per daemon**.

Why per-cwd (the single most surprising design choice): Hermes' ACP adapter does *not* propagate the per-session `cwd` into the agent's self-perception or its context-file discovery. Both read the child's own `os.getcwd()` (and `TERMINAL_CWD` for the terminal tool). A single shared child therefore cannot be correct for more than one project — it would load the wrong `AGENTS.md` / `CLAUDE.md` / `.cursorrules` and lie about "where am I." So [`HermesAdapter.clientFor(cwd)`](../../../packages/daemon/src/agent/providers/hermes.ts) pools a `HermesAcpClient` (→ a `hermes acp` child) keyed by resolved project cwd.

This single fact is why there's a `Map<string, HermesAcpClient>` (not a singleton), why `shutdown()` loops over every client, why `resolveCwd()` exists and never returns empty, and why a session that moved projects needs the cwd-correct child.

## Quick task → file map

| What you want to do | Read |
|---|---|
| Understand the ACP wire protocol (initialize / authenticate / session lifecycle / `session/update` kinds) | [`reference/acp-protocol.md`](reference/acp-protocol.md) |
| Wire or debug xAI Grok OAuth, model ids, auth-state alerts | [`reference/xai-grok-oauth.md`](reference/xai-grok-oauth.md) |
| Touch reasoning-effort plumbing or the `/reasoning` prefix | [`reference/reasoning-effort.md`](reference/reasoning-effort.md) |
| Know which Hermes slash-commands matter to us (and which are out of scope) | [`reference/slash-commands.md`](reference/slash-commands.md) |
| Get oriented in `agent/providers/hermes.ts` + the adapter contract | [`multitable/adapter-architecture.md`](multitable/adapter-architecture.md) |
| Fix a permission-prompt bug (approvals silently denied, etc.) | [`multitable/permission-wiring.md`](multitable/permission-wiring.md) |
| Diagnose duplicate messages after resume / the replay flood | [`multitable/hydration-and-replay.md`](multitable/hydration-and-replay.md) |
| Scan known bugs before a PR | [`pitfalls.md`](pitfalls.md) |

## Decision tree: which lever to pull?

```
Need to BLOCK / approve a tool call?
└── Hermes sends `session/request_permission` (a JSON-RPC SERVER-request).
    HermesAdapter.handleAcpPermission → PermissionManager.requestFromSdk →
    UI prompt. You return a SELECTED optionId or CANCELLED. There is no
    static disallow list and no sandbox enum we set — Hermes owns its own
    sandbox; we only broker the approve/deny prompt. See permission-wiring.md.

Need the agent to ASK the user a free-form question mid-turn?
└── NOT SUPPORTED. capabilities.userQuestion === 'unsupported',
    elicitation === false. No ACP channel for it today. Don't invent one.

Need to RUN code on a lifecycle event (hooks)?
└── NOT SUPPORTED. capabilities.hooks === 'none'. Observability is the
    `session/update` notification stream only; watch it in handleNotification.

Need to STOP a turn mid-stream?
└── client.cancel(hermesSessionId) sends the `session/cancel` NOTIFICATION
    (no response). The pending `session/prompt` resolves with
    stopReason: 'cancelled'. Wired off ctrl.signal 'abort' in runTurn.

Need to RESUME a prior conversation?
└── client.loadSession(agentSessionId, cwd) → ACP `session/load` (we use
    load, NOT the unstable `session/resume`). Hermes then REPLAYS history
    as session/update notifications — see hydration-and-replay.md.

Need to change reasoning depth?
└── Prepend `/reasoning <level>\n\n` to the prompt body, ONLY when the
    effort changed (lastSentEffort cache). Hermes persists the level on the
    ACP session. 'max' (a Claude-only tier) is dropped. See reasoning-effort.md.

Need PLAN mode?
└── capabilities.planMode === 'simulated'. ACP has no native plan-mode RPC
    today. `modes` are ADVISORY and passed through verbatim; the adapter
    does NOT translate them and keeps the same session id across flips.
```

## Four rules that get violated most

1. **ACP deltas are ADDITIVE; the StreamBuffer boundary wants CUMULATIVE.** `agent_message_chunk` / `agent_thought_chunk` each carry a *fresh piece* of text to append (per the ACP spec). The adapter accumulates into `buffers.assistantText` / `buffers.reasoningText` and emits the **running total** via `cb.emitAssistantDelta(buffers.assistantText)`. This is the *opposite* of Codex's "payload is already cumulative, replace don't append" rule — do not copy Codex's delta handling here. Append to the buffer, emit the buffer.

2. **The permission response shape is a nested literal.** Return `{ outcome: { outcome: 'selected', optionId } }` or `{ outcome: { outcome: 'cancelled' } }`. The *inner* `outcome` string (`'selected'` / `'cancelled'`) is the discriminator in Hermes' agent-side Pydantic union — **not** `'allowed'`/`'denied'`, **not** a flat `{ outcome: 'selected' }`. Returning the wrong shape silently coerces every approval to a deny (this was the bug fixed in #20). See [`multitable/permission-wiring.md`](multitable/permission-wiring.md).

3. **`session/load` floods replay; you must dedupe.** Hermes schedules `_replay_session_history` *after* `session/load` returns, re-emitting every persisted user/assistant/tool message as `session/update`. We already hydrated those from disk via `parseHermesSession`. The adapter sleeps 500ms post-load before the caller subscribes (most replay lands with no listener and is dropped) **and** drops any `tool_call`/`tool_call_update` whose `toolCallId` is already in `s.messages` (`isHistoricalToolId`). Don't remove either guard. See [`multitable/hydration-and-replay.md`](multitable/hydration-and-replay.md).

4. **One child per cwd, lazy, and the cache poisons on error.** Never reintroduce a daemon-wide singleton client. On a turn throw, `runTurn` deletes the cached `{hermesSessionId, mode}` entry *and* the `lastSentEffort` entry so the next turn re-loads from Hermes' `state.db` and re-sends the effort prefix. Don't reuse a cached session id after a throw.

## Three things Hermes does NOT have (so you can stop looking)

- **No USD cost.** `capabilities.costUsd === false`; `applyUsage` is always called with `costUsd: 0` and `emitTurnResult` with `totalCostUsd: 0`. The dollar row is hidden for Hermes sessions. Don't derive USD from tokens.
- **No host-brokered filesystem / terminal.** We deliberately advertise `clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }`. Hermes runs its own tools in its own sandbox; the client defensively *rejects* `fs/*` and `terminal/*` server-requests. Don't wire them.
- **No elicitation, no subagents, no SDK hooks, no mid-turn input, no per-session BYOK.** All `false`/`'none'`/`'unsupported'` in `capabilities`. Auth is one machine-wide `~/.hermes/auth.json`.

These belong to other providers. Don't paste them into Hermes code.

## Ground-truth files

When in doubt about behavior, these are authoritative (in this order):

1. [`packages/daemon/src/agent/providers/hermes-acp/transport.ts`](../../../packages/daemon/src/agent/providers/hermes-acp/transport.ts) — the JSON-RPC wire. Frame kinds, id correlation, server-request handling. This is *the* contract for what we send/receive.
2. [`packages/daemon/src/agent/providers/hermes-acp/client.ts`](../../../packages/daemon/src/agent/providers/hermes-acp/client.ts) — spawn / `initialize` / `authenticate` / session methods / permission fan-out / the `AcpPermissionOutcome` shape.
3. [`packages/daemon/src/agent/providers/hermes.ts`](../../../packages/daemon/src/agent/providers/hermes.ts) — the adapter; the long top-of-file comment block captures every constraint that's bitten us. Read it before any change.
4. [`packages/daemon/src/transcripts/hermesParser.ts`](../../../packages/daemon/src/transcripts/hermesParser.ts) — `~/.hermes/sessions/session_<id>.json` → `Message[]`; the format we trust as "what really happened."
5. A locally running `hermes acp` (`hermes --version`, `hermes doctor`). Hermes' own source is `NousResearch/hermes-agent` → `acp_adapter/`.
6. Hermes docs: [xAI Grok OAuth guide](https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth), [configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration), [slash commands](https://hermes-agent.nousresearch.com/docs/reference/slash-commands). xAI: [reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning). Slower to update than the binary — cross-check against a running `hermes acp`.

## Where this provider lives in our codebase

```
packages/daemon/src/
├── agent/
│   ├── manager.ts                       ← registers `hermes: new HermesAdapter(permManager)`
│   │                                      (~L111); hydrates from disk on register (~L233)
│   ├── providers/
│   │   ├── hermes.ts                    ← THE adapter: cwd pool, turn loop, notification
│   │   │                                  router, permission bridge, reasoning prefix
│   │   ├── hermes-acp/
│   │   │   ├── transport.ts             ← line-delimited JSON-RPC 2.0 over child stdio
│   │   │   ├── client.ts                ← spawn/init/auth, session methods, perm fan-out
│   │   │   └── index.ts                 ← re-exports
│   │   └── types.ts                     ← ProviderAdapter / AdapterCallbacks / Capabilities
│   └── types.ts                         ← AgentSession (provider: …| 'hermes')
├── transcripts/
│   └── hermesParser.ts                  ← ~/.hermes/sessions/session_<id>.json → Message[]
└── api/
    └── sessions.ts                      ← re-hydrates via parseHermesSession (~L309)
```

The manager is provider-agnostic. Hermes-specific behavior belongs **only** in `agent/providers/hermes.ts`, `agent/providers/hermes-acp/*`, and (for parsing) `transcripts/hermesParser.ts`. If you're editing the manager for Hermes behavior, the change almost certainly belongs in the `AdapterCallbacks` bag instead.
