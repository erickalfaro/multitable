# SDK Migration Plan

## Context / why

MultiTable's session execution path currently spawns `claude --resume <id>` as a `node-pty` child and integrates with Claude Code through HTTP webhook hooks installed into each project's `.claude/settings.json`. That gives us a TUI we don't render (we ignore `pty-output` for sessions and read state out of the JSONL on disk via a chokidar tailer), routed through hooks that block Claude on synchronous HTTP responses for permissions. The `@anthropic-ai/claude-agent-sdk` collapses all of this — it speaks the same `~/.claude/projects/*.jsonl` storage as the CLI, exposes hooks as in-process callbacks, and gives us `canUseTool` for permissions without a network round trip. This migration rips out the PTY path for sessions only (commands and terminals stay on `PtyManager`), retires the hook installer/receiver, and turns the daemon into a thin orchestrator around `query()` calls. Constraint summary: clean cutover, no dual-mode flag; SDK persists JSONL so transcripts and the existing parser/browser keep working unchanged; the chat UI, `Message` type, permission cards, and WS contract for permissions stay; slash commands stay removed.

## Current vs target at a glance

| Component | Today | After |
|---|---|---|
| Session process | `node-pty` child running `claude --resume <id>` | `query()` from `@anthropic-ai/claude-agent-sdk`, no child process |
| Owner of session lifecycle | `PtyManager` (shared with cmds/terms) | New `AgentSessionManager`; `PtyManager` keeps cmds/terms |
| Conversation history source | chokidar tail of `~/.claude/projects/<enc>/<id>.jsonl` → `parseTranscript` → WS `session:transcript-delta` | SDK `assistant`/`user`/`stream_event` messages mapped to existing `Message` shape → WS `session:assistant-message` / `session:message-delta` (JSONL still on disk for browser/cost/option) |
| Hooks | HTTP receiver on `/api/hooks/*`, installed into every project's `.claude/settings.json` | In-process `options.hooks` callbacks on each `query()` |
| Permissions | `PreToolUse`/`PermissionRequest` HTTP hooks → `PermissionManager.handleHook()` → held-open `res.json(...)` | `options.canUseTool` callback → same `PermissionManager` state machine, returns SDK `PermissionResult` |
| Send a message | `wsClient.sendInput(id, text + '\r')` → PTY stdin | `POST /api/sessions/:id/turn` (or `ws:session:send`) → enqueues a turn on the agent session |
| Linking `claudeSessionId` | `SessionStart` HTTP hook | `system` SDK init message (`session_id`) on first `query()` |
| Cost / labeling / option detection | `PostToolUse` + `Stop` HTTP hooks + JSONL re-parse | SDK `result` and `assistant` message subscribers |
| Chat input "stopped" recovery | "Resume Claude" / "Spawn Claude" REST routes that re-spawn a PTY | Sending a turn auto-starts the session if needed; "Stop" cancels the in-flight async iterable |
| Frontend chat | `SessionChat` reads `messagesBySession` filled by `session:transcript-delta` | Same store, same component; messages now come from SDK-derived events |
| Crash detection / zombie guard / `respawnIfDead` for sessions | Live in `PtyManager.spawnPty` | Gone — try/catch around `query()` iteration handles errors |

---

## Phases

### Phase 0: Prep

- **Goal**: get the SDK installed, types in place, and skim/PoC the `query()` contract end-to-end without changing any production code path.
- **Touches**:
  - Modify: `packages/daemon/package.json` (add `@anthropic-ai/claude-agent-sdk@^0.2.120`).
  - Create: `packages/daemon/src/agent/sdkProbe.ts` — a tiny script you can run via `tsx` that calls `query()` once with `prompt: 'say hi'`, `cwd: process.cwd()`, prints every SDK message, and exits. Throwaway, deleted in Phase 8.
  - Create: `packages/daemon/src/agent/types.ts` (empty stub for now; populated in Phase 1).
- **What changes**: nothing user-visible. We confirm: (a) `ANTHROPIC_API_KEY` or `~/.claude/auth.json` is being picked up; (b) the `system` init message carries `session_id`; (c) the JSONL appears at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` exactly where the existing `getSessionJsonlPath()` expects it; (d) `result.total_cost_usd` shows up. Verify the SDK version we install matches the documented hook signatures (`{ matcher, hooks: [async (input, toolUseId, { signal }) => HookOutput] }`); freeze that version in the lockfile.
- **Verification**: `npx tsx packages/daemon/src/agent/sdkProbe.ts` round-trips a tiny prompt and writes a JSONL file we can `cat`.
- **Rollback**: `git revert` the dep bump and delete `agent/`.

---

### Phase 1: Introduce the `AgentSession` abstraction (additive, dormant)

- **Goal**: define the new types and an `AgentSessionManager` skeleton, wired into `server.ts` but not used by any code path yet.
- **Touches**:
  - Modify: `packages/daemon/src/types.ts` — add new types alongside `ManagedProcess`. Do NOT touch `ManagedProcess`.
  - Create: `packages/daemon/src/agent/manager.ts` — `AgentSessionManager` class, EventEmitter, holds in-memory `Map<sessionId, AgentSession>`. Empty methods.
  - Create: `packages/daemon/src/agent/types.ts` — see skeleton below.
  - Modify: `packages/daemon/src/index.ts` — instantiate `AgentSessionManager` after `PtyManager`, pass into `createServer`.
  - Modify: `packages/daemon/src/server.ts` — accept the new manager, wire its events to `broadcast` (no-op for now).
- **What changes**: type surface only. New abstraction:

```ts
// packages/daemon/src/agent/types.ts
import type { ProcessState } from '../types.js';

// What we emit on the WS for the session view.
export type AgentMessageOut =
  | { kind: 'assistant'; text: string; model?: string; ts: number }
  | { kind: 'tool_use'; toolUseId: string; toolName: string; input: unknown; ts: number }
  | { kind: 'tool_result'; toolUseId: string; output: string; isError?: boolean; ts: number }
  | { kind: 'user'; text: string; ts: number }
  | { kind: 'system'; text: string; ts: number };

export interface AgentSession {
  // === identity ===
  id: string;                     // multitable session id (DB primary key)
  projectId: string;
  name: string;
  workingDir: string;
  // === claude link ===
  claudeSessionId: string | null; // mirrored to DB; learned from SDK init
  // === lifecycle ===
  state: ProcessState;            // 'running' while a turn is in-flight, else 'idle'/'stopped'/'errored'
  startedAt: Date | null;
  // === current turn ===
  currentTurn: {
    abortController: AbortController;
    startedAt: number;
    promptPreview: string;
  } | null;
  // === stats (replaces the in-memory ClaudeSessionState) ===
  totalCostUsd: number;
  tokensIn: number;
  tokensOut: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  toolCount: number;
  currentTool: string | null;
  activeSubagents: number;
  lastActivity: number;
  label: string | null;
  userMessages: string[];         // for labeler input
}

