---
name: grok-build
description: Authoritative reference for working on MultiTable's Grok Build (xAI) provider, driven by `grok agent stdio` over line-delimited JSON-RPC (Agent Client Protocol). Trigger when the user mentions Grok Build, the Grok adapter, `grok agent stdio`, GrokAdapter, grok-build-0.1, ACP for Grok, `~/.grok/`, the default/auto/plan modes, `--always-approve`, `--agent-profile`, `--reasoning-effort`, `x.ai/billing`, the SuperGrok/SuperHeavy subscription, `GROK_CODE_XAI_API_KEY`, usage limits / rate limits (why they're off for Grok; the xAI billing out-of-band path), or modifying anything under `packages/daemon/src/agent/providers/grok.ts`, `packages/daemon/src/agent/providers/grok-acp/`, or `packages/daemon/src/transcripts/grokParser.ts`.
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
---

# Grok Build (xAI) provider reference for MultiTable

> **Status: SHIPPED.** The adapter is live: [`grok.ts`](../../../packages/daemon/src/agent/providers/grok.ts) + [`grok-acp/`](../../../packages/daemon/src/agent/providers/grok-acp/) + [`grokParser.ts`](../../../packages/daemon/src/transcripts/grokParser.ts), registered in `agent/manager.ts`. The wire contract was **verified against grok v0.2.2** via handshake + behavior probes — see the resolution tables in [`multitable/known-bugs.md`](multitable/known-bugs.md). **Two corrections matter most (2026-05-27):** (1) mode and effort are **NOT** `session/new` params — those are silently ignored. There is no ACP `session/set_mode`. Mode/effort/model are **spawn-time flags** on the `grok agent` child, so the adapter pools one child per `(cwd, mode, effort, model)`. (2) MultiTable exposes only the **3 modes** that map to a real lever — `default` (prompts), `auto` (`--always-approve`), `plan` (`--agent-profile <MT full-capability plan profile>`). `plan` does the native plan→execute flow in ONE session: the agent plans, then `exit_plan_mode` arrives as the `_x.ai/exit_plan_mode` server-request which we gate via the approval UI (approve → executes in the same session; deny → abort the turn). See [`reference/modes.md`](reference/modes.md). Re-baseline after each `grok` upgrade — it's early beta. Design rationale: [`../../../docs/reference/GROK_BUILD_INTEGRATION_PLAN.md`](../../../docs/reference/GROK_BUILD_INTEGRATION_PLAN.md).

There is **no pinned SDK**. Grok Build is not an npm package — it's xAI's official agent **binary** (`grok`) that MultiTable drives as a long-lived child over **line-delimited JSON-RPC 2.0 on stdio**, speaking the **Agent Client Protocol (ACP)** via the `grok agent stdio` subcommand. The version is whatever `grok` is on the operator's `PATH` (`grok --version`). Re-verify against a running `grok agent stdio` after any upstream Grok release — the CLI is in early beta and moves fast.

This skill is **strictly Grok-Build-only**. Do **not** import Claude Agent SDK concepts (`query()`, `canUseTool` as an SDK callback, `onElicitation`, SDK `hooks`, `permissionMode`, `AskUserQuestion`), Codex concepts (`Thread`, `runStreamed`, `sandboxMode`, the cumulative-text rule), **or Hermes specifics** (`hermes acp`, the bwrap jail, `HERMES_INFERENCE_PROVIDER`, `/reasoning` prefix, `~/.hermes/`) into Grok code or reasoning. Grok Build and Hermes *both* speak ACP, but they are **separate providers with separate wire details** — keeping them isolated is the explicit design value here (see [[feedback_separate_sdks]]). For Claude see [`../claude-agent-sdk/SKILL.md`](../claude-agent-sdk/SKILL.md); for Codex [`../openai-codex-sdk/SKILL.md`](../openai-codex-sdk/SKILL.md); for Hermes (the *other* ACP/xAI agent) [`../hermes-grok/SKILL.md`](../hermes-grok/SKILL.md) — read that one only to understand what NOT to copy.

## The one fact that shapes everything

Grok Build is an **ACP agent behind a long-lived stdio child** spawned via **`grok agent stdio`**, and the integration is **architecturally a sibling of the Hermes adapter** — but a *separate* `grok.ts` + `grok-acp/` + `grokParser.ts`, never shared code.

The second fact that shapes the adapter: **Grok's ACP parser does not unescape `\/` in JSON-RPC method names.** A method sent as `"session\/prompt"` (the default `JSON.stringify` escaping in some serializers) arrives at Grok literally as `session\/prompt`, fails to match `session/prompt`, and the request times out (~12 s). The transport **must** post-process every outbound frame to rewrite `\/` → `/` in the `method` field. This is the single most likely "it just hangs" bug and is documented in [`pitfalls.md`](pitfalls.md) §1.

## Quick task → file map

