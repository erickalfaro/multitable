# Codex `app-server` Migration Plan

> **Status:** proposed, not started.
> **Goal:** restore real text streaming for Codex sessions by switching from `codex exec --experimental-json` (used by `@openai/codex-sdk`) to `codex app-server` (JSON-RPC over stdio, exposes `AgentMessageContentDelta`).
> **Owner:** TBD.
> **Estimated effort:** 1.5–3 dev days.

---

## 1. Why this exists

Codex sessions in MultiTable do not stream assistant text. Send a prompt, see a spinner, then the entire response lands at once — even on 70-second / 3000-token replies. Tool output and reasoning DO stream; assistant text does not.

The cause is upstream and confirmed from the Codex source code:

- **The internal Codex protocol HAS streaming events.** [`codex-rs/protocol/src/protocol.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs) defines `EventMsg::AgentMessageContentDelta { delta: String, ... }`, `ReasoningContentDelta`, `PlanDelta`, etc.
- **`codex exec --json` silently drops them.** [`event_processor_with_jsonl_output.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs) only handles `ItemStarted`/`ItemUpdated`/`ItemCompleted`; delta variants fall through to `_ => CodexStatus::Running` and are never serialized.
- **`codex app-server` DOES forward them.** [`bespoke_event_handling.rs`](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/bespoke_event_handling.rs) explicitly converts `AgentMessageContentDelta` (and friends) into outbound server notifications.

The `@openai/codex-sdk` we depend on is a thin wrapper around `codex exec --experimental-json` (the batched mode). To get streaming today we must bypass the SDK and speak `app-server`'s JSON-RPC protocol directly.

**Verified directly** by running:
```bash
echo "say hi" | codex exec --experimental-json --skip-git-repo-check -s read-only
# emits: thread.started → turn.started → item.completed → turn.completed
# zero item.updated events for the agent_message
```

---

## 2. Decision

**Switch the Codex adapter to `codex app-server` mode.** Bypass `@openai/codex-sdk` entirely. Keep the JSONL transcript parser (`packages/daemon/src/transcripts/codexParser.ts`) — the rollout file format on disk doesn't change.

Two alternatives considered and rejected:

- **File an upstream bug and wait.** Should be done in parallel (zero cost, may save us this work in 3-6 months). But we can't ship streaming today on this path.
- **Use `codex mcp-server` instead.** Wrong protocol fit — MCP is request/response and exposes Codex as a tool to other clients, not a streaming chat agent.

---

## 3. Architecture

This is the same pattern the Copilot integration plan ([docs/THREE_PROVIDER_INTEGRATION_PLAN.md §2.1](THREE_PROVIDER_INTEGRATION_PLAN.md)) calls for. Codex moves from "per-turn subprocess" to "one long-lived child + multiplexed sessions."

```
┌─ AgentSessionManager (middle layer, unchanged) ──────────────┐
│  Calls adapter.runTurn(s, text, ctrl, cb)                    │
└────────────────────┬─────────────────────────────────────────┘
                     │ ProviderAdapter contract
┌────────────────────┴─────────────────────────────────────────┐
│  CodexAdapter (rewritten internals)                          │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  CodexAppServerClient (NEW — singleton per daemon)     │  │
│  │   • Spawns `codex app-server --listen stdio://` once   │  │
│  │   • Owns the stdin/stdout pipe                         │  │
│  │   • JSON-RPC request/response correlation by id        │  │
│  │   • Notification dispatcher (event_id → handler)       │  │
│  │   • Restart on crash; reconnect threads                │  │
│  └────────────────────────────────────────────────────────┘  │
│  Per-session:                                                │
│   • thread_id ↔ MultiTable session id mapping                │
│   • Subscription: which deltas route to which session's cb   │
│   • Cached SessionMode (still rebuild thread on mode flip)   │
└──────────────────────────────────────────────────────────────┘
                     │
                     ▼
              codex app-server (one process)