export interface SendTurnInput {
  sessionId: string;
  text: string;                   // user prompt; may contain @file mentions, attachment paths
}
```

```ts
// packages/daemon/src/agent/manager.ts
import { EventEmitter } from 'events';
import type { AgentSession, SendTurnInput } from './types.js';

export class AgentSessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>();
  // Stub methods, all throw "not implemented" in this phase.
  register(_s: Omit<AgentSession, 'state' | 'currentTurn' | /* ...stats... */ 'lastActivity' | 'userMessages'>): AgentSession { /* ... */ throw new Error('not yet'); }
  get(id: string): AgentSession | undefined { return this.sessions.get(id); }
  getAll(): AgentSession[] { return [...this.sessions.values()]; }
  async sendTurn(_input: SendTurnInput): Promise<void> { throw new Error('not yet'); }
  abortTurn(_id: string): void { throw new Error('not yet'); }
  remove(_id: string): void { throw new Error('not yet'); }
}
```

- **Verification**: daemon still boots; `npm run build` clean; nothing functionally different.
- **Rollback**: revert this single commit. Nothing depends on the new types yet.

---

### Phase 2: Implement `AgentSessionManager.sendTurn()` end-to-end (parallel path, not yet wired to UI)

- **Goal**: behind a private endpoint `POST /api/_internal/agent/turn`, prove an SDK round-trip emits messages we can broadcast to subscribers in the existing `Message` shape. Sessions still spawn the PTY as today; this is purely additive.
- **Touches**:
  - Create: `packages/daemon/src/agent/sdkAdapter.ts` — pure functions converting `SDKMessage` → `Message[]` (the same `Message` union from `transcripts/parser.ts`). One assistant SDK message can produce multiple `Message`s (text blocks + tool_use blocks); a `user` SDK message with a tool_result block produces one `tool_result`. Use the same shape `parseTranscriptContent` already produces so the frontend treats them identically.
  - Modify: `packages/daemon/src/agent/manager.ts` — implement `sendTurn`:

```ts
async sendTurn({ sessionId, text }: SendTurnInput): Promise<void> {
  const s = this.sessions.get(sessionId);
  if (!s) throw new Error(`unknown session ${sessionId}`);
  if (s.currentTurn) throw new Error('turn already in flight');
  const ctrl = new AbortController();
  s.currentTurn = { abortController: ctrl, startedAt: Date.now(), promptPreview: text.slice(0, 80) };
  s.state = 'running';
  s.userMessages.push(text);
  this.emit('state-changed', { sessionId, state: 'running' });
  this.emit('user-message', { sessionId, text });

  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const it = query({
      prompt: text,
      options: {
        cwd: s.workingDir,
        // Resume if we have a prior conversation; otherwise the SDK will create one.
        ...(s.claudeSessionId ? { resume: s.claudeSessionId } : {}),
        settingSources: ['project', 'user'],
        permissionMode: 'default',
        canUseTool: this.makeCanUseTool(sessionId),       // wired in Phase 5
        hooks: this.makeHooks(sessionId),                 // wired in Phase 6
        includePartialMessages: false,                    // start without; revisit later
        abortController: ctrl,                            // NOTE: the SDK accepts the controller, not its signal
      },
    });
    for await (const msg of it) {
      this.handleSdkMessage(sessionId, msg);
    }
  } catch (err) {
    s.state = 'errored';
    this.emit('turn-error', { sessionId, error: String(err) });
  } finally {
    s.currentTurn = null;
    if (s.state === 'running') s.state = 'idle';
    this.emit('turn-complete', { sessionId });
    this.emit('state-changed', { sessionId, state: s.state });
  }
}
```

In `handleSdkMessage`, on `system` with `subtype === 'init'` capture `session_id` if missing → write to DB (`updateSession(id, { claudeSessionId })`) → emit `session:updated` so the frontend learns the link. On `assistant` and `user` (tool_result) messages, run them through `sdkAdapter` and emit `session:assistant-message` (or `session:tool-event`) with the resulting `Message[]`. On `result`, capture `total_cost_usd` + `usage`, update the in-memory totals, write a `cost_records` row.

**IMPORTANT — tolerate unknown message types.** The `SDKMessage` union has ~30 variants (verified Phase 0): `rate_limit_event`, `stream_event`, `tool_progress`, `hook_started`, `hook_progress`, `hook_response`, `compact_boundary`, `status`, `api_retry`, `local_command_output`, `plugin_install`, `auth_status`, `task_notification`, `task_started`, `task_updated`, `task_progress`, `session_state_changed`, `notification`, `files_persisted_event`, `tool_use_summary`, `memory_recall`, `elicitation_complete`, `prompt_suggestion`, `mirror_error`, `user_message_replay`, `partial_assistant`, and more. `handleSdkMessage` must use a `switch(msg.type)` with a `default: /* ignore */` branch rather than exhaustive-match or throw. Only react to the types we care about today (`system` init, `assistant`, `user`, `result`); all others are silently dropped.

  - Modify: `packages/daemon/src/server.ts` — add `app.post('/api/_internal/agent/turn', ...)` that calls `agentManager.sendTurn`. Wire `agentManager.on('assistant-message')` etc. to `sendToSubscribers`. Behind `_internal` so it's clearly experimental.
- **What changes**: a manual `curl -X POST /api/_internal/agent/turn -d '{"sessionId":"...","text":"hi"}'` exercises the full SDK path and the frontend still works on the PTY path. Nothing in the UI uses this yet.
- **Verification**: against a known session id (registered manually in Phase 2's test), curl the internal endpoint and observe `session:assistant-message` messages on the WS. Confirm the JSONL file gets written to the same path the existing `parseTranscript` reads from. Run `GET /api/sessions/:id/messages` afterward — it should return the new turn's messages from the JSONL.
- **Rollback**: revert this commit. The `_internal` endpoint is the only entry point; nothing else calls it.

---

### Phase 3: Boot-time registration (replace autostart spawn for sessions)

- **Goal**: at daemon boot, sessions are loaded into `AgentSessionManager` as `idle` (not started). No `claude` PTY is spawned for any session, ever. Commands and terminals continue to autostart through `PtyManager` unchanged.
- **Touches**:
  - Modify: `packages/daemon/src/index.ts` — in the autostart loop, replace the `for (const session of sessions) { if (session.autostart) manager.spawn(...) / manager.register(...) }` block with `for (const session of sessions) agentManager.register({ id, projectId, name, workingDir, claudeSessionId, ... })`. Leave the file watcher branch (`fileWatcher.watchPatterns(...)`) as-is — but wire the restart callback to `agentManager.abortTurn(...)` (no-op restart for sessions; commands still call `manager.restart`).
  - Modify: `packages/daemon/src/api/sessions.ts` — `GET /api/sessions` and `GET /api/sessions/:id` must read state from `agentManager.get(id)` instead of `manager.get(id)` for sessions.
  - Modify: `packages/daemon/src/api/sessions.ts` — keep `start`, `stop`, `restart`, `spawn-claude`, `resume-claude` working but reroute them through `agentManager`:
    - `start`/`spawn-claude`/`resume-claude` collapse into a single concept: there is no "start", because turns auto-start the session. Make these endpoints idempotent no-ops that return current state. (Keep the route to avoid 404s from stale UI; mark deprecated in code comments; remove in Phase 8.)
    - `stop` → `agentManager.abortTurn(id)` (cancels in-flight `query()`; does not "kill" anything else because there's no process).
    - `restart` → same as stop (there is no restart concept; turns are stateless from our side).
- **What changes**: the daemon no longer ever invokes `claude` as a PTY for a session. The `subscribe` flow in `pty/stream.ts` still attaches to `PtyManager` for sessions and finds nothing → that bug is fixed in Phase 4.
- **Verification**: boot the daemon with an existing session that has a `claudeSessionId`. Confirm: (a) no `claude` child process appears in `ps`; (b) the session shows up in `GET /api/sessions` with `state: 'idle'`; (c) `GET /api/sessions/:id/messages` still returns history from the JSONL.
- **Rollback**: revert. UI may show "stopped" on every session until it sends a turn, which is acceptable for the few minutes between phases.

---

### Phase 4: New WS contract for sessions, and the input path (the cutover)

- **Goal**: the chat composer talks to the SDK path; the PTY path for sessions is removed.
- **Touches**:
  - Modify: `packages/daemon/src/pty/stream.ts` — in `handleSubscribe`, when the resolved process is a session, **do not** call `manager.respawnIfDead`, **do not** spawn through `PtyManager`. Instead:
    - Look up `agentManager.get(id)`; if missing, register from DB.
    - Skip the `pty-output` data listener entirely for sessions. (Commands and terminals still get it.)
    - Replace `tailers.subscribe(processId, jsonlPath)` with subscription to `agentManager` events. Concretely: register listeners that forward to this client only:
      - `assistant-message` → `session:assistant-message` `{ messages: Message[] }`
      - `tool-event` → `session:tool-event` `{ message: Message }` (used for tool_use and tool_result blocks)
      - `user-message` → `session:user-message` `{ message: Message }` (for the user's prompt — frontend appends optimistically too, so dedupe by `id`)
      - `turn-complete` → `session:turn-complete` `{ totalCostUsd, usage }`
      - `state-changed` → already broadcast globally as `process-state-changed`, no per-subscriber duplication
    - Push the listener-removal closure onto `clientState.cleanups`.
  - Modify: `packages/daemon/src/pty/stream.ts` — add a new WS message type `session:send` `{ processId, text }` → calls `agentManager.sendTurn({ sessionId: processId, text })`. Reject `pty-input` for session processes (or silently ignore — log once).
  - Modify: `packages/daemon/src/server.ts` — promote the Phase-2 `_internal/agent/turn` to public `POST /api/sessions/:id/turn` `{ text }`. Both WS and REST entry points are fine; pick WS as primary (lower latency, same socket as the subscription).
  - Modify: `packages/web/src/lib/ws.ts` — add `sendTurn(sessionId: string, text: string)` that emits `{ type: 'session:send', processId, payload: { text } }`. Add no-op handlers for `pty-input` to sessions in callers (catch via `processId`).
  - Modify: `packages/web/src/components/main-pane/chat/ChatInputCM.tsx` — replace `sendToPty` with `wsClient.sendTurn(processId, text)`. Drop the bracketed-paste wrapping (`PASTE_START`/`PASTE_END` + `\r`) — they're meaningful only to a TUI.
  - Modify: `packages/web/src/components/main-pane/chat/SessionChat.tsx` — keep the `useEffect` that calls `wsClient.subscribe(sessionId, …)` (the dimensions are now meaningless for sessions but harmless; consider stripping). Remove the `wsClient.on('session:transcript-delta')` listener path here — the listener moves to global handling in `App.tsx` so messages route through `messagesBySession` like before.
  - Modify: `packages/web/src/App.tsx` — replace the global `session:transcript-delta` handler with handlers for `session:assistant-message`, `session:tool-event`, `session:user-message`. All three call `store.appendMessages(processId, …)` exactly as before. Keep `session:transcript-delta` registered as a **deprecated** alias for one release so a daemon mid-rollout doesn't desync the frontend; remove in Phase 8.
- **What changes**: this is the real cutover. After this phase ships:
  - User types a message → `session:send` → `agentManager.sendTurn` → SDK `query()` → events stream back.
  - Permissions are still HTTP-driven (Phase 5 swaps that).
  - Hooks-driven cost/state still work because `.claude/settings.json` is still installed (Phase 6 retires that).
- **Verification**: full round-trip from the chat UI. Send a prompt; assistant reply appears; a tool call shows a permission card (still through old hook path); approve; tool runs; result appears; cost ticks. Turn ends; status flips to idle. Browse the JSONL in `~/.claude/projects/...` — it's there.
- **Rollback**: revert the commits. The hooks installer is still active so the PTY path can be re-enabled by reverting `pty/stream.ts` and the autostart change.

---

### Phase 5: Move permissions onto `canUseTool`

- **Goal**: `PermissionManager`'s state machine is unchanged. The HTTP receiver no longer participates in permission decisions.
- **Touches**:
  - Modify: `packages/daemon/src/hooks/permissionManager.ts` — add a new entry point `requestFromSdk(sessionId, claudeSessionId, toolName, toolInput, signal): Promise<PermissionResult>`. Internally builds the same `PermissionPrompt`, emits `permission:prompt`, and resolves the promise instead of writing to an Express `Response`. Reuses dedup, allowlist, auto-defer, and timeout. The existing `respond(id, decision, updatedInput)` and `respondAskQuestion(id, answers)` remain the resolution path. Returned value follows the SDK shape:

```ts
// Real SDK shape (verified in Phase 0 against @anthropic-ai/claude-agent-sdk@0.2.119):
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };   // message is REQUIRED on deny
```

  Translate the `'always-allow'` decision the same way it works today: cache in `sessionAllowList`, return `behavior: 'allow'`. When denying, always pass a non-empty `message` (e.g., `'Denied by user'` or the user's typed reason).

  - Modify: `packages/daemon/src/agent/manager.ts` — implement `makeCanUseTool(sessionId)`:

```ts
// Real signature (verified Phase 0): the options bag includes title/displayName/subtitle
// (SDK-rendered strings we should prefer in the permission UI) plus suggestions,
// blockedPath, decisionReason. Accept broadly; extract what the UI needs.
type CanUseToolOpts = {
  signal: AbortSignal;
  title?: string;
  displayName?: string;
  subtitle?: string;
  blockedPath?: string;
  decisionReason?: string;
  suggestions?: unknown;
};