| What you want to do | Read |
|---|---|
| Understand the ACP wire protocol (initialize / authenticate / session lifecycle / `session/update` kinds) as Grok speaks it | [`reference/acp-protocol.md`](reference/acp-protocol.md) |
| Wire or debug Grok auth (`~/.grok/auth.json`, OAuth login, `GROK_CODE_XAI_API_KEY` fallback, auth-state alerts) | [`reference/xai-auth.md`](reference/xai-auth.md) |
| Understand the 3 modes (default/auto/plan), spawn-flag mapping, and the native plan→execute (`exit_plan_mode`) flow | [`reference/modes.md`](reference/modes.md) |
| Know the model (`grok-build-0.1`), `/model` switching, and whether a reasoning-effort knob exists | [`reference/models-and-effort.md`](reference/models-and-effort.md) |
| Know which Grok slash-commands matter to us (and which are TUI-only / out of scope) | [`reference/slash-commands.md`](reference/slash-commands.md) |
| Understand why the usage-limits indicator is off for Grok (and the out-of-band path) | [`reference/usage-limits.md`](reference/usage-limits.md) |
| Get oriented in the planned `agent/providers/grok.ts` + the adapter contract | [`multitable/adapter-architecture.md`](multitable/adapter-architecture.md) |
| Wire / debug the permission prompt (approvals silently denied, etc.) | [`multitable/permission-wiring.md`](multitable/permission-wiring.md) |
| Parse `~/.grok/` session history into `Message[]` and dedupe replay | [`multitable/persistence-and-parser.md`](multitable/persistence-and-parser.md) |
| Scan version-pinned quirks before a PR | [`multitable/known-bugs.md`](multitable/known-bugs.md) + [`pitfalls.md`](pitfalls.md) |

## Decision tree: which lever to pull?

```
Need to BLOCK / approve a tool call?
└── Grok sends `session/request_permission` (a JSON-RPC SERVER-request) over ACP.
    GrokAdapter.handleAcpPermission → PermissionManager.requestFromSdk → UI prompt.
    Return a SELECTED optionId or CANCELLED, in ACP's NESTED outcome shape
    { outcome: { outcome: 'selected', optionId } }. See permission-wiring.md.
    NOTE: like every ACP agent, Grok decides for itself WHICH calls need
    approval — and `auto` mode (--always-approve) runs every tool with NO
    prompt. The host cannot force-prompt every call. See pitfalls.md §6.

Need PLAN mode (plan → execute in ONE session)?
└── Spawn the child with `--agent-profile <MT full-capability plan profile>`
    (permission_mode: plan; ensurePlanProfilePath writes it to the data dir).
    The agent plans (read-only), then calls exit_plan_mode → arrives as the
    `_x.ai/exit_plan_mode` SERVER-REQUEST {sessionId,toolCallId,planContent},
    which Grok BLOCKS on. handleExitPlanMode gates it via PermissionManager:
    approve → EXECUTES in the same session; deny → abort the turn. NOT the
    bundled read-only plan.md (no edit tools → can't execute). capabilities.
    planMode='native'. See reference/modes.md + multitable/permission-wiring.md.

Need to STOP a turn mid-stream?
└── client.cancel(grokSessionId) sends the `session/cancel` NOTIFICATION
    (no response). The pending `session/prompt` resolves stopReason:'cancelled'.
    Wire off ctrl.signal 'abort' in runTurn. (Same ACP primitive as any agent.)

Need to RESUME a prior conversation?
└── client.loadSession(agentSessionId, {cwd}) → ACP `session/load`
    (agentCapabilities.loadSession=true on 0.2.2). Mode/effort/model are NOT
    load params — they're baked into the child's spawn flags, so a flip
    re-attaches under a different pooled child. 500ms drain kept defensively in
    case Grok replays history as session/update.

Need cost in USD?
└── NOT WIRED. `x.ai/billing` is TUI-only / account-level, not per-turn USD.
    capabilities.costUsd=false. BUT real token usage IS available in the
    session/prompt response `_meta` (input/output/cachedRead/reasoning tokens)
    → applyUsage. See reference/xai-auth.md.

Need the agent to ASK the user a free-form question / MCP elicitation?
└── Not seen over agent-stdio. capabilities.userQuestion='unsupported',
    elicitation=false. Don't invent a channel.

Need to change reasoning depth?
└── NATIVE but SPAWN-TIME. capabilities.thinkingEffort='native'. The child is
    spawned with `grok agent --reasoning-effort <none|minimal|low|medium|high|
    xhigh>` (NO 'max' → map to xhigh; NO session/new `effort`; NO /reasoning
    prefix — that's Hermes). See reference/models-and-effort.md.

Need a behavior MODE (default / auto / plan)?
└── SPAWN-TIME ONLY. session/new IGNORES permissionMode; there's no set-mode.
    buildAgentArgs maps: default→(none, prompts), auto→`--always-approve`,
    plan→`--agent-profile <bundled plan.md>`. One pooled child per
    (cwd,mode,effort,model). capabilities.modes = [default, auto, plan] only.
    See reference/modes.md.
```

## Four rules that get violated most (carried over from ACP; re-verify for Grok)

