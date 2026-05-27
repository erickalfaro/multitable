# Modes: SPAWN-TIME only (no per-session mode RPC)

> **RE-VERIFIED on grok v0.2.2 (handshake + behavior probe).** Earlier drafts of this doc were **wrong twice**: first they guessed `code`/`plan`/`ask`; then they claimed Grok's `--permission-mode` enum is reachable and that `session/new` accepts a `permissionMode` param. **Both are false over `grok agent stdio`.** Ground truth below.

## The one fact

**There is no per-session mode mechanism over `grok agent stdio`.** Mode is a **spawn-time** property of the `grok agent` child. Specifically, on grok 0.2.2:

- `session/new` returns a `models` object but **NO `modes` / `availableModes` / `currentModeId`** → ACP `session/set_mode` is **not** available (the spec mechanism doesn't apply).
- `permissionMode` (and `effort`, `model`) on `session/new` are **silently ignored**. Probe: sending `permissionMode:'plan'` still made Grok run `echo "hi" > hello.txt` and fire a normal approval prompt — i.e. default behavior.
- `grok agent --permission-mode … stdio` → clap **rejects** it ("unexpected argument"). `--permission-mode` exists only on the top-level TUI / headless `grok`, not the agent subcommand.

So MultiTable sets mode by **spawning the child with the right flags** and pooling one child per `(cwd, mode, effort, model)`.

## The real levers (verified working)

| `grok agent` spawn flag (before `stdio`) | Effect |
|---|---|
| *(none)* | Default — prompts on sensitive tools via `session/request_permission`. |
| `--always-approve` | Runs every tool with **no** prompt. (Verified: file written, zero prompts.) |
| `--agent-profile <md>` (frontmatter `permission_mode: plan`) | **Read-only** — Grok explores + proposes, never edits. (Verified with bundled `~/.grok/bundled/agents/plan.md`: no file written.) |
| `--reasoning-effort <none\|minimal\|low\|medium\|high\|xhigh>` | Effort (see [`models-and-effort.md`](models-and-effort.md)). |
| `-m, --model <MODEL>` | Model. |

Plan mode otherwise can't be client-forced: per Grok's `19-plan-mode.md`, *"there is no slash command to force plan mode"* — it's normally model-initiated (`enter_plan_mode`, user-approved). The read-only agent-profile is the only forced-plan path.

## The 3 modes MultiTable exposes

`capabilities.modes` (in [`grok.ts`](../../../../packages/daemon/src/agent/providers/grok.ts)) lists exactly the modes that map to a **distinct, real** lever:

| `value` | Label | Tone | Spawn flags (`buildAgentArgs`) |
|---|---|---|---|
| `default` | Ask first | standard | *(none)* — prompts |
| `auto` | Auto-approve | danger | `--always-approve` |
| `plan` | Plan | safe | `--agent-profile <MT plan profile>` (full-capability, `permission_mode: plan`) |

The other Claude permission-modes (`acceptEdits`/`dontAsk`/`bypassPermissions`) have **no separate stdio behavior**, so we do not advertise them for Grok — listing them would be a lie.

## Plan mode = native plan→execute in ONE session (the key design)

`plan` spawns a **MultiTable-owned, full-capability** agent profile (`permission_mode: plan`) written to the daemon data dir (`ensurePlanProfilePath` in `grok.ts`) — **not** Grok's bundled `~/.grok/bundled/agents/plan.md`. The bundled one is a *read-only architect with no edit tools* — it can plan but can **never execute** (a dead end; that's why "switch plan→auto to execute" failed). The full-capability profile instead does the real Grok plan flow in a single session:

```
enter_plan_mode            → current_mode_update: plan   (auto; reads/plans only)
  … explores, writes its plan.md …
exit_plan_mode             → _x.ai/exit_plan_mode  (SERVER-REQUEST, payload { sessionId, toolCallId, planContent })
                             Grok BLOCKS here until we reply.
  GrokAdapter.handleExitPlanMode → PermissionManager.requestFromSdk('ExitPlanMode', { plan })
   ├─ allow  → return { outcome:'approved' } → current_mode_update: default → EXECUTES the plan (same session)
   └─ deny   → abort the turn (activeTurnCtrls), return { outcome:'rejected' } → nothing executed
```

**Verified (grok 0.2.2):** the `outcome` VALUE doesn't itself gate Grok — on any reply it flips to `default` and proceeds — so the real gate is (a) holding the request until the user decides and (b) **turn-cancel on reject**. `auto` mode skips this prompt (`handleExitPlanMode` returns `approved` immediately). The unhandled-`_x.ai/exit_plan_mode`-→`-32601` case would break the transition, so the handler is mandatory.

## How a mode change applies

`POST /api/sessions/:id/mode` → `manager.setMode` validates against `capabilities.modes`, sets `s.mode`, and calls `adapter.reset(s)` (drops the cached session entry). The next turn re-runs `GrokAdapter.clientFor(cwd, mode, effort, model)`, which resolves a **different pooled child** for the new config (pool key = `JSON.stringify([cwd, agentArgs])`) and `session/load`s the persisted `agentSessionId` under it. This mirrors Codex's "immutable options → discard cached thread" pattern.

`current_mode_update` notifications (Grok switching mode autonomously, e.g. a model-initiated `enter_plan_mode`) are **informational only** — logged, not acted on, because our mode is spawn-fixed per child.

### ⚠️ Don't rely on switching the mode SELECTOR mid-session (it's creation-bound) — use plan→execute instead

Switching the MultiTable mode selector takes effect on the **next turn** and re-keys to a different pooled child (`session/load` re-attaches history). But because each child's `permission_mode`/profile is fixed at spawn and `session/load` rehydrates the agent the session was **created** with, switching the selector does **not** reliably change a live session's edit capability — historically `auto`→`plan` still edited and a (read-only-architect) `plan`→`auto` stayed read-only.

This is now mostly **moot**: with the full-capability plan profile, you don't switch modes to execute a plan — the **same plan session executes itself** after you approve `exit_plan_mode` (above). So: pick the mode at agent creation; use plan mode's native `exit_plan_mode` to go from plan to execute, not the mode selector. (`default`↔`auto` still meaningfully toggles prompting within an editable session.)

This mirrors Codex's sandbox immutability: capability is set when the conversation starts. **There is no host-side fix without discarding history** (a fresh `session/new` under the new child would apply the new capability but lose the conversation — the Codex "discard thread on flip" tradeoff; `x.ai/session/fork` is unexplored). Surface to users as a known limitation: **choose plan-vs-editable at agent creation.**

## `--sandbox` (still deferred)

The separate OS-enforced `--sandbox <PROFILE>` axis (env `GROK_SANDBOX`) is still not wired; `capabilities.hardSandbox = false`. Permission gating is via the flags above only.