private makeCanUseTool(sessionId: string) {
  return async (toolName: string, toolInput: Record<string, unknown>, opts: CanUseToolOpts) => {
    const s = this.sessions.get(sessionId)!;
    return await this.permManager.requestFromSdk(
      sessionId,
      s.claudeSessionId ?? '',
      toolName,
      toolInput,
      opts.signal,
      { title: opts.title, displayName: opts.displayName, subtitle: opts.subtitle, blockedPath: opts.blockedPath },
    );
  };
}
```

Propagate `title`/`displayName`/`subtitle` into `PermissionPrompt` so the frontend can render Claude's own labels instead of re-deriving them from `toolName`.

  - Modify: `packages/daemon/src/hooks/receiver.ts` — gut `pre-tool-use` and `permission-request` routes to log + return `{}`. (They're going away in Phase 6 entirely; in this phase we just stop them from gating.)
  - Modify: `packages/daemon/src/pty/stream.ts` — `handlePermissionRespond` and `handleAnswerQuestion` are unchanged; they still call `permManager.respond` / `permManager.respondAskQuestion`. The downstream is now a Promise resolution rather than an HTTP response.
  - The frontend (`PermissionBar`, etc.) is **not touched**: same WS events, same payloads.

- **What changes**: tool permissions go through the SDK callback. `AskUserQuestion`'s "deny with reason as answer" trick still works — the SDK treats `behavior: 'deny'` with a `message` as the tool result for that tool call, which is exactly what we want.
- **Verification**: trigger a Bash tool call. Card appears; allow it; tool runs. Trigger an `AskUserQuestion`; web UI renders questions; user picks; Claude proceeds with the answer. Verify `Read`/`Grep`/`Glob` still auto-defer.
- **Rollback**: revert. Hooks-based `PreToolUse` will resume gating.

---

### Phase 6: Retire the hook installer; move every hook to SDK callbacks

- **Goal**: `.claude/settings.json` is no longer touched. All hook logic that we depend on lives in `options.hooks` callbacks on each `query()`.
- **Touches**:
  - Modify: `packages/daemon/src/agent/manager.ts` — implement `makeHooks(sessionId)` returning the SDK hook map:

```ts
private makeHooks(sessionId: string) {
  return {
    PreToolUse: [{ matcher: '*', hooks: [async (input) => {
      // currentTool tracking (was in receiver.ts)
      const s = this.sessions.get(sessionId);
      if (s && input.tool_name !== 'AskUserQuestion') s.currentTool = input.tool_name;
      // No decision here — canUseTool handles approval. Return continue.
      return { continue: true };
    }] }],
    PostToolUse: [{ matcher: '*', hooks: [async (input) => {
      const s = this.sessions.get(sessionId);
      if (s) {
        s.toolCount++;
        s.currentTool = null;
        s.lastActivity = Date.now();
        // usage tracking moves to result-message handling below; keep this lean.
        this.emit('state-changed-stats', { sessionId, snapshot: this.snapshot(s) });
      }
      return { continue: true };
    }] }],
    UserPromptSubmit: [{ matcher: '*', hooks: [async (input) => {
      // Auto-rename on first prompt (was in receiver.ts).
      const s = this.sessions.get(sessionId);
      if (s) {
        const isFirst = s.userMessages.length === 1;  // already pushed in sendTurn
        if (isFirst) this.maybeRenameFromFirstPrompt(sessionId, s.userMessages[0]);
      }
      return { continue: true };
    }] }],
    Stop: [{ matcher: '*', hooks: [async () => {
      // Trigger labeler + option-detection (was in receiver.ts).
      this.runStopHooks(sessionId);
      return { continue: true };
    }] }],
    SubagentStart: [{ matcher: '*', hooks: [async () => {
      const s = this.sessions.get(sessionId); if (s) s.activeSubagents++;
      return { continue: true };
    }] }],
    SubagentStop: [{ matcher: '*', hooks: [async () => {
      const s = this.sessions.get(sessionId); if (s) s.activeSubagents = Math.max(0, s.activeSubagents - 1);
      return { continue: true };
    }] }],
    Notification: [{ matcher: '*', hooks: [async (input) => {
      // Surface as toast — was hook:Notification. Frontend listener stays.
      this.emit('notification', { sessionId, message: input?.message });
      return { continue: true };
    }] }],
    SessionStart: [{ matcher: '*', hooks: [async (input) => {
      // Optional: capture cwd if it differs.
      return { continue: true };
    }] }],
    SessionEnd: [{ matcher: '*', hooks: [async () => {
      this.emit('session:ended', { sessionId });
      return { continue: true };
    }] }],
  };
}
```

  - Modify: `packages/daemon/src/index.ts` — delete the entire `// 5. Install hooks for each registered project` block (the `hookManager.installForProject(...)` loop).
  - Modify: `packages/daemon/src/server.ts` — remove `app.use('/api/hooks', createHooksRouter(...))`.
  - Modify: `packages/daemon/src/api/sessions.ts` — `getClaudeState(req.params.id)` (used in `/prompts` fallback) is gone; replace with `agentManager.get(id)?.userMessages` directly.
  - Optional: leave `installer.ts` as a one-shot **uninstaller** that runs once at boot and removes any previously-installed hook entries from each project's `.claude/settings.json`. Remove that helper after one release.