1. **ACP deltas are ADDITIVE; the StreamBuffer boundary wants CUMULATIVE.** `agent_message_chunk` / `agent_thought_chunk` each carry a *fresh piece* of text to append (per the ACP spec). The adapter must accumulate into `buffers.assistantText` / `buffers.reasoningText` and emit the **running total** via `cb.emitAssistantDelta(buffers.assistantText)`. This is the *opposite* of Codex's "payload is already cumulative, replace don't append" rule. Append to the buffer, emit the buffer. `capabilities.streamingDeltaSemantics = 'additive'`.

2. **The permission response is a NESTED literal.** Return `{ outcome: { outcome: 'selected', optionId } }` or `{ outcome: { outcome: 'cancelled' } }`. The *inner* `outcome` string is the ACP discriminator — **not** `'allowed'`/`'denied'`, **not** a flat `{ outcome: 'selected' }`. Returning the wrong shape can silently coerce every approval to a deny. See [`multitable/permission-wiring.md`](multitable/permission-wiring.md).

3. **Rewrite `\/` → `/` in outbound method names.** Grok's ACP parser does not unescape it. A serializer that escapes forward slashes will make every request time out. The transport post-processes each frame's `method`. See [`pitfalls.md`](pitfalls.md) §1.

4. **stdout is JSON-RPC only; logs go to stderr.** Drop non-JSON stdout lines with a warning; never parse stderr for state; never write non-JSON to the child's stdin.

## Three things to confirm Grok does NOT have before wiring them

These are **`VERIFY` / assumed-absent for v1** — don't build them speculatively:

- **No per-turn USD cost surface over agent-stdio** (`x.ai/billing` is TUI-only in 0.1.x → `-32601`). `capabilities.costUsd = false`; `applyUsage({ …, costUsd: 0 })`. Don't derive USD from tokens even though grok-build-0.1 pricing is published.
- **No confirmed host-brokered filesystem / terminal.** Advertise `clientCapabilities: { fs: { readTextFile:false, writeTextFile:false }, terminal:false }` and defensively reject `fs/*` / `terminal/*` server-requests — Grok runs its own tools under its own workspace-trust/sandbox model.
- **No confirmed elicitation, mid-turn input, or per-session BYOK over agent-stdio.** Auth is machine-wide (`~/.grok/auth.json`) or a process-env API key. Grok's native hooks/skills/subagents/plugins run **inside** Grok, not host-brokered to us.

If a live `grok agent stdio` proves any of these *is* reachable, flip the capability and wire it — but verify first, don't assume parity with the TUI feature list.

## Ground-truth files (once the adapter exists)

When in doubt about behavior, these will be authoritative (in this order):

1. `packages/daemon/src/agent/providers/grok-acp/transport.ts` — the JSON-RPC wire (frame kinds, id correlation, server-request handling, the `\/` shim). *The* contract for what we send/receive.
2. `packages/daemon/src/agent/providers/grok-acp/client.ts` — spawn / `initialize` / `authenticate` / session methods / permission fan-out / the `AcpPermissionOutcome` shape.
3. `packages/daemon/src/agent/providers/grok.ts` — the adapter; its top-of-file comment block should capture every constraint that's bitten us.
4. `packages/daemon/src/transcripts/grokParser.ts` — `~/.grok/<sessions path>` → `Message[]`; the format we trust as "what really happened."
5. A locally running `grok agent stdio` (`grok --version`, `grok inspect`). xAI's own CLI is the upstream source of truth.
6. xAI docs: [Introducing Grok Build](https://x.ai/news/grok-build-cli), [Grok Build CLI](https://x.ai/cli), [xAI Docs — enterprise](https://docs.x.ai/build/enterprise). The Agent Client Protocol spec: [agentclientprotocol.com](https://agentclientprotocol.com/get-started/introduction). Docs lag the binary — cross-check against a running `grok agent stdio`.

## Where this provider will live in our codebase

```
packages/daemon/src/
├── agent/
│   ├── manager.ts                       ← will register `grok: new GrokAdapter(permManager)`
│   ├── providers/
│   │   ├── grok.ts                      ← THE adapter: cwd pool, turn loop, notification
│   │   │                                  router, permission bridge, mode plumbing
│   │   ├── grok-acp/
│   │   │   ├── transport.ts             ← line-delimited JSON-RPC 2.0 over child stdio + \/ shim
│   │   │   ├── client.ts                ← spawn/init/auth, session methods, perm fan-out
│   │   │   └── index.ts                 ← re-exports
│   │   └── types.ts                     ← ProviderAdapter / AdapterCallbacks / Capabilities (add 'grok')
│   └── types.ts                         ← AgentProvider = …| 'grok'
├── transcripts/
│   └── grokParser.ts                    ← ~/.grok/<sessions> → Message[]
└── api/
    └── sessions.ts                      ← re-hydrate via parseGrokSession
```

The manager is provider-agnostic. Grok-specific behavior belongs **only** in `agent/providers/grok.ts`, `agent/providers/grok-acp/*`, and (for parsing) `transcripts/grokParser.ts`. If you're editing the manager for Grok behavior, the change almost certainly belongs in the `AdapterCallbacks` bag instead. See the full file-by-file plan in [`../../../docs/reference/GROK_BUILD_INTEGRATION_PLAN.md`](../../../docs/reference/GROK_BUILD_INTEGRATION_PLAN.md).