```

**Key invariants preserved:**

- The `ProviderAdapter` contract doesn't change. Manager dispatches identically. WS events identical.
- `capabilities.streamingDeltaSemantics` flips from `'cumulative'` → `'additive'` (`AgentMessageContentDelta` carries deltas, not cumulative text).
- Session mode → sandbox translation stays in `modeToCodexSandbox` (just passed via different RPC param).
- JSONL on disk is still written by `codex app-server` — `parseCodexThread` and `codexCanonicalId` unchanged.
- Reconcile pass becomes belt-and-braces (live stream is now reliable), but stays for safety.

---

## 4. Implementation phases

### Phase 0 — Upstream bug report (do this first)

File an issue against `openai/codex`:
> Title: `codex exec --json` should forward `AgentMessageContentDelta` events
>
> Body: The internal `EventMsg::AgentMessageContentDelta` is silently dropped by `event_processor_with_jsonl_output.rs`. Other consumers (TUI, app-server) forward it. Please emit it as `item.updated` (or a new event type) so SDK clients can stream agent text.

10 minutes. Zero risk. May make Phase 1+ unnecessary in 3-6 months.

### Phase 1 — Generate TypeScript bindings (½ hour)

Codex ships a generator:
```bash
codex app-server generate-ts --out packages/daemon/src/agent/providers/codex-protocol/
```

Commit the generated files. They define the JSON-RPC method shapes and `ServerNotification` variants.

**Critical:** record the `codex-cli` version that generated them in a comment at the top of the directory's `index.ts`. Regenerating after a Codex CLI bump is part of the upgrade ritual.

### Phase 2 — Build the JSON-RPC transport (½ day)

New file: `packages/daemon/src/agent/providers/codex-app-server/transport.ts`.

Responsibilities:
- Spawn `codex app-server --listen stdio://` as a child process (no automatic restart yet)
- Line-delimited JSON parser on stdout (one JSON object per line)
- `request<TReq, TRes>(method, params): Promise<TRes>` — assigns id, sends, awaits matching response
- `on(method, handler)` — registers a notification handler by method name
- `close()` — graceful shutdown for daemon SIGTERM
- Correlation map for in-flight requests; reject all on close
- Error handling: stderr → log; non-JSON stdout → log; unhandled notifications → log + drop

**Reference patterns to copy:**
- Process spawn / stdio handling from existing [`packages/daemon/src/pty/manager.ts`](../packages/daemon/src/pty/manager.ts) (uses `node-pty`; for app-server, use plain `child_process.spawn` since we want stdio not a PTY)
- Reconnect/lifecycle pattern from the planned Copilot integration in [THREE_PROVIDER_INTEGRATION_PLAN.md §2.1](THREE_PROVIDER_INTEGRATION_PLAN.md)

### Phase 3 — Build the CodexAppServerClient singleton (½ day)

New file: `packages/daemon/src/agent/providers/codex-app-server/client.ts`.

Responsibilities:
- One `CodexAppServerTransport` instance, lazy-spawned on first use
- High-level methods that wrap JSON-RPC calls:
  - `createThread({ workingDirectory, sandboxMode, model, ... }) → Promise<{ threadId }>`
  - `resumeThread({ threadId, ... }) → Promise<void>`
  - `sendTurn({ threadId, prompt, ...turnOptions }) → Promise<{ turnId }>`
  - `cancelTurn({ threadId, turnId }) → Promise<void>`
  - `dispose({ threadId }) → Promise<void>`
- Notification routing: each notification carries `thread_id` and `turn_id` — route to the registered per-thread listener
- Per-thread subscriber registration: `subscribe(threadId, listener)` / `unsubscribe(threadId)`
- Crash recovery (Phase 6) hooks here

