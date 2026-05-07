# Three-Provider Integration Plan: Claude / Codex / Copilot

> **Validated 2026-05-06** — every claim in this doc has been web-verified against the installed `node_modules` source, official SDK docs, and GitHub issues. Versions validated: Claude `0.2.119`, Codex `0.128.0`, Copilot `1.0.0-beta.2` (not installed; checked against npm tarball). Open questions and bonus capabilities discovered during validation are tracked in §6.

## Context

MultiTable currently ships one mature integration (Claude Agent SDK), one functional but constrained integration (OpenAI Codex SDK), and one forward-looking skill (GitHub Copilot SDK, no adapter yet). The three SDKs differ on nearly every axis that matters to a multi-agent dashboard — streaming semantics, abort mechanism, permission model, persistence format, cost surface, mode/plan support, subagents, hooks. Today the divergence is partly hidden inside [packages/daemon/src/agent/manager.ts](packages/daemon/src/agent/manager.ts) (Claude) and the slim [packages/daemon/src/agent/providers/codex.ts](packages/daemon/src/agent/providers/codex.ts) adapter; adding Copilot would make the inconsistencies untenable.

This document maps every capability across the three SDKs, identifies where they overlap, where they diverge, and where MultiTable must absorb the difference behind a stable abstraction so the React UI can stay provider-agnostic.

---

## Part 1 — Cross-reference matrix

Legend: ✅ first-class · ⚠️ partial / requires workaround · ❌ not supported

