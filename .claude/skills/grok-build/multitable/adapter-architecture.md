# How the Grok Build adapter fits into MultiTable

> The adapter is **planned, not yet shipped.** This documents the intended shape, modeled on the ACP sibling adapter but written for Grok. When `grok.ts` lands, its top-of-file comment becomes authoritative; update this doc to quote it.

The Grok provider is three files: `agent/providers/grok.ts` (the adapter), `agent/providers/grok-acp/*` (transport + client + index), and `transcripts/grokParser.ts` (disk hydration). Only these three should grow with Grok-specific changes — the manager stays provider-agnostic.

## Registration

In [`agent/manager.ts`](../../../../packages/daemon/src/agent/manager.ts) the adapter map (~L111) will include:

```ts
grok: new GrokAdapter(permManager),
```

The constructor takes the `PermissionManager` (Grok routes `session/request_permission` through it — see [`permission-wiring.md`](permission-wiring.md)) and an optional injected `GrokAcpClient` (test seam; when set, used for every cwd, no children spawned).

## The `ProviderAdapter` contract Grok implements

From [`agent/providers/types.ts`](../../../../packages/daemon/src/agent/providers/types.ts) — first add `'grok'` to the `ProviderAdapter.name` union and `AgentProvider`:

| Member | Grok implementation |
|---|---|
| `name` | `'grok'` |
| `capabilities` | see table below |
| `runTurn(s, text, ctrl, cb)` | the turn loop (handshake → session → subscribe → prompt → drain → finalize) |
| `reset(s)` | drops `sessions` + `acpToMt` (+ `lastSentEffort` if effort is wired) for the session |
| `shutdown()` | closes the injected client and **every** pooled per-cwd client |
| `provisionSession?` | likely **not implemented** for v1 — mint the session id lazily on first turn (the ACP pattern) |
| `warmup?` | optional — pre-spawn one child to pay cold-start once; safe to skip in v1 |
| `destroy?` | optional — per-session teardown is `reset` |

`AdapterCallbacks` is the manager-owned bag the adapter calls into. The adapter must **never** touch `s.state`, `currentTurn`, the abort controller, or the DB directly. Grok will use: `pushMessages`, `emitAssistantMessage`, `emitToolEvent`, `emitAssistantDelta`, `emitReasoningDelta`, `emitToolDelta`, `setCurrentTool`, `bumpActivity`, `applyUsage`, `emitTurnResult`, `emitStateSnapshot`, `onSessionIdAssigned`, `maybeRenameFromFirstPrompt`, `incrementToolCount`, `emitAlert`, and — because Grok has subagents — likely `emitTaskEvent` + `incrementSubagents`.

## `ProviderCapabilities` for Grok (proposed; `VERIFY` the flagged ones)

