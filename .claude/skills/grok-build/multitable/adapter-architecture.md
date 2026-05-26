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
| `userQuestion` | `'unsupported'` (VERIFY) | No confirmed free-form agent→user channel over agent-stdio. |
| `elicitation` | `false` (VERIFY) | No confirmed MCP elicitation surface over agent-stdio. |
| `subagents` | `'auto'` (VERIFY events) | Grok runs up to 8 parallel subagents; wire their notifications → `emitTaskEvent`. Confirm the `session/update` kinds. |
| `midTurnInput` | `false` (VERIFY) | No confirmed steering channel. |
| `byok` | `false` | Machine-wide `~/.grok/auth.json` or process-env API key; no per-session keys. |
| `hardSandbox` | `true` (VERIFY) | Grok runs tools under its own workspace-trust/protected-dir model; we advertise `fs:false,terminal:false`. |
| `hooks` | `'none'` | Grok's `~/.grok/hooks/*.json` run **inside Grok**, not host-brokered to us over ACP. |
| `streamingDeltaSemantics` | `'additive'` | ACP chunks are pieces — accumulate, emit total. |
| `modelSwitchScope` | `'per-session'` (VERIFY) | Model likely fixed at `session/new`. |
| `thinkingEffort` | `'unsupported'` (VERIFY) | No confirmed effort knob for grok-build-0.1 over agent-stdio. See [`../reference/models-and-effort.md`](../reference/models-and-effort.md). |
| `modes` | `code` / `plan` / `ask` | Native Grok modes, passthrough. See [`../reference/modes.md`](../reference/modes.md). |

The UI renders entirely off this struct — **never add a `provider === 'grok'` branch in React;** flip/extend a capability instead.

## The client pool — default per-cwd, VERIFY if a singleton is safe

```ts
private clients = new Map<string, GrokAcpClient>();   // key: resolved project cwd
private injectedClient: GrokAcpClient | null = null;  // test seam (used for every cwd)
```

`clientFor(cwd)` returns the injected client if present, else gets-or-creates a `GrokAcpClient` for that cwd, constructed with the resolved `cwd` and `permissionHandler: req => this.handleAcpPermission(req)`.

**Why per-cwd is the safe default:** the ACP sibling agent ignores per-session cwd and reads its own `os.getcwd()` for self-perception/context-file discovery, so a shared child loads the wrong project's `AGENTS.md`. **VERIFY** whether Grok has the same flaw. Grok takes `cwd` on `session/new` and *may* honor it correctly — in which case a single daemon-wide child (the Codex app-server model) is cheaper and fine. Don't collapse to a singleton until you've confirmed Grok's self-perception follows the session cwd, not the process cwd. Note: Grok's **workspace-trust** is per-directory regardless ([`../pitfalls.md`](../pitfalls.md) §9), so even a singleton must establish trust per project.

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