### A. Session lifecycle

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| Create session | ✅ Implicit on first `query()` (no explicit create) | ✅ `codex.startThread(opts)` (id null until first event) | ✅ `client.createSession({sessionId, ...})` (id mandatory for resume) |
| Resume by id | ✅ `Options.resume: id` | ✅ `codex.resumeThread(id, opts)` | ✅ `client.resumeSession(id, config)` (must re-supply BYOK keys) |
| Continue most recent | ✅ `Options.continue: true` | ❌ | ❌ |
| Fork / branch | ✅ `forkSession: true` (SDK exports it; UI doesn't expose) | ❌ | ❌ |
| Delete | ✅ `deleteSession()` SDK helper | ⚠️ Just `rm` the rollout file | ✅ `client.deleteSession(id)` |
| Rename / tag | ✅ `renameSession`, `tagSession` | ❌ | ⚠️ Title via event only; no setter |
| List prior sessions | ✅ `listSessions()` | ✅ Daemon parser walks `~/.codex/sessions` | ✅ `client.listSessions({cwd?, gitRoot?, repository?, branch?})` |
| Persistence path | `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` | `~/.codex/sessions/<Y>/<M>/<D>/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl` (ISO datetime with `:` → `-`, then UUID — parsers must use a UUID regex for the id portion since the date contains hyphens) | `~/.copilot/session-state/<sid>/checkpoints/NNN.json` + `plan.md` + `files/` |
| Persistence format | Append-only JSONL, line-per-event | Append-only JSONL, line-per-event with `session_meta` header | Numbered JSON snapshots (read highest-numbered) |
| Session id available | After `system.init` SDK msg | After `thread.started` event (null before — **abort before this leaves thread unresumable**) | At `createSession` return (host-supplied) |

### B. Streaming responses

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| Streaming opt-in | `includePartialMessages: true` | `runStreamed()` (vs `run()` which discards updates) | `SessionConfig.streaming: true` |
| Delta semantics | **Additive** (`text_delta` chunks; SDK exposes both stream events and final canonical message) | **Cumulative** (`item.updated.item.text` is full text-so-far — must REPLACE buffer) | **Additive** (`assistant.message_delta.deltaContent` — must APPEND) |
| Final canonical msg | `assistant` SDK message (always emitted alongside stream) | `item.completed` for `agent_message` | `assistant.message` event with full content |
| "Loop done" signal | `result` SDK message | `turn.completed` (one per spawn = one per turn) | `session.idle` (the only universal "done"; ephemeral, never persisted) |
| Reasoning stream | `thinking_delta` events (additive) | `item.updated` on `reasoning` items (cumulative) | `assistant.reasoning_delta` (additive) |
| Tool output stream | `input_json_delta` for tool args; tool result via `tool_result` block | `command_execution.aggregated_output` (cumulative); `mcp_tool_call.result.content` | `tool.execution_partial_result.partialOutput` (additive) |
| Time-to-first-token | `ttft_ms` on first delta | ❌ Not exposed | ❌ Not exposed |

### C. User input

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| Send a turn | `query({prompt: string \| AsyncIterable, options})` | `thread.runStreamed(input, turnOpts)` | `session.send({prompt, attachments?, mode?})` is `async`; resolves with `{messageId}` on **queue ack** (not on LLM completion) |
| Wait-for-result helper | ❌ Manual loop | `thread.run(...)` (non-streaming) | ✅ `session.sendAndWait(opts, timeoutMs)` |
| Mid-turn input / steering | ✅ AsyncIterable mode (unused today) | ❌ stdin closed after prompt | ✅ `mode: 'immediate'` (or `'enqueue'` for next turn) |
| Image attachments | ✅ Via streaming-input mode (unused) | ⚠️ Local file paths only (`{type: 'local_image', path}`) | ✅ `attachments: [{type: 'file' \| 'directory' \| 'selection' \| 'blob', ...}]` (4 variants; `selection` carries file path + line/character range; all accept `displayName?`) |

### D. Interruption / abort

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| Mechanism | `Options.abortController: AbortController` (the type rejects bare `AbortSignal` at compile time; "silent no-op" only happens if you cast through `as any`) OR `Query.interrupt()` in stream-input mode | `TurnOptions.signal: AbortSignal` | `await session.abort()` — no AbortSignal field on `send()` |
| State after abort | Falls through `finally` block; in-flight `canUseTool` receives an `AbortSignal` it can listen to. **MultiTable application code** in [permissionManager.ts](packages/daemon/src/hooks/permissionManager.ts) chooses to resolve with `{behavior:'deny', message:'Cancelled'}` — that's a host choice, not SDK contract | Throws AbortError; spawn killed via SIGTERM (may include raw stderr in msg) | `abort` event fires (event type is literally `"abort"`, not `"agent.abort"`); `session.idle` still fires (with `IdleData.aborted: true`); session reusable |
| Usage delivered on abort | ❌ No `result` msg | ❌ No `turn.completed` → no usage | ⚠️ Partial — last `assistant.usage` events stand |
| Custom in-process tools mid-flight | N/A (no in-process tools today) | N/A | ⚠️ Cannot interrupt synchronous JS; wire your own AbortController inside `defineTool` |
| Pre-`thread.started` abort | N/A | ❌ Footgun: leaves thread unresumable | N/A |
| Watchdog (5-min no-progress) | ✅ Implemented in manager | ⚠️ Same watchdog in manager; no SIGKILL escalation yet | Should mirror Claude pattern |

### E. Permission / approval

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| Per-call host gate | ✅ `canUseTool(toolName, input, opts)` | ❌ stdin closed; impossible | ✅ `hooks.onPreToolUse({toolName, toolArgs})` returns `'allow'/'deny'/'ask'` |
| Coarse policy | `permissionMode: 'default'\|'acceptEdits'\|'bypassPermissions'\|'plan'\|'dontAsk'\|'auto'` | `approvalPolicy: 'never'` (the only working value; `'on-failure'` is deprecated, others fail because stdin closes) + `sandboxMode: 'read-only'\|'workspace-write'\|'danger-full-access'` | `onPermissionRequest({kind: 'shell'\|'write'\|'read'\|'mcp'\|'url'\|'custom-tool'\|'memory'\|'hook'})` returns `{kind: 'approve-once'\|'approve-for-session'\|'approve-for-location'\|'approve-permanently'\|'reject'\|'user-not-available'\|'no-result'}` (the longer-form `denied-...` variants in stale README are wrong) |
| User Q&A from agent | ✅ Built-in `AskUserQuestion` tool (intercepted in `canUseTool` by tool name; answered via **`{behavior: 'allow', updatedInput: {questions, answers}}`** where `answers` maps each question to the chosen option `label`) | ❌ No mechanism | ✅ `onUserInputRequest({question, choices?, allowFreeform?})` (separate channel) |
| MCP elicitation (forms / URLs) | ✅ `Options.onElicitation` (separate top-level callback) | ❌ | ✅ `onElicitationRequest({message, requestedSchema, mode: 'form'\|'url'})` |
| Path-based auto-defer | ✅ MultiTable's `PermissionManager` — read-only tools inside cwd auto-allow | N/A (sandbox handles) | Will need same logic in onPreToolUse |
| Static allowlist | `allowedTools` / `disallowedTools` arrays | `mcp_servers.<name>.enabled_tools` / `disabled_tools` | ⚠️ No coarse static allowlist; use `tools: []` to deny all + `defineTool({skipPermission: true})` per-tool |
| Mandatory-or-hangs | `canUseTool` optional (defaults to allow) | N/A | **`onPermissionRequest` MANDATORY — agent crashes without it; the Q&A and elicitation callbacks hang the agent if used and unwired** |

### F. Plan mode

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| First-class plan mode | ✅ `permissionMode: 'plan'` (read tools execute, mutating denied with explanation) | ❌ TUI-only | ❌ TUI-only |
| Workaround | N/A | Spawn 1: `sandboxMode: 'read-only'` for planning; Spawn 2: resume with `'workspace-write'` to execute | `systemMessage.append` plan instruction + `onPreToolUse` denying everything except read tools |
| Switch mid-stream | ✅ `Query.setPermissionMode()` (streaming-input mode only) | ❌ | ⚠️ Recreate session with same sessionId |
| Reasoning effort knob | `effort: 'low'\|'medium'\|'high'\|'xhigh'\|'max'` | `modelReasoningEffort: 'minimal'\|'low'\|'medium'\|'high'\|'xhigh'` | `reasoningEffort: 'low'\|'medium'\|'high'\|'xhigh'` |

### G. Tools

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| In-process custom tool | ✅ `createSdkMcpServer` + `tool()` (Zod schema) | ❌ | ✅ `defineTool('name', {parameters: z.object(...), handler})` |
| External MCP — stdio | ✅ `mcpServers: {name: {command, args, env}}` | ✅ via `CodexOptions.config.mcp_servers` (no typed field) | ✅ `mcpServers: {name: {type: 'local', command, args, env, cwd, tools, timeout}}` |
| External MCP — HTTP/SSE | ✅ `{type: 'http' \| 'sse', url, headers}` | ✅ via config (URL + bearer_token_env_var + http_headers) | ✅ `{type: 'http' \| 'sse', url, headers, tools, timeout}` |
| Project `.mcp.json` autoload | ✅ via `settingSources: ['project','user']` | Via `~/.codex/config.toml` (user-only; no project autoload) | ❌ Per-session config only; no autoload |
| Tool naming convention | `mcp__<server>__<tool>` | server-scoped | `mcp__<server>__<tool>` (when seen in `onPreToolUse`) |
| Tool result shape | `{content: [...], isError?}` | Per-item types (`command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`) | `{content: [{type, text\|data\|...}], isError?}` |
| Web search | Built-in `WebSearch` tool | `webSearchMode: 'disabled'\|'cached'\|'live'` | Implicit (model-driven) |
| Structured output | ❌ Not exposed | ✅ `TurnOptions.outputSchema` (per-turn JSON schema; sometimes ignored — known bug) | ❌ Not exposed |

### H. Hooks (lifecycle observability)

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| Hook count | **29 events** (full list: `PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged, FileChanged`) | **0** — only the event stream | 6 (`onSessionStart`, `onUserPromptSubmitted`, `onPreToolUse`, `onPostToolUse`, `onSessionEnd`, `onErrorOccurred`) |
| Inject system context mid-turn | `additionalContext` in PreToolUse/PostToolUse | ❌ | `additionalContext` in user-prompt/pre-tool/post-tool hooks |
| Block tool from hook | `permissionDecision: 'deny'` from PreToolUse | ❌ | `permissionDecision: 'deny'` from `onPreToolUse` |
| Rewrite tool input | `updatedInput` from PreToolUse | ❌ | `modifiedArgs` from `onPreToolUse` |
| Rewrite tool result | `updatedToolOutput` from PostToolUse | ❌ | `modifiedResult` from `onPostToolUse` |
| Auto-rename session on first prompt | Implemented via UserPromptSubmit hook + `~/.claude/projects` JSONL labeler | ⚠️ Would need to read first user message from JSONL after first turn | `onUserPromptSubmitted` could call labeler |

### I. Subagents

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| Definition | ✅ `Options.agents: {name: AgentDefinition}` (manual `Agent` tool routing) | ❌ No metadata, no first-class support (GitHub issue #20979 open) | ✅ `customAgents: [{name, prompt, tools, mcpServers, infer, skills}]` (auto-routed by classifier) |
| Detection in stream | `parent_tool_use_id` on every SDK message | ❌ | `subagent.started/selected/completed/failed/deselected` events |
| Per-subagent model | ✅ | N/A | Per-subagent `tools` + `mcpServers`; model not per-agent |
| Per-subagent permission mode | ✅ | N/A | ❌ |

### J. Model selection & params

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| Model id per-turn vs per-session | Per-turn (`Options.model`) | Per-thread (passed on every `startThread`/`resumeThread`) | Per-session (set at `createSession`) |
| List available models | ❌ Not exposed | ❌ Not exposed | ✅ `client.listModels()` returns `ModelInfo[]` — fields are `{id, name, capabilities, billing, policy, supportedReasoningEfforts?, defaultReasoningEffort?}` (note: `name`, not `displayName`) |
| Switch model mid-session | ✅ `Query.setModel()` (streaming-input mode) | ⚠️ New thread on each turn anyway | ✅ `session.setModel(model, opts)` — takes effect on next message |
| System prompt control | ✅ String OR `{type:'preset', preset:'claude_code', append?, excludeDynamicSections?}` | ❌ Baked into codex binary | ✅ `systemMessage: {mode:'append'\|'replace'\|'customize', sections?}` (10 named sections) |
| Reasoning effort | ✅ `effort` | ✅ `modelReasoningEffort` | ✅ `reasoningEffort` |
| Thinking budget | ✅ `thinking: ThinkingConfig` | Indirect via reasoning effort | Indirect via reasoning effort |
| Temperature / topP / maxTokens | ❌ Not exposed | ❌ Not exposed (workaround via `CodexOptions.config.model_*`) | ❌ Not exposed |
| BYOK | ❌ ANTHROPIC_API_KEY only | ❌ CODEX_API_KEY / `~/.codex/auth.json` | ✅ `provider: {type, baseUrl, apiKey \| bearerToken, wireApi}` (per-session, never persisted) |

### K. Cost & usage

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| USD cost surface | ✅ `result.total_cost_usd` (per-turn estimate) + `modelUsage[model].costUSD` per-model | ❌ Hidden by design | ✅ `assistant.usage.cost` per-LLM-call (units undocumented; treat USD); sum across turn |
| Token fields | `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` | `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens` | `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` |
| Usage delivery cadence | Once per turn (`result`) plus per-message | Once per turn (`turn.completed`) | Per-LLM-call (`assistant.usage`) — multiple per agent turn |
| Live context-window snapshot | `system.init` carries it | ❌ | ✅ `session.usage_info.{currentTokens, tokenLimit, messagesLength}` |
| Quota/account | Anthropic Usage & Cost API (off-SDK) | ❌ | ✅ `client.rpc.account.getQuota(params?)` (typed nested accessor; same pattern for `client.rpc.mcp.config.{list,add,update,remove,enable,disable}`, `client.rpc.mcp.discover()`, `client.rpc.mcp.oauth.login()`) |

### L. Working directory & sandboxing

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| Set cwd | `Options.cwd` | `ThreadOptions.workingDirectory` | `SessionConfig.workingDirectory` (input field for tool cwd). Note: `session.workspacePath` is a separate **read-only getter** populated when infinite sessions are enabled, pointing at `~/.copilot/session-state/<sid>/` — use it for "open in Finder", not for setting cwd |
| Hard FS sandbox | ❌ Soft (cwd hint + permission gating) | ✅ `sandboxMode` enforced by codex binary | ❌ Soft (gate via `onPreToolUse`) |
| Additional writable paths | N/A (gate via permissions) | ✅ `additionalDirectories` (write access, not read-only mounts) | ❌ |
| Network gate | N/A | ✅ `networkAccessEnabled` (workspace-write only) | ❌ |
| Skip git repo check | N/A | ✅ `skipGitRepoCheck` | N/A |

### M. Compaction / context

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| Auto-compact | ✅ Built-in; `system.compact_boundary` msg | ✅ Internal (CLI heuristics); JSONL `compacted` records | ✅ `infiniteSessions: true` (default); `session.compaction_start/complete` |
| Manual compact | ✅ `/compact` slash command (intercepted by SDK) | ❌ TUI-only `/compact` | ❌ Auto-only |
| Pre/post hook | ✅ `PreCompact`, `PostCompact` | ❌ | ⚠️ `compaction_start/complete` events (observe only) |

### N. Slash commands

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| Custom commands on disk | ✅ `<cwd>/.claude/commands/*.md` and `~/.claude/commands/*.md` (with YAML frontmatter, `$ARGUMENTS`) | ❌ | ⚠️ `SessionConfig.commands: [{name, description, handler}]` (in-process only) |
| Built-in commands | Numerous (`/compact`, `/cost`, `/clear`, etc.) — not surfaced (would land as text) | ❌ TUI-only | ❌ TUI-only |
| MultiTable native built-ins | `/clear`, `/cost` (intercepted in [packages/web/src/lib/cm-completions.ts](packages/web/src/lib/cm-completions.ts)) | Same intercept layer | Same intercept layer |

### O. Notifications & status

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| Attention/notification | ✅ `Notification` hook | ❌ | ⚠️ `session.info`, `session.warning`, `system.notification` events |
| Connection state | N/A (in-process) | N/A (per-turn subprocess) | ✅ `client.getState(): 'disconnected'\|'connecting'\|'connected'\|'error'` |
| Title / label change | UserPromptSubmit-driven labeler | ⚠️ Manual | ✅ `session.title_changed` event |

### P. Authentication

| Capability | Claude | Codex | Copilot |
|---|---|---|---|
| Source | `ANTHROPIC_API_KEY` env or `~/.claude/auth.json` (`claude login`) | `CODEX_API_KEY` env or `~/.codex/auth.json` (`codex login`) | Resolution chain: explicit → HMAC env → token+URL → COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN → stored OAuth → `gh auth login` |
| Per-session BYOK | ❌ | ❌ | ✅ `provider` field (mutually exclusive `apiKey`/`bearerToken`; never persisted) |
| Auth events | `auth_status` SDK message | Stderr text on auth failure (no structured error) | Implicit; `useLoggedInUser: false` to disable auto-detect |

### Q. Distinctive capabilities (per provider)

**Claude only:**
- Hook richness (29 events) and ability to mutate inputs/outputs from hooks
- First-class `permissionMode: 'plan'`
- `excludeDynamicSections` for prompt-cache stability (requires SDK ≥ **v0.2.119**)
- Subagent + per-subagent model/permission overrides
- `forkSession`
- `ttft_ms` on `SDKPartialAssistantMessage` (real-but-unannounced — not in any public changelog)
- `AskUserQuestion` integrated as a tool

**Codex only:**
- Per-thread `sandboxMode` enforced by codex binary (only true OS-level sandbox of the three)
- `additionalDirectories` and `networkAccessEnabled` knobs
- `outputSchema` (structured output)
- Plan via `--config plan_mode_reasoning_effort` (TUI-only effect)

**Copilot only:**
- BYOK (per-session provider override)
- Three independent prompt callbacks (`onPermissionRequest` / `onUserInputRequest` / `onElicitationRequest`)
- `client.listModels()` with capabilities/billing/policy
- `account.getQuota` RPC
- Auto-routed `customAgents` (event names: `subagent.started/selected/...`; routing mechanism — classifier vs. tool delegation vs. explicit `agent.select` — not publicly documented)
- Skills as first-class extensions (event names: `session.skills_loaded`, `skill.invoked`)
- Persistent `plan.md` artifact under session state
- Long-lived JSON-RPC child process (one CLI per daemon, sessions multiplex)

---

## Part 2 — Architectural implications

### 2.0 Architecture decision: middle-layer dispatch

**Three options were considered for how the three CLIs plug into MultiTable:**

1. **Single unified interface at the SDK boundary.** Define one API shape (one `runTurn` signature, one event stream, one permission callback) that every SDK conforms to. App code sees a single provider-agnostic API and the SDKs are forced into it.
   - **Rejected.** The SDKs differ on *shape*, not just naming. Codex closes stdin so per-call permission callbacks are *physically impossible*; Claude streams additive text deltas while Codex streams cumulative ones; Copilot uses three independent prompt callbacks while Claude folds Q&A into `canUseTool`. A unified interface at this boundary collapses to a least-common-denominator (no per-call approval, no cost surface, no plan mode) that defeats the purpose of integrating Claude or Copilot in the first place.

2. **Per-CLI interfaces all the way up to the app.** Web/UI/store/API code branches on `provider === 'claude' \| 'codex' \| 'copilot'`. Three permission UIs, three streaming renderers, three cost panels.
   - **Rejected.** Already painful with two providers (the cost-row-hidden-for-Codex special case in the UI today is the canary). Three providers with their own first-class UIs would block any cross-provider feature (compare-by-prompt, switch-provider-mid-session, parity tests) and triple the surface area for every UI change.

3. **Middle-layer dispatch.** A small set of provider adapters behind a stable internal contract; one manager owns all cross-cutting concerns (state, persistence, WS dispatch, alerts, labeler, watchdog) and is the *only* thing the app talks to. Adapters are thin: they translate SDK events ↔ a uniform internal vocabulary.
   - **Chosen.** This is the only design that lets the app stay provider-agnostic *while* preserving each provider's unique strengths (Claude's plan mode, Codex's hard sandbox, Copilot's BYOK + quota). Differences are absorbed in exactly one place; everything above sees one shape, everything below sees one SDK.

**Concretely, the layers:**

```
┌─ Web (React) ─────────────────────────────────────────────────────┐
│  Provider-agnostic. Reads `capabilities` to gate UI features      │
│  (cost row, plan-mode toggle, model picker shape, BYOK fields).   │
│  Renders ONE PermissionPrompt, ONE MessageList, ONE CostPanel,    │
│  ONE TranscriptBrowser — regardless of provider.                  │
└──────────────────────────────┬────────────────────────────────────┘
                       REST + WebSocket
┌──────────────────────────────┴────────────────────────────────────┐
│  MIDDLE LAYER — `AgentSessionManager` (the only thing the app     │
│  talks to). Owns:                                                 │
│    • Session state machine + DB persistence                       │
│    • WS dispatch (`session:assistant-message`, `:tool-event`,     │
│      `:user-message`, `:turn-result`, `:state-updated`, ...)      │
│    • Watchdog (5-min no-progress)                                 │
│    • Labeler / option detector / alerts / currentTool /           │
│      activeSubagents / cost & usage projection                    │
│    • Capability advertisement (UI gating)                         │
│    • Permission/Elicitation/UserQuestion routing into the         │
│      unified `PermissionManager` (§2.5)                           │
│  Subscribes to `AdapterEvent` stream from each adapter (§2.10).   │
│  Calls down via the `ProviderAdapter` interface (§2.2).           │
└──────────────────────────────┬────────────────────────────────────┘
                    ProviderAdapter contract
       ┌──────────────────────┼──────────────────────┐
┌──────┴────────┐    ┌────────┴───────┐    ┌─────────┴────────┐
│ ClaudeAdapter │    │  CodexAdapter  │    │  CopilotAdapter  │
│ (in-process   │    │ (per-turn      │    │ (long-lived CLI  │
│  `query()`)   │    │  subprocess)   │    │  child, JSON-RPC,│
│               │    │                │    │  multiplexed)    │
└───────────────┘    └────────────────┘    └──────────────────┘
                              │
                              ▼
                       SDKs / CLIs / disk
```

**Boundaries (these are load-bearing — every PR must respect them):**

- **Adapters know nothing about** the WS layer, the Zustand store, the React app, REST routes, the DB, or other adapters. They speak only the `ProviderAdapter` interface upward and the SDK API downward.
- **The manager (middle layer) knows nothing about** SDK-specific shapes. It receives `AdapterEvent`s and `Message[]`s in a uniform vocabulary; it dispatches via `runTurn`/`abortTurn`/`loadMessages`/etc. It exposes `capabilities` so the UI can render correctly without knowing which provider is in use.
- **The app (web + REST + WS routers) knows nothing about** providers except the `provider` field on the session record — and that field is used only to *label* UI ("Claude session", "Codex session"), never to *branch logic*. All conditional UI rendering is gated by `capabilities` (e.g. `capabilities.costUsd ? <DollarRow/> : null`), not by provider name.

**What changes from today:**

- Today, [packages/daemon/src/agent/manager.ts](packages/daemon/src/agent/manager.ts) is *both* the manager *and* the de-facto Claude adapter — Claude logic is inline (`canUseTool`, hooks, watchdog wiring, SDK options assembly). [packages/daemon/src/agent/providers/codex.ts](packages/daemon/src/agent/providers/codex.ts) is the only true adapter.
- After the refactor: `manager.ts` becomes purely the middle layer (provider-agnostic). A new `packages/daemon/src/agent/providers/claude.ts` `ClaudeAdapter` extracts the inline Claude logic and implements the same contract Codex does. Then `copilot.ts` joins as the third adapter.
- The WS routing in [pty/stream.ts](packages/daemon/src/pty/stream.ts) and [server.ts](packages/daemon/src/server.ts) needs no change — they already speak provider-agnostic events.
- The web app needs no provider-branching changes beyond reading `capabilities` (which already exists implicitly as the `provider === 'codex'` cost-row check).

**The remaining sections (§2.1 onward) describe how each *kind* of difference — streaming semantics, permission models, mode/plan, hooks, persistence, cost — is absorbed by this middle layer.** They are the implementation detail of the architecture chosen here.

### 2.1 Three execution models, one façade

| | Claude | Codex | Copilot |
|---|---|---|---|
| Process model | In-process npm SDK call to `query()` | Per-turn `codex exec` subprocess | One long-lived `copilot` CLI child via JSON-RPC, multiplexed sessions |
| Lifecycle owner (after refactor) | `ClaudeAdapter` (in-memory only — no per-session resource to cache) | `CodexAdapter` (cached `Thread` per session) | `CopilotAdapter` (cached `CopilotSession` per session under one shared `CopilotClient`) |
| Long-lived resource at daemon startup | None | None | One `CopilotClient` (shared across all Copilot sessions) — needs SIGTERM handler |

**Implication:** the `CopilotClient` introduces **process-level lifecycle** the manager doesn't have today. We need a singleton (or per-process pool) owned at daemon startup, wired into SIGTERM. See [packages/daemon/src/index.ts](packages/daemon/src/index.ts) startup sequence — Copilot client init slots in between step 4 (managers) and step 5 (server).

### 2.2 The `ProviderAdapter` contract is currently too thin

Today's [packages/daemon/src/agent/providers/types.ts](packages/daemon/src/agent/providers/types.ts) defines `runTurn` + optional `reset`. That's enough for Codex but Claude's logic still lives inline in [packages/daemon/src/agent/manager.ts](packages/daemon/src/agent/manager.ts) because the manager owns `canUseTool`, `onElicitation`, hooks, watchdog, and labeler — all of which the contract has no slot for.

The contract needs to grow these capabilities so all three adapters (including a future ClaudeAdapter pulled out of the manager) implement the same surface:

```ts
interface ProviderAdapter {
  // Lifecycle
  runTurn(s: AgentSession, text: string, ctrl: AbortController, cb: AdapterCallbacks): Promise<TurnResult>;
  abortTurn?(s: AgentSession): void | Promise<void>;
  reset?(s: AgentSession): void | Promise<void>;
  destroy?(s: AgentSession): void | Promise<void>;     // for Copilot session.disconnect

  // Capabilities (queried by UI to gate features)
  capabilities: ProviderCapabilities;

  // History/transcript
  loadMessages(s: AgentSession): Promise<Message[]>;   // hydrate from disk format
  listPriorSessions(opts: { cwd?: string; limit?: number }): Promise<PriorSessionSummary[]>;

  // Models
  listModels?(): Promise<ModelInfo[]>;                  // Copilot has it; Claude/Codex return null
}

interface ProviderCapabilities {
  costUsd: boolean;                    // Codex: false; Claude/Copilot: true
  planMode: 'native' | 'simulated' | 'none';
  perCallApproval: 'callback' | 'sandbox' | 'callback+kind';
  userQuestion: 'tool' | 'callback' | 'unsupported';
  elicitation: boolean;
  subagents: 'manual' | 'auto' | 'none';
  midTurnInput: boolean;
  byok: boolean;
  hardSandbox: boolean;
  hooks: 'rich' | 'six' | 'none';
  streamingDeltaSemantics: 'additive' | 'cumulative';
  modelSwitchScope: 'per-turn' | 'per-thread' | 'per-session';
}
```

The UI reads `capabilities` to decide what to render: hide cost row when `!costUsd`, hide "Plan mode" toggle when `planMode === 'none'`, render mode-switcher differently for Codex (read-only ↔ workspace-write resume) than Claude (live `setPermissionMode`).

### 2.3 Streaming buffer reducer must be polymorphic

Today the manager assumes additive deltas. Codex needs cumulative replacement; the codex adapter handles it locally. Copilot will be additive again. The clean abstraction:

```ts
type DeltaKind = 'additive' | 'cumulative';
class StreamBuffer {
  constructor(private kind: DeltaKind) {}
  apply(chunk: string): string { ... }   // returns the new full text
  reset(): void;
}
```

Each adapter constructs a `StreamBuffer` per stream type (text / reasoning / tool-output), then calls `cb.emitAssistantDelta(buf.apply(chunk))`. The manager and WS layer never need to know the difference — they always receive cumulative text and replace.

### 2.4 Universal "loop done" signal

The three providers signal turn completion differently:

- **Claude:** `result` SDK message → emit `turn-result` + `turn-complete`.
- **Codex:** `turn.completed` event from one spawn = full turn (subprocess wraps single call) → same.
- **Copilot:** `assistant.turn_end` is per-LLM-call (loop may continue). The only universal "done" is `session.idle` (ephemeral, not persisted, fires once per `send()`).

Today `turn-complete` is wired to single events. For Copilot it must be wired to `idle`, and the manager must understand that **multiple `assistant.usage` events accumulate into one turn cost** before idle fires. The fix:

- Adapter accumulates per-turn usage in a local total.
- On the provider's "loop done" event, adapter calls `cb.applyUsage(total)` and `cb.emitTurnComplete()`.

### 2.5 Permission abstraction (the hardest unification)

The three permission models do not share a vocabulary:

| Provider | Per-call gate | User Q&A | MCP form / URL |
|---|---|---|---|
| Claude | `canUseTool(toolName, input)` returns `{behavior:'allow', updatedInput?, ...}` or `{behavior:'deny', message, ...}` | `AskUserQuestion` tool (intercept by toolName; **answer with `{behavior: 'allow', updatedInput: {questions, answers}}`** where `answers` maps each question to chosen option `label`) | `onElicitation(request, {signal})` returning `{action:'accept'\|'decline'\|'cancel', content?}` |
| Codex | None — sandbox enum | None | None |
| Copilot | `onPreToolUse({toolName, toolArgs})` returns `'allow'\|'deny'\|'ask'`; if `'ask'` falls through to `onPermissionRequest({kind})` returning `{kind: 'approve-once' \| 'approve-for-session' \| 'approve-for-location' \| 'approve-permanently' \| 'reject' \| 'user-not-available' \| 'no-result'}` (the `approve-for-*` variants carry extra payload: `approval`, `domain`, `locationKey`; `reject` carries `feedback?`) | `onUserInputRequest({question, choices?, allowFreeform?})` | `onElicitationRequest({message, requestedSchema, mode, url?, elicitationSource?: string})` (note: `elicitationSource` is a plain string, not an object) |

Recommended unification — re-shape MultiTable's [packages/daemon/src/hooks/permissionManager.ts](packages/daemon/src/hooks/permissionManager.ts) to expose three provider-agnostic methods that adapters route into:

```ts
class PermissionManager {
  requestToolPermission(req: {
    sessionId, toolName, toolInput,
    paths?: string[],          // for path-based auto-defer
    title?, displayName?, subtitle?, blockedPath?,
    signal: AbortSignal,
  }): Promise<{ allow: boolean; updatedInput?: any; message?: string }>;

  requestUserQuestion(req: {
    sessionId,
    questions: { question, header?, options?: {label, description}[], multiSelect?, allowFreeform? }[],
    signal: AbortSignal,
  }): Promise<{ answers: string[][]; freeform?: string[] }>;

  requestElicitation(req: {
    sessionId, source: 'mcp' | 'agent', serverName?,
    message, mode: 'form' | 'url', url?, requestedSchema?,
    signal: AbortSignal,
  }): Promise<{ action: 'accept'|'decline'|'cancel'; content?: any }>;
}
```

Adapter responsibilities:

- **ClaudeAdapter** wires all three methods through `canUseTool` (with the AskUserQuestion-by-toolName branch — return `{behavior: 'allow', updatedInput: {questions, answers}}`, not deny+JSON) and `Options.onElicitation` (second arg is `{signal: AbortSignal}` options bag, not bare signal).
- **CodexAdapter** never calls them (sandbox handles everything).
- **CopilotAdapter** wires `onPreToolUse` → `requestToolPermission` (allow/deny direct mapping; `'ask'` fallthrough triggers `onPermissionRequest` whose 7-variant kind enum — `approve-once`, `approve-for-session`, `approve-for-location`, `approve-permanently`, `reject`, `user-not-available`, `no-result` — is translated into `requestToolPermission`'s `{allow, message?}` shape with the variant + payload preserved as metadata), `onUserInputRequest` → `requestUserQuestion`, `onElicitationRequest` → `requestElicitation`.

The UI (`PermissionPrompt`, `AskUserQuestion`, `ElicitationPrompt` components) doesn't change — it already speaks these three shapes for Claude.

### 2.6 Transcript parser per provider, same `Message[]` shape

[packages/daemon/src/transcripts/parser.ts](packages/daemon/src/transcripts/parser.ts) (Claude) and [packages/daemon/src/transcripts/codexParser.ts](packages/daemon/src/transcripts/codexParser.ts) (Codex) already share the contract: produce `Message[]` matching the SDK adapter output for live events, so the frontend treats live and historical identically.

For Copilot, add `packages/daemon/src/transcripts/copilotParser.ts`:

- Walk `~/.copilot/session-state/<sessionId>/checkpoints/`, sort numerically, read the **highest-numbered** snapshot.
- Map checkpoint records to `Message[]` (assistant, user, tool_use, tool_result, system kinds).
- Mint canonical ids stable across re-parses (Copilot's checkpoint ids are not guaranteed stable; use `copilot:{sessionId}:msg:{index}`).
- Defensive parser — Copilot SDK does not formally document checkpoint schema as stable.

Mirror the Codex pattern: `GET /api/transcripts/copilot` to list, `POST /api/transcripts/copilot/:id/resume` to fork a MultiTable session pointing at a prior copilot session.

### 2.7 Session id capture timing

| Provider | When id is known | Risk |
|---|---|---|
| Claude | After first `system.init` SDK message | Low — manager already handles this |
| Codex | After `thread.started` event | **Footgun**: aborting before this leaves thread unresumable. Disable Stop UI until id captured, or capture optimistically and clean up on early abort |
| Copilot | At `createSession` return | None — host supplies it (use MultiTable session uuid) |

### 2.8 Cost & usage projection

Add a `costSurface: 'usd' \| 'tokens-only'` flag (derived from `capabilities.costUsd`). UI consults this to render the dollar row. The Codex precedent (cost row hidden for `provider === 'codex'`) generalizes:

```tsx
{capabilities.costUsd ? <DollarRow ... /> : null}
<TokenRow ... />   // always shown
{capabilities.costUsd === false && <SmallNote>Cost not tracked for this provider</SmallNote>}
```

For Copilot, also surface `account.getQuota` results periodically (e.g., on session create + on `session.shutdown`) so users see remaining premium requests.

### 2.9 Mode/plan abstraction

Three different surfaces. Recommend a single store-level enum on `AgentSession`:

```ts
type SessionMode = 'default' | 'plan' | 'accept-edits' | 'auto' | 'chat' | 'read-only';
```

Adapter translates:

| Mode | Claude | Codex | Copilot |
|---|---|---|---|
| `default` | `permissionMode: 'default'` | `sandboxMode: 'workspace-write'` | normal config |
| `plan` | `permissionMode: 'plan'` | `sandboxMode: 'read-only'` (+ resume to write afterwards) | append plan-mode system prompt + `onPreToolUse` deny mutating |
| `accept-edits` | `permissionMode: 'acceptEdits'` | `sandboxMode: 'workspace-write'` + auto-approve all in `onPreToolUse` (via `approveAll` style) | `onPermissionRequest` returns approved for write kinds |
| `auto` | `permissionMode: 'bypassPermissions'` | `sandboxMode: 'danger-full-access'` (rare) | wire `approveAll` to all 3 callbacks |
| `chat` | omit tools / `disallowedTools: [<all>]` | `sandboxMode: 'read-only'` + system prompt no-tools | `tools: []` + `mcpServers: {}` + system prompt + deny-all hook |
| `read-only` | `disallowedTools: [Edit, Write, Bash, ...]` | `sandboxMode: 'read-only'` | `onPreToolUse` deny mutating |

UI exposes only modes supported by current provider (gated on `capabilities`).

**Copilot mode wire strings note:** Copilot's `ModeChangedData` uses `"interactive"` / `"plan"` / `"autopilot"` as the wire values (the CLI's user-facing copy calls them "Chat" / "Plan" / "Autopilot"). Map MultiTable's `SessionMode` → these wire strings when observing `session.mode_changed`. None of these are first-class `SessionConfig` fields — the recipes above (system prompt + `onPreToolUse` shaping) remain the only way to drive mode behavior from the SDK.

### 2.10 Hook unification

Don't try to unify all 29 Claude hooks. Instead, define a small "events-of-interest" stream the manager publishes into, fed by adapter-specific hook listeners:

```ts
type AdapterEvent =
  | { kind: 'session_start' }
  | { kind: 'session_end'; reason }
  | { kind: 'pre_tool_use'; toolName; toolArgs; toolUseId }
  | { kind: 'post_tool_use'; toolName; result; toolUseId }
  | { kind: 'compaction_start' | 'compaction_end' }
  | { kind: 'subagent_start' | 'subagent_end'; agentName?; agentId? }
  | { kind: 'notification'; message; severity? }
  | { kind: 'task_created' | 'task_completed'; taskId; title? };
```

- ClaudeAdapter wires the relevant subset of its 29 hooks down to this event set.
- CodexAdapter synthesizes these from its event stream (`task_started` → `session_start`, `command_execution.in_progress` → `pre_tool_use`, etc.).
- CopilotAdapter wires its 6 hooks + relevant events.

Manager subscribes once and runs all the existing side effects (currentTool, activeSubagents, alerts, labeler) regardless of provider.

### 2.11 Storage paths surfaced uniformly

Add a small per-provider helper exposed via `capabilities`:

```ts
sessionStoragePaths(s: AgentSession): {
  transcript: string;       // path to JSONL or checkpoint dir
  artifacts?: string;       // copilot's files/ dir
  plan?: string;            // copilot's plan.md
}
```

Used by the "open in Finder" button and the transcript browser.

---

## Part 3 — Files to be modified / added

### Modify

- [packages/daemon/src/agent/providers/types.ts](packages/daemon/src/agent/providers/types.ts) — expand `ProviderAdapter` with capabilities, lifecycle, listing, models methods. Define `ProviderCapabilities`, unified `AdapterEvent`, `SessionMode`.
- [packages/daemon/src/agent/manager.ts](packages/daemon/src/agent/manager.ts) — extract Claude inline logic into a new `ClaudeAdapter` that implements the contract; manager becomes truly provider-agnostic. Subscribe to `AdapterEvent` for cross-provider side effects (currentTool, subagent counts, labeler, alerts).
- [packages/daemon/src/agent/providers/codex.ts](packages/daemon/src/agent/providers/codex.ts) — implement new contract: `capabilities`, `loadMessages`, `listPriorSessions`, mode translation in `runTurn` opts.
- [packages/daemon/src/hooks/permissionManager.ts](packages/daemon/src/hooks/permissionManager.ts) — split into three provider-agnostic methods (`requestToolPermission`, `requestUserQuestion`, `requestElicitation`); adapters route into them.
- [packages/daemon/src/index.ts](packages/daemon/src/index.ts) — startup wiring for `CopilotClient` singleton between managers and server; SIGTERM hook to call `client.stop()`.
- [packages/daemon/src/types.ts](packages/daemon/src/types.ts) — add `provider: 'claude' \| 'codex' \| 'copilot'`, expand `PermissionPrompt` if Copilot's kind enum needs new fields.
- [packages/web/src/stores/appStore.ts](packages/web/src/stores/appStore.ts) — store `capabilities` per session; gate UI off them.
- [packages/web/src/components/main-pane/](packages/web/src/components/main-pane/) — cost panel reads `capabilities.costUsd`; mode switcher reads `capabilities.planMode`; model picker reads `capabilities.modelSwitchScope`.
- [packages/web/src/components/modals/AddAgentModal.tsx](packages/web/src/components/modals/AddAgentModal.tsx) — Copilot section (alongside existing Claude/Codex), including BYOK provider config fields.

### Add

- `packages/daemon/src/agent/providers/copilot.ts` — `CopilotAdapter` implementing the contract. Owns the `CopilotSession` cache; threads the three callbacks into the unified `PermissionManager`; reduces Copilot's per-call `assistant.usage` events into one per-turn total emitted on `session.idle`; subscribes to all relevant Copilot events and translates to `AdapterEvent`.
- `packages/daemon/src/agent/providers/claude.ts` — `ClaudeAdapter` extracted from manager (move `query()` invocation, `canUseTool`, `onElicitation`, hook registration here).
- `packages/daemon/src/transcripts/copilotParser.ts` — checkpoint-to-`Message[]` parser. Defensive: re-verify schema after each SDK upgrade. Mirror function names from [codexParser.ts](packages/daemon/src/transcripts/codexParser.ts) (`parseCopilotSession`, `findCopilotSessionFile`, `listCopilotSessions`).
- `packages/daemon/src/api/transcripts.ts` — add `GET /api/transcripts/copilot` and `POST /api/transcripts/copilot/:sessionId/resume` (mirror Codex routes).
- `packages/daemon/src/agent/streamBuffer.ts` — small helper class for additive vs cumulative reducers.

---

## Part 4 — Verification plan

### Per-provider smoke tests

1. **Claude:** existing flows continue to work (no behavior regression). Run a session with a tool call, an `AskUserQuestion`, an MCP elicitation, plan mode toggle, abort mid-stream, resume after restart. Confirm cost appears, hooks fire, JSONL parser reads transcript identically.
2. **Codex:** existing flows continue to work. Sandbox transitions (read-only ↔ workspace-write) via session resume. Abort mid-stream — confirm reconciliation reads disk JSONL and rebroadcasts. Confirm cost row hidden, token row populated, `currentTool` indicator working via synthesized `AdapterEvent`s.
3. **Copilot (new):**
   - First-turn: `createSession` with deterministic `sessionId` (use MultiTable uuid), confirm `session.start` and `assistant.message_delta` arrive, confirm `session.idle` fires.
   - Permission: trigger a shell tool, confirm `onPermissionRequest` routes through `PermissionManager.requestToolPermission`, both approve and deny paths work.
   - User Q&A: send a prompt that causes the agent to ask a clarifying question, confirm `onUserInputRequest` surfaces in UI.
   - Elicitation: configure an MCP server that emits `elicitation/create`, confirm form modal renders.
   - Resume after daemon restart: parse latest checkpoint, confirm `Message[]` matches what was on screen.
   - Abort: call `session.abort()`, confirm `session.idle` still fires, confirm next `send()` works on same session.
   - BYOK: provide `provider: {type: 'openai', apiKey}` and confirm session works; restart daemon and confirm resume requires re-supplying key.
   - Cost: confirm USD row appears (Copilot-only) and accumulates per-turn; quota fetch on session create.

### Cross-provider parity tests

- Same prompt across all three providers — confirm `Message[]` shape is identical at the WS layer (no provider field leaking into rendering).
- Mode switcher: confirm UI hides unsupported modes per `capabilities.planMode`.
- Cost panel: confirm Codex hides USD, Claude/Copilot show it.
- Model picker: confirm Copilot lists from `client.listModels()`, Claude/Codex show free-text input.

### Manual UI walkthrough

Run `npm run dev` (daemon + web), open `http://localhost:5173`:
- Add a Claude session, send a turn with a tool call requiring approval — modal works.
- Add a Codex session (same project), confirm cost row hidden, plan-mode workaround flow (read-only thread → resume workspace-write).
- Add a Copilot session, confirm BYOK fields visible (when provider selected), three callback flows surface in the existing prompt modals.
- In all three: open transcript browser, list prior sessions, resume one, confirm history hydrates.

No automated test framework exists yet ([CLAUDE.md](CLAUDE.md) confirms — do not invent `npm test`); rely on manual walkthrough + `npm run lint`.

---

## Part 5 — Implementation risks (from validation pass)

| Risk | Severity | Mitigation |
|---|---|---|
| Copilot SDK is in beta (stable `0.3.0` / beta `1.0.0-beta.2`); type shapes may shift | High | Pin a single version; re-run validation on every bump. Build a defensive checkpoint parser (no schema guarantee) |
| Copilot npm README is internally inconsistent — lists stale permission-decision names that don't match the runtime types | High | **Treat `.d.ts` as truth, not README**, when implementing CopilotAdapter. README's `denied-...` kinds are wrong; use `approve-once \| approve-for-session \| approve-for-location \| approve-permanently \| reject \| user-not-available \| no-result` |
| Codex `outputSchema` known bug #10393 (sometimes ignored) | Medium | Don't rely on `outputSchema` for critical paths; restate schema in prompt; validate host-side |
| Codex aborting before `thread.started` leaves thread unresumable | Medium | Disable Stop UI until id captured |
| Codex rollout filename contains hyphens in both date and UUID portions | Medium | Filename parser must use a UUID regex, not greedy splitting |
| Several "load-bearing" facts in earlier drafts of this plan were wrong (Claude AskUserQuestion answer shape, Copilot permission enum, Copilot cwd field name) | High (now resolved) | Validation pass corrected these inline; this doc is the merged source of truth |
| Claude `Query` interface has many methods worth surveying for future features (`setModel`, `getContextUsage`, `mcpServerStatus`, `setMcpServers`, `rewindFiles`, etc.) | Low | Worth a 30-minute scan of `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` before designing the ClaudeAdapter |
| Copilot has `defaultJoinSessionPermissionHandler` and `cliUrl` external-server mode, both undocumented in public README | Low | Don't expose in MultiTable until upstream docs exist |

---

## Part 6 — Open questions & bonus capabilities (from validation pass)

### 6.1 Unverified claims (build defensively around these)

These were stated in earlier drafts or in the upstream skill files but **could not be confirmed** against authoritative sources. Treat as best-guess; verify before depending on them.

**Claude:**
- `.mcp.json` autoload from cwd — documented for the Claude Code CLI, not surfaced as an explicit SDK type. Probably loaded via `settingSources: ['project']`. Confirm against `code.claude.com/docs/en/claude-code/mcp` before relying on autoload semantics.
- `'auto'` permission mode internals — JSDoc says "uses a model classifier" but the classifier model and decision criteria are opaque. Test empirically before exposing as a user-facing mode.
- `permission_denials` field on `SDKResultMessage` — present in types (`sdk.d.ts:3061, 3084`) but absent from public changelog. Useful for post-turn audit if it works as the field name suggests.
- Whether `Options.continue: true` works without cwd match — docs say resume is cwd-bound; `continue` is presumably the same.
- `Query.compactContext()` is **NOT** in `sdk.d.ts` despite being assumed in some early drafts. Compaction triggers via `PreCompact`/`PostCompact` hooks only.

**Codex:**
- "Resumed threads skip `thread.started`" — logically necessary (avoids overwriting known `_id`) but no upstream doc/source citation found. The SDK unconditionally honors the event if it arrives.
- `network_access` default in workspace-write mode — Rust source declares `bool` with `#[serde(default)]` so default is `false`, but docs are silent.
- "Granular approval policy useless from SDK" — logical extrapolation; whether the binary auto-denies vs. hangs vs. errors with closed stdin is undocumented per-version.
- `enabled_tools` precedence over `disabled_tools` — claimed but not externally documented.

**Copilot:**
- `customAgents` "auto-routed by classifier" — `subagent.selected` event fires, but the routing mechanism (classifier vs. tool delegation vs. explicit `agent.select`) is not publicly documented.
- `requestHeaders` lifetime semantics — preserved across compaction/retry? Interaction with `provider.headers`? Untested.
- "BYOK keys NEVER persisted" — strong implicit evidence (`ResumeSessionConfig` re-`Pick`s `provider`, forcing re-supply) but not literally documented.
- 10-section `SystemPromptSection` count — types comment "Unknown section IDs are handled gracefully" hints the runtime accepts new ones in future.
- `cliUrl` external-server mode — `copilotHome`, `sessionIdleTimeoutSeconds`, `remote` are all "ignored when using cliUrl". Production deployment patterns unclear.
- `defaultJoinSessionPermissionHandler` undocumented export (`dist/types.js:61-63`) — returns `{kind: "no-result"}`. Likely for joining as secondary client; behavior undocumented.

### 6.2 Bonus capabilities worth surveying

These were discovered during validation but aren't load-bearing for the initial integration. Worth a 30-minute pass before designing each adapter so we don't miss obvious wins.

**Claude — `Query` interface is much richer than the plan exercises.** `setModel`, `applyFlagSettings`, `initializationResult`, `supportedCommands`, `supportedModels`, `supportedAgents`, `mcpServerStatus`, `getContextUsage`, `readFile`, `reloadPlugins`, `accountInfo`, `rewindFiles`, `seedReadState`, `reconnectMcpServer`, `toggleMcpServer`, `setMcpServers`, `streamInput`, `stopTask`, `close`. Source: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1960-2163`.

**Claude — `tool()` and `AgentDefinition` extras.** `tool()` extras object accepts `searchHint?` and `alwaysLoad?` beyond `annotations`. `AgentDefinition` also has `initialPrompt` and `criticalSystemReminder_EXPERIMENTAL` fields. `systemPrompt` accepts a `string[]` variant using `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (in addition to `string` and the preset object).

**Codex — internal originator override.** SDK always re-injects `CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "codex_sdk_ts"` (`dist/index.js:232-234`). Useful for telemetry filtering if we ever add it.

**Copilot — `client.rpc.agent.{select, deselect, list, getCurrent, reload}`** is `@experimental` but available — would let us drive subagent selection explicitly rather than relying on auto-classification.

**Copilot — `client.rpc.history.{compact, truncate}`** is `@experimental` — could expose manual compaction in future.

### 6.3 Authoritative sources (for re-validation)

When SDK versions bump, re-check these:

**Claude (`@anthropic-ai/claude-agent-sdk`):**
- Installed types: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (5433 lines at v0.2.119)
- Official docs: `https://code.claude.com/docs/en/agent-sdk/{typescript,sessions,user-input,streaming-vs-single-mode,cost-tracking}`
- Changelog: `https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md`
- npm: `https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk`

**Codex (`@openai/codex-sdk`):**
- Installed package: `node_modules/@openai/codex-sdk/dist/{index.d.ts,index.js,README.md}` (v0.128.0)
- Rust source (the spawned binary): `github.com/openai/codex/codex-rs/{exec/src/cli.rs, utils/cli/src/shared_options.rs, config/src/types.rs, rollout/src/{recorder,list}.rs}`
- Docs: `https://developers.openai.com/codex/{cli/reference,config-reference}`
- Tracked issues: #20979 (subagent metadata, OPEN), #7144 (auth, CLOSED), #10393 (outputSchema bug, OPEN)

**Copilot (`@github/copilot-sdk`):**
- npm tarballs: `0.3.0` (stable), `1.0.0-beta.2` (beta) — extract and read `.d.ts` files directly
- Repo: `https://github.com/github/copilot-sdk` (auth docs at `docs/auth/index.md`)
- CLI dep: `https://www.npmjs.com/package/@github/copilot` (`^1.0.43-0`)
- **Don't trust the npm README** — it's internally inconsistent for `1.0.0-beta.2` (lists stale permission-decision names). Read `dist/generated/rpc.d.ts` and `dist/types.d.ts` instead.