| Field | Proposed value | Rationale / status |
|---|---|---|
| `costUsd` | `false` | `x.ai/billing` is TUI-only over agent-stdio (`-32601`); no per-turn USD. Revisit if billing reaches stdio. |
| `planMode` | `'simulated'` → flip to `'native'` if VERIFY passes | Grok *has* a real plan mode; unknown if reachable over ACP set-mode. Default safe. See [`../reference/modes.md`](../reference/modes.md). |
| `perCallApproval` | `'callback'` | `session/request_permission` → `PermissionManager`. |
| `userQuestion` | `'tool'` | `_x.ai/ask_user_question` server-request → PermissionManager (same picker as Claude's AskUserQuestion). |
| `elicitation` | `false` | No MCP elicitation surface over agent-stdio. |
| `subagents` | `'none'` | Grok runs parallel subagents internally, but we don't surface their lifecycle yet. |
| `midTurnInput` | `false` | No steering channel. |
| `byok` | `false` | Machine-wide `~/.grok/auth.json` or process-env API key; no per-session keys. |
| `hardSandbox` | `false` | We leave `--sandbox` at Grok's default and gate via the mode flags; no OS sandbox we enforce. |
| `hooks` | `'none'` | Grok's `~/.grok/hooks/*.json` run **inside Grok**, not host-brokered to us over ACP. |
| `streamingDeltaSemantics` | `'additive'` | ACP chunks are pieces — accumulate, emit total. |
| `modelSwitchScope` | `'per-session'` | Model is a spawn-time `-m` flag (pool key); switching re-spawns the child. |
| `thinkingEffort` | `'native'` | Spawn-time `--reasoning-effort` (no `max` → `xhigh`). See [`../reference/models-and-effort.md`](../reference/models-and-effort.md). |
| `modes` | `default` / `auto` / `plan` | Spawn-time flags only (no per-session set-mode). See [`../reference/modes.md`](../reference/modes.md). |

The UI renders entirely off this struct — **never add a `provider === 'grok'` branch in React;** flip/extend a capability instead.

## The client pool — keyed by FULL spawn config (cwd + mode + effort + model)

```ts
private clients = new Map<string, GrokAcpClient>();   // key: JSON.stringify([cwd, agentArgs])
private injectedClient: GrokAcpClient | null = null;  // test seam (used for every config)
```

`clientFor(cwd, mode, effort, model)` returns the injected client if present, else builds the spawn `agentArgs` via `buildAgentArgs(mode, effort, model)` and gets-or-creates a `GrokAcpClient` for that `[cwd, agentArgs]` key, constructed with `cwd`, `agentArgs`, and `permissionHandler: req => this.handleAcpPermission(req)`.

**Why keyed by the full config (not just cwd):** Grok's mode/effort/model are **spawn-time flags** on the `grok agent` child (verified 0.2.2 — `session/new` ignores them), so a child is bound to one config for life. A singleton is therefore impossible; we spawn one child per distinct config and re-key on a mode/effort flip (the same immutable-options pattern Codex uses — `manager.setMode` → `adapter.reset` clears the session cache, the next turn resolves the child for the new config and `session/load`s the persisted `agentSessionId` under it). cwd is still part of the key, so each child also has a correct process cwd for `AGENTS.md`/workspace-trust ([`../pitfalls.md`](../pitfalls.md) §9).

`resolveCwd(s)` must never return empty — fall back to `homedir()` with a loud log if `s.workingDir` is empty.

## The session cache

```ts
private sessions = new Map<string, SessionCacheEntry>();   // s.id → { grokSessionId, mode }
private acpToMt  = new Map<string, string>();              // grokSessionId → s.id  (reverse)
```

`ensureSessionId` returns the cached `grokSessionId` iff the entry exists **and `entry.mode === s.mode`** — so a mode flip can bust the cache and recreate the session in the new mode (needed if `planMode: 'native'` and Grok options are immutable post-session-start). `acpToMt` is the reverse map the permission handler needs (`session/request_permission` carries only the Grok session id). Poison the cache (delete the entry) when `runTurn` throws; `reset(s)` clears both maps.

## The `runTurn` shape (mirrors the ACP lifecycle)

```ts
async runTurn(s, text, ctrl, cb) {
  if (s.userMessages.length === 1) cb.maybeRenameFromFirstPrompt(text);
  const cwd = this.resolveCwd(s);
  const client = this.clientFor(cwd);

  await client.ensureReady();                            // typed auth alert + throw on failure
  const grokSessionId = await this.ensureSessionId(s, cb, client, cwd);

  const buffers = makeBuffers();
  const off = client.subscribe(grokSessionId, n => this.handleNotification(s, n, cb, buffers));
  const onAbort = () => client.cancel(grokSessionId);    // session/cancel notification
  ctrl.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const result = await client.prompt({ sessionId: grokSessionId, text });
    if (buffers.assistantText.trim()) { /* push + emit canonical assistant Message */ }
    if (buffers.reasoningText.trim()) cb.emitReasoningDelta('');
    cb.applyUsage({ …, costUsd: 0 });
    cb.emitTurnResult({ subtype: result.stopReason ?? 'end_turn', totalCostUsd: 0, … });
    cb.emitStateSnapshot();
  } catch (err) {
    this.sessions.delete(s.id);                          // poison cache
    throw err;
  } finally {
    ctrl.signal.removeEventListener('abort', onAbort);
    off();                                               // unsubscribe
  }
}
```

The manager wraps this in the no-progress watchdog (re-arms on every callback + while a tool is in flight, bounded by `TOOL_GRACE_MS`) and a try/catch/finally that turns a throw into `session:turn-error` and always emits `turn-complete`. The canonical assistant `Message` comes from the **buffer**, not the prompt response. Pure-tool turns emit no assistant Message — intentional.

## Adding a feature — where it goes

| Feature | Where |
|---|---|
| Handle a new `session/update` kind | `handleNotification` switch in `grok.ts`. If it persists a `Message`, mirror it in `grokParser.ts`. |
| Forward a new live preview kind | `cb.emitToolDelta` / `emitReasoningDelta` / `emitAssistantDelta`. |
| New ACP request/notification primitive | `transport.ts` for a new wire primitive; otherwise a method call in `client.ts`. |
| New WS event | add a callback to `AdapterCallbacks` (types.ts), implement in the manager's `makeAdapterCallbacks`, forward in `server.ts`. **Not** Grok-specific. |
| New capability-driven UI behavior | flip/extend a `ProviderCapabilities` field; never branch on provider in React. |

Rule of thumb: only `grok.ts`, `grok-acp/*`, and `grokParser.ts` should grow with Grok-specific changes.