- **What changes**: no more curl-based blocking RPCs from Claude back into us. Hook callbacks are awaited in-process, with proper backpressure.
- **Verification**: delete `.claude/settings.json`'s hook entries from a test project; send a turn; everything still works (cost, currentTool tracking, label generation, Stop toast).
- **Rollback**: revert; re-enable the installer call in `index.ts`.

---

### Phase 7: Move cost / labeler / option-detection to SDK subscribers

- **Goal**: cost and option detection no longer rely on JSONL re-parses kicked off by hooks. They become pure subscribers to `agentManager` events.
- **Touches**:
  - Modify: `packages/daemon/src/agent/manager.ts` — on the SDK's `result` message (`subtype === 'success'` etc.), update `totalCostUsd`, `tokensIn`, `tokensOut`, etc. directly from `result.usage`/`result.total_cost_usd`. Insert a `cost_records` row. Broadcast `session:state-updated`. This obsoletes `parseSessionCost(...)` for live updates (we keep the function for the `/api/sessions/:id/cost` endpoint as a fallback when the in-memory state is empty after a daemon restart).
  - Modify: `packages/daemon/src/agent/manager.ts` — `runStopHooks(sessionId)` invokes `detectOptions(workingDirectory, claudeSessionId)` (still a JSONL read; cheap and isolated) and the labeler `generateSessionLabel(s.userMessages)`. Same emission as today: `session:options-detected`, `session:label-updated`. (We can reimplement option-detection directly off the last assistant message we just emitted, but JSONL is fine.)
  - Modify: `packages/daemon/src/api/sessions.ts` — `/cost` endpoint: prefer in-memory `agentManager.get(id)` totals; fall back to `parseSessionCost` for cold-start/historical sessions where the daemon never received the `result` message.
  - Optional cleanup: `costParser.ts` shrinks to only what `/cost` needs; private `getSessionJsonlPath` already lives in `transcripts/parser.ts` — dedupe.