**Lifecycle wiring:**
- Construct lazily inside `CodexAdapter` (don't slow daemon startup if no Codex sessions)
- Daemon SIGTERM handler (in `packages/daemon/src/index.ts`) calls `codexAppServerClient.close()` if instantiated

### Phase 4 — Rewrite CodexAdapter against the new client (½ day)

Modify: [`packages/daemon/src/agent/providers/codex.ts`](../packages/daemon/src/agent/providers/codex.ts).

Replace the `@openai/codex-sdk` `Thread` usage with the new client.

`runTurn` becomes:
```ts
async runTurn(s, text, ctrl, cb) {
  const threadId = await this.ensureThread(s);  // create or resume
  const turnId = await client.sendTurn({ threadId, prompt: text, ... });

  // Subscribe for notifications scoped to this thread+turn
  const off = client.subscribe(threadId, (notification) => {
    this.handleNotification(s, notification, cb);
  });

  // Wait for turn.completed or turn.failed for THIS turnId
  await this.awaitTurnEnd(threadId, turnId, ctrl.signal);

  off();
  this.scheduleReconcile(s, cb);  // belt-and-braces, optional
}
```

`handleNotification` switches on the notification method:
- `agent_message_content_delta` → buffer the delta, call `cb.emitAssistantDelta(buffer)` (StreamBuffer with `additive`)
- `reasoning_content_delta` → similar buffering, `cb.emitReasoningDelta(buffer)`
- `exec_command_output_delta` → cumulative, `cb.emitToolDelta(payload)`
- `item.completed` (when emitted) → push canonical message, clear buffers
- `turn.completed` → `cb.applyUsage`, `cb.emitTurnResult`, `cb.emitStateSnapshot`
- `turn.failed` → throw (manager catch handles)
- `error` → throw

The `modeToCodexSandbox` translation stays — pass `sandboxMode` to `createThread`/`resumeThread`.

The Thread cache becomes `Map<sessionId, { threadId, mode }>`. On mode flip, dispose old thread (`client.dispose`), create new one (resume by previous thread id IF the rollout still exists; otherwise fresh).

### Phase 5 — Capability flag + delta semantics fix (½ hour)

In [`providers/types.ts`](../packages/daemon/src/agent/providers/types.ts), update CodexAdapter's capabilities:
```diff
- streamingDeltaSemantics: 'cumulative',
+ streamingDeltaSemantics: 'additive',
```

`AgentMessageContentDelta` carries chunks (additive), not cumulative text-so-far. Use `StreamBuffer('additive')` per stream.

### Phase 6 — Crash recovery (½ day)

Once basic streaming works, add:
- Detect app-server child crash (`exit` event with non-zero code)
- Mark all active threads as "needs reconnect"
- On next `runTurn`, transport auto-respawns the child, re-creates the thread via `resumeThread(previousThreadId)` (the on-disk rollout file is the source of truth — no state lost)
- Surface a single user-facing alert per crash event ("Codex restarted; resuming") — not one per thread
- Watchdog: if app-server dies > 3 times in 60s, give up and mark all Codex sessions as errored (avoid restart loops)

### Phase 7 — Remove `@openai/codex-sdk` dependency (½ hour)

Once everything works:
- Drop the dependency from `packages/daemon/package.json`
- Remove the dynamic-import workaround in the old codex adapter (no longer ESM-from-CJS)
- Update `docs/CLAUDE.md` and `docs/THREE_PROVIDER_INTEGRATION_PLAN.md` to reflect the new transport

---

## 5. Files to modify / add

### Add

- `packages/daemon/src/agent/providers/codex-protocol/` — generated TS bindings (committed; regenerate on Codex CLI bump)
- `packages/daemon/src/agent/providers/codex-app-server/transport.ts` — JSON-RPC transport
- `packages/daemon/src/agent/providers/codex-app-server/client.ts` — high-level client
- `packages/daemon/src/agent/providers/codex-app-server/notifications.ts` — typed notification dispatch helpers (optional, for clarity)

### Modify

- `packages/daemon/src/agent/providers/codex.ts` — rewrite internals against new client; keep `ProviderAdapter` shape unchanged
- `packages/daemon/src/agent/providers/types.ts` — flip `streamingDeltaSemantics: 'cumulative' → 'additive'` for Codex
- `packages/daemon/src/index.ts` — wire `codexAppServerClient.close()` into SIGTERM cleanup
- `packages/daemon/package.json` — remove `@openai/codex-sdk` (Phase 7)
- `docs/CLAUDE.md` — update the "Codex specifics" section: per-thread Thread cache → per-thread notification subscription
- `docs/THREE_PROVIDER_INTEGRATION_PLAN.md` — flip Codex's `streamingDeltaSemantics` row in the matrix; note the migration in §6

### Delete

- Nothing during the migration. Phase 7 removes the SDK dependency, but no source files get deleted (the Codex adapter is rewritten, not replaced).

---

## 6. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| `codex app-server` is marked `[experimental]` in `--help` | High | Pin a tested codex-cli version. Document the tested version. Watch the Codex changelog for protocol changes |
| Single shared process — one crash takes down all Codex sessions | High | Phase 6 crash recovery: auto-respawn + re-resume threads from on-disk rollout. Hard kill-switch after 3 crashes/60s |
| Generated TS bindings drift from runtime protocol | Medium | Re-run `codex app-server generate-ts` on every Codex CLI bump. Add a version-check assertion at startup |
| We become responsible for protocol semantics the SDK previously hid | Medium | Keep all Codex-specific quirks in `codex-app-server/` — don't leak them into the manager |
| Upstream might fix `--json` and make this whole migration redundant | Low | The work isn't wasted — Copilot needs the same long-lived-CLI-child pattern. Worth doing for that alone |
| Process startup latency | Low | App-server starts once at first Codex use. Subsequent turns are faster than today (no per-turn spawn) |
| Multiple sessions interleave their notifications through one channel | Medium | Notifications carry `thread_id`. Route via per-thread subscriber map (Phase 3). Test with 3+ concurrent Codex sessions before shipping |
| Generated TS bindings produce 100s of types we don't need | Low | Tree-shake at build. Or hand-curate a subset and skip generation. Either is fine |

---

## 7. Verification plan

### Unit-level

- Transport: send a request, assert response correlation works; concurrent requests don't cross wires
- Notification dispatch: emit a fake notification, assert the right handler fires for the right thread
- Crash recovery: kill the app-server child mid-turn; assert next turn re-establishes the thread

### Integration smoke (manual)

1. **Single short turn:** Send "hey" — assert `agent_message_content_delta` events arrive and the chat shows text appearing word-by-word.
2. **Long turn:** Send "tell me a story (3000 words)" — assert text streams continuously over the full duration, not in one batch at the end.
3. **Tool turn:** Send "list the files in /tmp and tell me about them" — assert command output streams (already worked) AND assistant text streams (new).
4. **Mode flip:** Toggle session from default → plan → default. Assert sandbox actually changes (try editing a file in plan mode; should fail).
5. **Abort mid-stream:** Click Stop while text is streaming. Assert the stream halts within 500ms, no leftover preview, "Turn cancelled." system message.
6. **Concurrent sessions:** Open 3 Codex sessions in different projects, send turns simultaneously. Assert each sees its own deltas, no cross-talk.
7. **Daemon restart mid-conversation:** Send a turn, kill daemon during it, restart. Assert the app-server restarts, the thread resumes, the conversation continues.
8. **Codex CLI not installed:** Rename the codex binary temporarily. Assert clear error message ("Codex CLI not found"), no daemon crash.

### Cross-provider parity

- Same prompt sent to Claude and Codex sessions. Both should now stream visibly. Compare timing.
- The `Message[]` shape received over WS should be identical between providers (no Codex-specific fields leaking).

### No-test framework

The repo has no automated test setup. Verification is manual + `npm run lint` + `npm run build`. Per `docs/CLAUDE.md`, do not invent `npm test`.

---

## 8. Open questions

- **Does `codex app-server` work with auth from `~/.codex/auth.json` the same way as `codex exec`?** Almost certainly yes (both spawn the same Codex core), but verify.
- **Does the app-server protocol expose a model-list endpoint?** If so, replace the current `GET /api/providers/codex/models` codex-CLI-flag-parsing with an RPC call.
- **Are MCP servers configured per-thread or per-app-server?** Affects how `--config mcp_servers.*` flags translate. Check the `createThread` request schema after generating bindings.
- **What's the right cleanup ordering on daemon SIGTERM?** Probably: (1) abort all in-flight turns, (2) `dispose` all threads, (3) `close` the transport, (4) wait for child exit. Confirm against the protocol.
- **Should we surface "Codex CLI version" in the UI somewhere?** Useful for debugging once we own protocol compat.

---

## 9. Decision deadline / triggers

- **Trigger to start:** Streaming UX becomes a user-perceived quality issue (e.g. early users complain).
- **Trigger to abandon:** Upstream fixes `codex exec --json` to forward `AgentMessageContentDelta` (file the bug now to make this possible).
- **Trigger to revisit:** `@openai/codex-sdk` switches to app-server internally — at that point we may want to switch BACK to the SDK and delete our custom client.

---

## 10. Related docs

- [docs/THREE_PROVIDER_INTEGRATION_PLAN.md](THREE_PROVIDER_INTEGRATION_PLAN.md) — middle layer architecture; this migration is one instance of the long-lived-CLI-client pattern
- [docs/THREE_PROVIDER_INTEGRATION_VALIDATION.md](THREE_PROVIDER_INTEGRATION_VALIDATION.md) — *(may not exist yet — was folded into the integration plan)*
- [docs/CLAUDE.md](../CLAUDE.md) — project overview; "Codex specifics" section needs updating after Phase 7
- Upstream Codex source files referenced:
  - [codex-rs/protocol/src/protocol.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs) — internal event types
  - [codex-rs/exec/src/event_processor_with_jsonl_output.rs](https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs) — what `--json` filters out
  - [codex-rs/app-server/src/bespoke_event_handling.rs](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/bespoke_event_handling.rs) — what app-server forwards
