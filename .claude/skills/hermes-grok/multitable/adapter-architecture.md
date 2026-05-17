# How the Hermes adapter fits into MultiTable

The Hermes provider is three files: [`agent/providers/hermes.ts`](../../../../packages/daemon/src/agent/providers/hermes.ts) (the adapter), [`agent/providers/hermes-acp/*`](../../../../packages/daemon/src/agent/providers/hermes-acp/) (transport + client + index), and [`transcripts/hermesParser.ts`](../../../../packages/daemon/src/transcripts/hermesParser.ts) (disk hydration). Read the top-of-file comment in `hermes.ts` before any change — it encodes every constraint that's bitten us.

## Registration

In [`agent/manager.ts`](../../../../packages/daemon/src/agent/manager.ts) the adapter map includes (~L111):

```ts
hermes: new HermesAdapter(permManager),
```

The constructor takes the `PermissionManager` (Hermes routes `session/request_permission` through it — see [`permission-wiring.md`](permission-wiring.md)) and an optional injected `HermesAcpClient` (test seam; when set, it's used for *every* cwd and no children are spawned).

## The `ProviderAdapter` contract Hermes implements

From [`agent/providers/types.ts`](../../../../packages/daemon/src/agent/providers/types.ts):

| Member | Hermes implementation |
|---|---|
| `name` | `'hermes'` |
| `capabilities` | see table below |
| `runTurn(s, text, ctrl, cb)` | the turn loop (handshake → session → subscribe → prompt → drain → finalize) |
| `reset(s)` | drops `sessions` + `acpToMt` + `lastSentEffort` entries for the session |
| `shutdown()` | closes the injected client and **every** pooled per-cwd client |
| `provisionSession?` | **not implemented** — Hermes mints the session id lazily on first turn |
| `warmup?` | **not implemented** |
| `destroy?` | **not implemented** (per-session teardown is `reset`) |

`AdapterCallbacks` (the manager-owned bag the adapter calls into) is the same contract documented in the Codex skill's [`codex-adapter-architecture.md`](../../openai-codex-sdk/multitable/codex-adapter-architecture.md). The adapter must **never** touch `s.state`, `currentTurn`, the abort controller, or the DB directly — the manager owns those. Hermes uses: `pushMessages`, `emitAssistantMessage`, `emitToolEvent`, `emitAssistantDelta`, `emitReasoningDelta`, `emitToolDelta`, `setCurrentTool`, `bumpActivity`, `applyUsage`, `emitTurnResult`, `emitStateSnapshot`, `onSessionIdAssigned`, `maybeRenameFromFirstPrompt`, `incrementToolCount`, `emitAlert`. It does **not** use `emitReconciled`, `emitMessageRekey`, `emitUserMessage`, `incrementSubagents`, `emitNotification`, `emitSessionEnded`.

## `ProviderCapabilities` for Hermes (and why each value)

| Field | Value | Rationale |
|---|---|---|
| `costUsd` | `false` | Hermes/Grok-OAuth surfaces no per-turn dollar figure; dollar row hidden. |
| `planMode` | `'simulated'` | ACP has no native plan-mode RPC; the UI plan toggle is stubbed/hidden. |
| `perCallApproval` | `'callback'` | `session/request_permission` → `PermissionManager` (host prompt, like Claude's `canUseTool`). |
| `userQuestion` | `'unsupported'` | No ACP channel for free-form agent→user questions. |
| `elicitation` | `false` | No MCP elicitation surface. |
| `subagents` | `'none'` | No subagent lifecycle exposed. |
| `midTurnInput` | `false` | `/steer`/`/queue` out of scope for v1. |
| `byok` | `false` | One machine-wide `~/.hermes/auth.json`; no per-session keys. |
| `hardSandbox` | `true` | Hermes enforces its own OS-level sandbox; we don't soft-gate. |
| `hooks` | `'none'` | No SDK-style lifecycle hooks; only the `session/update` stream. |
| `streamingDeltaSemantics` | `'additive'` | ACP `agent_message_chunk` is a piece-per-chunk (documents the *wire* shape). |
| `modelSwitchScope` | `'per-session'` | Model fixed for the session's lifetime in our wiring. |
| `modes` | `default` / `plan` / `read-only` | **Advisory only** — passed through verbatim, the adapter does not translate them and keeps the same session id across flips. |
| `thinkingEffort` | `'native'` | Plumbed via the `/reasoning` prefix — see [`../reference/reasoning-effort.md`](../reference/reasoning-effort.md). |

The UI renders entirely off this struct — never add a `provider === 'hermes'` branch in React; add/adjust a capability instead.

## The per-cwd client pool — the defining design choice

```ts
private clients = new Map<string, HermesAcpClient>();   // key: resolved project cwd
private injectedClient: HermesAcpClient | null = null;   // test seam (used for every cwd)
```

`clientFor(cwd)` returns the injected client if present, else gets-or-creates a `HermesAcpClient` for that cwd, constructed with `envOverlay: { HERMES_INFERENCE_PROVIDER: 'xai-oauth', TERMINAL_CWD: cwd }`, `cwd`, and `permissionHandler: req => this.handleAcpPermission(req)`.

**Why per-cwd, not a daemon singleton (the way Codex's app-server is):** Hermes' ACP adapter does not propagate the per-session `cwd` into the agent's *self-perception* or *context-file discovery*. Both read the child's own `os.getcwd()` (`run_agent.py:build_context_files_prompt`) and the terminal tool reads `os.getenv("TERMINAL_CWD", os.getcwd())`. A shared child would load the wrong project's `AGENTS.md`/`CLAUDE.md`/`.cursorrules` and misreport its location. Spawning a child *whose cwd is the project root* makes the agent correct without relying on the per-session task override that ACP doesn't honor.

Corollaries: `shutdown()` must loop the whole map; a daemon driving N projects with Hermes runs N `hermes acp` Python children (cost is amortized — children are lazy and long-lived); never collapse this back to a singleton.

`resolveCwd(s)` never returns empty — an empty `workingDir` would make Hermes fall back to the child's own process cwd for *both* self-perception and terminal execution, so we log loudly and fall back to `homedir()`.

## The session cache

```ts
private sessions = new Map<string, SessionCacheEntry>();   // s.id → { hermesSessionId, mode }
private acpToMt  = new Map<string, string>();              // hermesSessionId → s.id  (reverse)
private lastSentEffort = new Map<string, string | null>(); // s.id → last /reasoning level
```

`ensureSessionId` returns the cached `hermesSessionId` iff the entry exists **and `entry.mode === s.mode`**. The cache is keyed by `{sessionId, mode}` precisely so a future per-session-mode ACP feature can flip-recreate the session by busting the cache on mode change — today modes are advisory so the same id survives flips, but the structure is ready.

`acpToMt` is the reverse map the permission handler needs: `session/request_permission` only carries the *Hermes* session id, and `handleAcpPermission` must resolve back to the MultiTable session id to route the prompt.

The cache is **poisoned** (entry + `lastSentEffort` deleted) when `runTurn` throws — the next turn re-runs `ensureSessionId`, which `session/load`s from Hermes' `state.db` (the ACP session persists regardless of our cache). `reset(s)` clears all three maps for the session.

## The `runTurn` shape

```ts
async runTurn(s, text, ctrl, cb) {
  if (s.userMessages.length === 1) cb.maybeRenameFromFirstPrompt(text);
  const cwd = this.resolveCwd(s);
  const client = this.clientFor(cwd);

  const authState = await client.ensureReady();        // typed alert + throw on failure
  if (authState.kind === 'needsSetup') { /* auth alert */ throw … }

  const hermesSessionId = await this.ensureSessionId(s, cb, client, cwd);

  const buffers = makeBuffers();
  const off = client.subscribe(hermesSessionId, n => this.handleNotification(s, n, cb, buffers));
  const onAbort = () => client.cancel(hermesSessionId);
  ctrl.signal.addEventListener('abort', onAbort, { once: true });

  let body = maybeReasoningPrefix(text);               // only if effort changed
  try {
    const result = await client.prompt({ sessionId: hermesSessionId, text: body });
    if (buffers.assistantText.trim()) { push+emit canonical assistant Message; emitAssistantDelta('') }
    if (buffers.reasoningText.trim()) cb.emitReasoningDelta('');
    cb.applyUsage({ …, costUsd: 0 });
    cb.emitTurnResult({ subtype: result.stopReason ?? 'end_turn', totalCostUsd: 0, … });
    cb.emitStateSnapshot();
  } catch (err) {
    this.sessions.delete(s.id); this.lastSentEffort.delete(s.id);   // poison
    throw err;
  } finally {
    ctrl.signal.removeEventListener('abort', onAbort);
    off();                                              // unsubscribe
  }
}
```

The manager wraps this in: a 5-minute no-progress watchdog (`bumpActivity()` re-arms it on every chunk/tool event), and a `try/catch/finally` that turns a throw into `session:turn-error`, sets `s.state = 'errored'`, and always emits `turn-complete`.

The canonical assistant `Message` is emitted **from the accumulated buffer**, not from the prompt response (the response only carries `stopReason` + `usage`). If the turn produced no assistant text (pure-tool turn, or cancelled before any chunk), it's skipped — the user already saw the streamed tool_result messages.

## Adding a feature — where it goes

| Feature | Where |
|---|---|
| Handle a new `session/update` kind | `handleNotification` switch in `hermes.ts`. If it produces a persisted `Message`, mirror it in `hermesParser.ts`. |
| Forward a new live preview kind | `cb.emitToolDelta` / `emitReasoningDelta` / `emitAssistantDelta`. |
| New ACP request/notification | add to `transport.ts` only if it's a new wire primitive; otherwise a method call in `client.ts`. |
| New WS event | add a callback to `AdapterCallbacks` (types.ts), implement in the manager's `makeAdapterCallbacks`, forward in `server.ts`. Not Hermes-specific. |
| New capability-driven UI behavior | flip/extend a `ProviderCapabilities` field; never branch on provider in React. |

Rule of thumb: only `hermes.ts`, `hermes-acp/*`, and `hermesParser.ts` should grow with Hermes-specific changes. Editing the manager for Hermes behavior almost always means the change belongs in `AdapterCallbacks`.