- **What changes**: cost figures show up faster (we don't wait for JSONL flush + chokidar event). Option detection unchanged behaviorally.
- **Verification**: send a multi-turn conversation; observe `session:state-updated` with progressive cost growth; observe option detection still firing on numbered lists.
- **Rollback**: revert.

---

### Phase 8: Cleanup pass

- **Goal**: delete every file/branch that's now dead.
- **Touches** (delete or trim aggressively):
  - **Delete**: `packages/daemon/src/transcripts/tail.ts` and `TranscriptTailerRegistry`. The `session:transcript-delta` event is gone. The transcript browser (`/api/transcripts`) keeps working — it reads the JSONL files the SDK writes; nothing changed there.
  - **Delete**: `packages/daemon/src/hooks/installer.ts`.
  - **Delete**: `packages/daemon/src/hooks/receiver.ts` (or shrink to nothing and remove the route).
  - **Delete**: `packages/daemon/src/agent/sdkProbe.ts`.
  - **Modify** `packages/daemon/src/pty/manager.ts`:
    - Drop the entire session-specific code path: the `--resume` handling in `spawnPty`, the `'No conversation found'` detector, the `/$bunfs/root/src/entrypoints/cli.js` zombie/crash detection, the `resume-failed` event, the `register()` method's session branch.
    - `respawnIfDead` no longer special-cases sessions.
    - `write()` no longer needs the zombie guard.
    - `startScrollbackFlushing` keeps writing scrollback for **command** processes (sessions don't go through PTY anymore — kill the `proc.type === 'session'` check).
    - `PARENT_CLAUDE_ENV_KEYS` scrubbing can stay (it's harmless and useful if a user runs `claude` as a command).
  - **Modify** `packages/daemon/src/pty/stream.ts`:
    - In `handleSubscribe`, remove the entire DB-lookup-and-spawn-from-stream branch for `session` type (Phase 4 already routes it to `agentManager`). Sessions never spawn from `subscribe`.
    - `pty-input` and `pty-resize`: silently return when the target is a session.
    - Remove `tailers` parameter and all `transcripts/tail` references.
  - **Modify** `packages/daemon/src/api/sessions.ts`:
    - Delete `/start`, `/restart`, `/resume-claude`, `/spawn-claude`, `/stop` routes (or replace `/stop` with one that calls `agentManager.abortTurn`). The new `/turn` is the only lifecycle action.
    - `buildClaudeCommand` → delete.
    - `defaultProcessConfig` → delete (sessions don't have a process config anymore).
    - The `command` and `autorestart*` columns on `sessions` become dead in practice; keep the schema for now (cheap), drop in a future migration.
  - **Modify** `packages/daemon/src/api/processes.ts`:
    - Sessions are no longer in `manager.getAll()`. `/api/processes` for type=session returns from `agentManager.getAll()`. The `start`/`stop`/`restart`/`input`/`resize`/`scrollback` endpoints reject session ids with 400. UI calls these via the generic processes router for cmds/terms; the session-specific UI uses `/api/sessions/:id/turn`.
  - **Modify** `packages/daemon/src/types.ts`: remove `claudeSessionId` from any place we still relied on it transiting through `ManagedProcess`. `ClaudeSessionState` is now redundant with `AgentSession`'s stat fields — delete it once the frontend types are aligned.
  - **Modify** `packages/daemon/src/server.ts`:
    - Drop `transcripts/tail` import + registry.
    - Drop `manager.on('resume-failed')` wiring (event no longer emitted).
    - Drop `permManager.on('permission:expired')` if it's only used when HTTP receiver was the only timeout source — actually keep it; the in-process resolution still fires it for cleanup.
  - **Modify** `packages/web/src/App.tsx`:
    - Remove the deprecated alias listener for `session:transcript-delta`.
    - Remove `wsClient.on('session:resume-failed')` (event removed).
    - Remove `wsClient.on('hook:Notification')` and `wsClient.on('hook:Stop')` if we re-emit those as `session:notification` / `session:turn-complete` (cleaner names; do it).
  - **Modify** `packages/web/src/components/main-pane/chat/SessionChat.tsx`:
    - Remove the `DEFAULT_COLS`/`DEFAULT_ROWS` constants and the `wsClient.subscribe(sessionId, { cols, rows })` dims — `subscribe` for sessions just attaches the WS client to receive events, dims are noise.
  - **Modify** `packages/web/src/lib/types.ts`:
    - `ClaudeSessionState.userMessages` no longer flows from a hook — it's an `AgentSession` field. Either keep `ClaudeSessionState` as the public-facing UI shape and have the daemon project from `AgentSession` to `ClaudeSessionState` for the `session:state-updated` payload (preserves the frontend type), or rename. Pick the projection — fewer frontend churn.

- **Verification**: `git grep` for: `installer`, `transcript-delta`, `tailers`, `pty-output.*session`, `resume-failed`, `--resume`, `spawnPty.*session`, `claude --resume`. All should be empty (or only inside docs/comments referencing the migration).
- **Rollback**: revert this commit; it's purely deletes — easy.

---

## Cleanup list

Scheduled by phase:

- **Phase 6 deletes**:
  - `packages/daemon/src/hooks/receiver.ts` — entire file. (~427 lines)
  - `packages/daemon/src/hooks/installer.ts` — entire file. (~183 lines)
  - `app.use('/api/hooks', ...)` registration in `server.ts`.
  - `// 5. Install hooks for each registered project` block in `index.ts`.
  - `getClaudeState`, `ensureClaudeState` exports — call sites disappear when receiver is gone; replace with `agentManager.get(id)`.
- **Phase 7 deletes**:
  - The "best effort JSONL re-parse on Stop" branch in receiver (already gone with file deletion).
  - `manager.on('resume-failed')` and the matching frontend toast.
- **Phase 8 deletes**:
  - `packages/daemon/src/transcripts/tail.ts` — entire file. (~160 lines)
  - `TranscriptTailerRegistry` instantiation in `server.ts`; `tailers` param everywhere.
  - The `--resume`/`No conversation found`/`/$bunfs/.../cli.js` crash-detection block in `pty/manager.ts:spawnPty` (~70 lines).
  - The `proc.type === 'session'` branch in `respawnIfDead` and the zombie guard in `write()`.
  - `PtyManager.register()` becomes commands-only (or deletable; it was added for sessions).
  - `claudeSessionId` plumbing through `pty/stream.ts:handleSubscribe`.
  - `/api/sessions/:id/start`, `/restart`, `/spawn-claude`, `/resume-claude`. `buildClaudeCommand`. `defaultProcessConfig` (in sessions router).
  - Frontend `session:transcript-delta` handler in `App.tsx`.
  - Frontend `session:resume-failed` handler in `App.tsx`.
  - `DEFAULT_COLS` / `DEFAULT_ROWS` in `SessionChat.tsx`.
  - `getClaudeState`-imported state in `api/sessions.ts:/prompts` route — replace with `agentManager.get(id)?.userMessages`.

---

## Concurrency model

**Decision**: one `query()` call per user turn, sequential per session. The user sends N; we await `query({ prompt: N, options: { resume: claudeSessionId, ... } })`; we drain its async iterable; we mark `currentTurn = null`; the next turn starts a new `query()` resuming the same session. Tradeoffs:

- **Pro**: simple. Each turn has a clean lifecycle; an abort kills exactly that turn. Errors are isolated. Resuming via `resume: claudeSessionId` is exactly what the SDK is designed for and matches how the JSONL is written. Multi-tab chat is naturally serialized at the manager level (we reject `sendTurn` while `currentTurn != null`, returning `409 turn-in-flight` so the UI can show "wait for current turn").
- **Con**: small per-turn overhead (re-establish context). Can't stream user-side input mid-tool. We don't need that.

**Rejected alternative**: long-lived `query()` with async-iterable prompt. More complex (need to manage the input queue, per-tab fan-out is harder, error handling spans multiple turns). Revisit only if turn-startup latency becomes a real complaint.

**Multi-tab safety**: if Tab A is mid-turn and Tab B sends, the daemon's `sendTurn` returns 409. UI in Tab B shows a "session busy — waiting for current turn" indicator that resolves when `session:turn-complete` arrives.

---

## WS event compatibility

**Keep (unchanged contracts)**:
- `process-state-changed`, `process-metrics`, `process-exited` — still used by commands/terminals; sessions emit `process-state-changed` from `AgentSessionManager` with the same payload shape.
- `permission:prompt`, `permission:resolved`, `permission:expired` — same payloads, same flow on the wire.
- `permission:respond`, `permission:answer-question` (client → server) — unchanged.
- `session:updated`, `session:created`, `session:deleted` — unchanged.
- `option:prompt`, `session:options-detected`, `session:label-updated` — unchanged.

**Add**:
- `session:assistant-message` `{ messages: Message[] }` — text + tool_use blocks for one assistant turn.
- `session:user-message` `{ message: Message }` — confirms what we recorded for the turn.
- `session:tool-event` `{ message: Message }` — `tool_result` from the tool execution side; rendered by `ToolCallCard`.
- `session:turn-complete` `{ totalCostUsd, usage, stopReason }` — fires when the result message arrives.
- `session:state-updated` `{ sessionId, state: { ...stats } }` — replaces the receiver's old broadcast of the same name; payload shape preserved.
- `session:notification` `{ sessionId, message }` — replaces `hook:Notification` (rename for consistency; old name can stay as alias for one release).
- `session:send` (client → server) `{ processId, payload: { text } }` — new input path.

**Delete**:
- `session:transcript-delta` — supplanted by `session:assistant-message` + friends.
- `session:resume-failed` — concept doesn't apply; SDK either resumes successfully or errors the turn (handled by `turn-error`).
- `hook:*` — every namespaced hook event the receiver fanned out. Replaced by specific session events for the ones we actually use (Notification, Stop). Verify nothing in `App.tsx` consumes others.
- `pty-output` / `pty-input` / `pty-resize` for session ids — daemon ignores; frontend won't send them anymore.
- `scrollback` for sessions — sessions never had useful PTY scrollback; chat uses `messagesBySession`.

---

## Input path contract

**Primary**: WebSocket. From `ChatInputCM`:

```ts
wsClient.send({ type: 'session:send', processId: sessionId, payload: { text } });
```

Daemon side, in `pty/stream.ts:handleWsMessage`:

```ts
case 'session:send': {
  const text = msg.payload?.text;
  const sid = msg.processId;
  if (!sid || typeof text !== 'string') return;
  agentManager.sendTurn({ sessionId: sid, text }).catch((err) => {
    ws.send(JSON.stringify({ type: 'session:send-error', processId: sid, payload: { message: String(err) } }));
  });
  break;
}
```

**Secondary**: REST `POST /api/sessions/:id/turn` `{ text }` for tooling/testing/CLI. Returns `202 Accepted` immediately; the response stream is the WS.

**Optimistic UI**: composer pre-pushes a `Message` of kind `user` with a client-generated id into the store on send. The eventual `session:user-message` from the daemon carries a server-side id that may differ — dedupe on `id` (collision-free uuids). This is identical to the optimistic path the chat already uses for any well-built chat UI; if the current SessionChat doesn't do this, add it now (small).

**Attachments**: untouched. `uploadAttachment` still POSTs to `/api/sessions/:id/attachments`, returns a path, the composer inserts the path string into the prompt text — the SDK passes that text to Claude verbatim. Permission is granted when the SDK's `Read` tool reads that path (auto-defer + `pathInsideCwd` returns false → user approves).

---

## Permissions rewiring

The state machine in `PermissionManager` doesn't change. The only edits are:

1. Add `requestFromSdk(sessionId, claudeSessionId, toolName, toolInput, signal): Promise<PermissionResult>`. Internally identical to `handleHook('PreToolUse', ...)` except the "responder" is a `Promise.resolve` instead of `res.json(...)`.
2. `handlePreToolUse` and `handlePermissionRequest` (the HTTP entry points) are deleted in Phase 6 along with the receiver.
3. Auto-defer, dedup, allow-list, timeout-auto-allow → all unchanged.
4. The `'always-allow'` decision still mutates `sessionAllowList` and resolves as `behavior: 'allow'`.
5. `clearForSession(sessionId)` becomes the cleanup hook called by `agentManager.remove(sessionId)`.

The SDK's `canUseTool` is awaited inline by the SDK — that's exactly the semantics we need. The `signal` argument lets us cancel on turn abort: subscribe to `signal.abort` and `respond(id, 'deny')` to unblock the manager.

---

## Hook installer retirement

| Hook event | Today (HTTP receiver) | After (SDK options.hooks or other) |
|---|---|---|
| `PreToolUse` | held-open response, blocking permission gate | tracking only (`currentTool`); permissions move to `canUseTool` |
| `PermissionRequest` | held-open response, blocking permission gate | superseded by `canUseTool`; SDK handles the equivalent flow internally |
| `PostToolUse` | tool count, cost record, `currentTool=null`, broadcast | same logic, in-process |
| `Stop` | parse JSONL cost, run option-detector, run labeler | same logic, fired by SDK callback or `result` message |
| `SessionStart` | link `claudeSessionId` to session id, bind tailer | obsolete: `system` init message provides `session_id` directly; tailer is gone |
| `SessionEnd` | broadcast `session:ended`, write event | trivial in-process callback |
| `SubagentStart`/`Stop` | `activeSubagents++/--` | trivial in-process callback |
| `UserPromptSubmit` | append to `userMessages`, auto-rename on first | `agentManager.sendTurn` already records the user message; SDK callback fires too — pick one (the manager-side recording is canonical; the hook callback only triggers the rename branch) |
| `Notification` | broadcast for toast | trivial in-process callback → `session:notification` |
| `PreCompact`, `PostCompact`, `InstructionsLoaded`, `PostToolUseFailure`, `PermissionDenied`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `StopFailure`, `ConfigChange`, `CwdChanged`, `WorktreeRemove`, `Elicitation`, `ElicitationResult` | broadcast as `hook:<EventName>` for the UI | not currently consumed by the UI in any meaningful way (only `Notification` and `Stop` are wired up). Drop them. If something needs to come back, add a single SDK hook entry per event. |

The `HookManager.installForProject` call in `index.ts` and the `app.use('/api/hooks', ...)` mount in `server.ts` are deleted. Optional: keep a `HookManager.removeForProject` runtime sweep for one release to clean up old entries from `.claude/settings.json`.

---

## Cost / labeler / option-detection landing

- **Cost (live)**: `AgentSessionManager` updates `s.totalCostUsd`, token counters from each SDK `result` message and broadcasts `session:state-updated`. A `cost_records` row is inserted from the same handler.
- **Cost (REST `/api/sessions/:id/cost`)**: prefer `agentManager.get(id)` totals; fall back to `parseSessionCost(workingDir, claudeSessionId)` (the JSONL parse) when in-memory is empty (cold start). `costParser.ts` stays.
- **Labeler**: `agentManager.runStopHooks(sessionId)` calls `generateSessionLabel(s.userMessages)` from the SDK `Stop` hook callback. Triggers the same `session:label-updated` broadcast as today.
- **Option detection**: same JSONL re-parse on Stop. No structural change. Could later be refactored to operate on the last assistant `Message` we just emitted, but that's a Phase 9 polish.
- **Prompts (`/prompts` route)**: the JSONL-first lookup already there is unchanged. The third-tier fallback now reads `agentManager.get(id)?.userMessages` instead of `getClaudeState(id)?.userMessages`.

---

## Autostart changes in `index.ts`

Before:
```ts
for (const session of sessions) {
  if (session.autostart) {
    if (session.claudeSessionId) manager.register(spawnCfg);
    else manager.spawn(spawnCfg);
  }
  if (session.fileWatchPatterns.length > 0) {
    fileWatcher.watchPatterns(session.id, ..., () => manager.restart(session.id));
  }
}
```

After:
```ts
for (const session of sessions) {
  agentManager.register({
    id: session.id,
    projectId: project.id,
    name: session.name,
    workingDir: session.workingDirectory || project.path,
    claudeSessionId: session.claudeSessionId ?? null,
    label: null,
  });
  // No autostart concept for sessions — sending a turn starts the work.
  // File watch patterns are nonsensical for an agent session (we don't
  // restart conversations on file change). Drop the watch hookup for sessions
  // entirely; commands keep theirs.
}
```

---

## Error recovery

- **`query()` throws mid-turn**: `try/catch` around the `for await`. Set `state = 'errored'`, emit `session:turn-error` with the message, clear `currentTurn`. The user sees a banner ("Last turn failed: <message>. Send another to continue."). Subsequent `sendTurn` calls work — they `resume: claudeSessionId` and pick up wherever the JSONL left off (the SDK persists each tool call individually).
- **Daemon restart mid-turn**: the in-process turn is lost. On reboot, `agentManager.register()` reads the persisted `claudeSessionId`. The next `sendTurn` resumes. Whatever progress made it to the JSONL is reflected in the next `GET /api/sessions/:id/messages`.
- **JSONL corruption**: SDK owns the file; we don't write to it. Our `parseTranscript` already tolerates partial last lines. If a JSONL is truly corrupt, `query({ resume: id })` will fail; we surface the error and prompt the user to start a new session (same UX as the old `'No conversation found'` flow).
- **Abort**: `agentManager.abortTurn(id)` calls `currentTurn.abortController.abort()`. The SDK breaks the iterable; the `for await` loop exits; `finally` cleans up. If a tool was mid-execution, the SDK can't cancel it (per the spec) — the next iteration after abort returns nothing and the loop exits anyway.
- **Permission timeout**: `PermissionManager` already has a 110s timeout that auto-allows. Same behavior; the `Promise.resolve({ behavior: 'allow' })` unblocks the SDK.
- **Disconnect from API**: the SDK throws (`anthropic-ai/sdk` error types). Catch, mark errored, surface the error message. User retries.

---

## Auth

- The SDK reads `ANTHROPIC_API_KEY` env var or `~/.claude/auth.json` (same as the CLI). No code change needed in our daemon. **Note from Phase 0**: when the daemon itself runs inside a Claude Code harness (e.g., the VSCode extension), env vars like `CLAUDE_CODE_ENTRYPOINT` provide an alternate auth path that makes the SDK work even without `ANTHROPIC_API_KEY` or `~/.claude/auth.json`. A production daemon launched from a bare shell will need one of those two. The `scrubParentClaudeEnv` helper we added for the PTY path should NOT be used for the SDK spawn — the SDK needs those env vars if they're the only auth source.
- **Surfacing failures**: the first `sendTurn` after boot that hits an auth error emits `session:turn-error` with the error message. The chat shows: "Auth failed — set ANTHROPIC_API_KEY or run `claude login`." Add this hint specifically when the error string includes "401" or "auth" tokens.
- **Doc note**: add a section to `CLAUDE.md` (and the README): "MultiTable now drives Claude through the Agent SDK. Make sure either `ANTHROPIC_API_KEY` is in your shell env when launching the daemon, or you've previously run `claude login` so `~/.claude/auth.json` exists."
- **Boot-time check** (optional, low risk): on daemon start, log "Auth: API key" / "Auth: ~/.claude/auth.json (mtime <date>)" / "Auth: NONE" so misconfiguration is visible without sending a turn.

---

## Dev/test story

- **Local run**: unchanged. `npm run dev` boots daemon (`tsx watch`) + Vite. Sessions register at boot, spawn no children. Sending a message round-trips.
- **Smoke test**: a 60-second manual run-through:
  1. Boot daemon; verify no `claude` child in `ps -af`.
  2. Open the web UI, click an existing session — chat loads, no crash banner.
  3. Send "list files" — assistant streams in; permission card appears for any non-auto-defer tool; approve; tool result appears; cost ticks; turn completes.
  4. Send a follow-up — resumes correctly (look at JSONL `~/.claude/projects/<encoded-cwd>/<session>.jsonl` with `wc -l` before/after).
  5. Stop the daemon mid-turn (Ctrl-C) — restart — open the same session — `GET /api/sessions/:id/messages` returns the full conversation, including the partial last turn that made it to disk.
- **Test cruft to add** (optional but cheap):
  - `packages/daemon/src/agent/__tests__/sdkAdapter.test.ts` — pure unit tests of the SDK-message-to-`Message` mapping. No runtime test framework yet — either add `vitest` (small) or run via `tsx`-driven asserts. Skip if test framework adoption isn't on the table.
  - A scripted CLI tool in `packages/cli` to send a turn against a session id directly: `mt turn <session-id> "hello"`. Useful for debugging without the web UI. Strictly optional.
- **No regressions to gate**: lint clean (`npm run lint`), build clean (`npm run build`), `npm run format` no diff.

---

## Risks

1. **SDK version drift breaking hook signatures**. The hook input/output shape has changed between SDK minor versions in the past. **Mitigation**: pin to an exact version in `package.json` (not `^`), and add a one-time conformance test in Phase 0 that calls each hook event we register and asserts the input shape matches what we destructure. Bump deliberately, behind a separate PR.

2. **Long turns timing out**. The current 110-second permission timeout was sized for a TUI flow; an SDK turn doing several tool calls can run minutes. **Mitigation**: per-turn timeout is *separate* from per-permission timeout. Permission timeout stays 110s (one card, one decision). Turn timeout: don't enforce one — let the user abort manually. Surface elapsed time in the UI ("Working… 2:14") so they know the turn is alive.

3. **Concurrent messages from multiple tabs**. We serialize per session: `sendTurn` rejects if `currentTurn != null` with a 409. **Mitigation**: surface a "session busy" banner in the inactive tab; queue locally if user wants ("send when ready" toggle, deferred). Without this, a fast typist hitting Enter twice gets one rejected message — annoying.

4. **`canUseTool` deadlocks on dropped WebSocket**. If the only WS client subscribed to a session disconnects while a permission card is pending, no one will respond → 110s auto-allow timeout hits → turn proceeds. **Mitigation**: that's already the behavior. Watch for: a stale "always-allow" set persisting across daemon restarts (it doesn't — it's in-memory; that's fine, by design).

5. **Resume failure on stale `claudeSessionId`**. If the user moves a project's directory or deletes its `.claude/projects/<encoded-path>/<id>.jsonl`, `query({ resume: id })` fails. **Mitigation**: on the first `sendTurn` after boot, if `query()` throws an error containing "no conversation" or "session not found", fall back to a fresh `query()` (no resume), capture the new `session_id`, persist it. Surface a notice in the UI: "Previous session unavailable — started a new one."

---

## Open questions for the user

1. **Streaming partial messages?** The SDK supports `includePartialMessages: true` for token-level deltas. The chat UI doesn't render typewriter-style today (assistant messages appear whole). Skip for v1, revisit if perceived latency on long replies is a complaint?
2. **`maxTurns` / `maxBudgetUsd`?** Today there's no ceiling. Add a per-session budget (`session.maxBudgetUsd`) on the AddAgent modal? Defaults to unset (unlimited).
3. **MCP servers / `additionalDirectories`?** Out-of-scope for this migration but easy to wire later. Confirm we don't need any of these on day 1.
4. **`session:notification` rename**: confirm we can rename `hook:Notification` and `hook:Stop` rather than aliasing them — they're internal listeners, no public consumer.
5. **Slash command equivalents**: confirmed staying out, but if someone wants `/compact` or `/clear` later, those map to SDK `forkSession` and `compact` calls; flag as a separate spike.

---

### Critical Files for Implementation

- packages/daemon/src/agent/manager.ts (NEW — owns `query()`, hooks, canUseTool, all session state)
- packages/daemon/src/pty/stream.ts (route `session:send`; stop spawning sessions on subscribe; remove tailer wiring)
- packages/daemon/src/index.ts (replace session autostart spawn with `agentManager.register`; delete hook installer call)
- packages/daemon/src/hooks/permissionManager.ts (add `requestFromSdk` Promise-resolving entry point; HTTP responders go away)
- packages/web/src/components/main-pane/chat/ChatInputCM.tsx (swap `wsClient.sendInput(... + '\r')` for `wsClient.sendTurn`)
