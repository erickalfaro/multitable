# Known bugs & version-pinned observations — Grok Build

Grok Build is in **early beta** (CLI launched 2026-05-14, `grok-build-0.1` model 2026-05-20). The CLI changes frequently, so every wire observation must be stamped with the `grok --version` it was seen on. This is the running log — append, don't overwrite, and re-verify after each Grok upgrade.

## How to re-baseline after a Grok upgrade

```bash
grok --version                          # stamp every observation with this
grok inspect                            # config sources, MCP, skills, plugins, hooks, AGENTS.md
# scripted ACP handshake (records real frame shapes):
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}}' | grok agent stdio
```

Capture: the `initialize` result (`protocolVersion`, `agentCapabilities`, `authMethods`), whether `session/new`/`session/load`/`session/prompt` respond, the `session/update` kinds emitted, the `session/request_permission` payload + option ids, and whether `session/set_mode` / model override / effort knobs exist.

## Observed quirks (research-derived; confirm locally)

| ID | Observed on | Symptom | Cause | Mitigation |
|---|---|---|---|---|
| G1 | grok 0.1.x | `session/*` requests silently time out (~12 s) while `initialize` works | Grok's ACP parser does not unescape `\/` in `method` names | Transport rewrites `\/`→`/` in outbound `method`. [`../pitfalls.md`](../pitfalls.md) §1 |
| G2 | grok 0.1.210 | `x.ai/billing` returns `-32601 Method not found` over agent-stdio | Billing extension wired into the TUI only, not the agent-stdio surface | `costUsd=false`; don't probe per-turn; cache `-32601` as unavailable. [`../reference/xai-auth.md`](../reference/xai-auth.md) |
| G3 | grok 0.1.x | Tool runs / file writes with no prompt in `code` mode | Grok self-gates approvals; no host force-prompt over ACP | Document, not fix. Use `ask`/`plan`. [`../pitfalls.md`](../pitfalls.md) §6 |
| G4 | grok 0.1.x | First turn in a fresh dir stalls or refuses tools | Workspace-trust gate (`~/.grok/workspace-trust.json`) | VERIFY trust behavior over agent-stdio; route or pre-seed. [`../pitfalls.md`](../pitfalls.md) §9 |

## Resolved on grok v0.2.2 (2026-05-27 handshake spike)

The G1/G2/G4 quirks above were **0.1.x** observations and did NOT reproduce on 0.2.2:
- **G1 (`\/` parser bug):** not observed — plain `session/new`/`session/prompt` work (Node's `JSON.stringify` doesn't escape `/`). The transport shim is unnecessary on 0.2.2; we don't ship one.
- **G2 (`x.ai/billing -32601`):** not re-tested (we don't probe billing). `costUsd=false` stands, but real token usage **is** available (see below).
- **G4 (workspace-trust):** no trust gate hit over agent-stdio in this repo's cwd.

> **⚠️ Correction (2026-05-27, second probe):** the row below that claimed `session/new` accepts `permissionMode` and that the Claude `--permission-mode` enum is reachable was **WRONG** — it only confirmed the param didn't *error*, not that it was *applied*. See "Modes/effort are spawn-time only" further down; this row is kept struck-through for history.

The original VERIFY checklist, now answered against 0.2.2:

| Item | Verified answer |
|---|---|
| ~~`planMode`~~ | ~~**native** — `--permission-mode` enum = Claude's; `session/new` accepts `permissionMode`.~~ **WRONG — see correction below.** Mode is spawn-time only; plan via `--agent-profile`. |
| `session/load` + replay | `agentCapabilities.loadSession: true`. No replay flood observed on a fresh session; the adapter keeps a 500ms post-load drain defensively. |
| On-disk format | `~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId(uuidv7)>/` with `summary.json`, `chat_history.jsonl`, **`updates.jsonl`** (the session/update replay — what `grokParser` reads), `session_search.sqlite` index. |
| Per-cwd vs singleton | Grok honors the per-session `cwd` on `session/new` (returns `currentWorkingDirectory`). We still pool **per-cwd** for parity/scoping; a singleton would also be correct. |
| Subagents | session/update kinds for subagents not exercised yet → `subagents: 'none'` for now. |
| ~~`thinkingEffort`~~ | ~~**native** — `session/new` accepts `effort`.~~ **CORRECTED:** native but **spawn-time** — `grok agent --reasoning-effort none\|minimal\|low\|medium\|high\|xhigh` (**no `max`** → maps to `xhigh`); `session/new` `effort` is ignored. |
| `userQuestion` / `elicitation` | none seen → both off. |
| `hardSandbox` / fs | Grok accepted `clientCapabilities.fs:false,terminal:false`; sent no fs/terminal requests. `hardSandbox: false` (v1 leaves `--sandbox` default). |
| Auth | `authMethods: [cached_token, grok.com]`; `authenticate({methodId:'cached_token'})` succeeds for subscribers. needsSetup when only `grok.com` is offered / authenticate fails. |
| `protocolVersion` | integer `1`. |
| usage | `session/prompt` response `_meta`: `inputTokens`, `outputTokens`, `cachedReadTokens`, `reasoningTokens`, `totalTokens`, `modelId` → `applyUsage` (no USD). |
| `session/request_permission` payload | **VERIFIED on a tool turn (2026-05-27):** options are `always-allow`(kind `allow_always`) / `allow-once`(`allow_once`) / `reject-once`(`reject_once`) / `reject-always`(`reject_always`); `toolCall.rawInput` carries `variant`+`command` for bash. `handleAcpPermission`'s `kind === 'allow_once'` match works as-is. |

Re-baseline (re-run the handshake spike) after each `grok` upgrade and update this table.

## Resolved on grok v0.2.2 — modes & effort are SPAWN-TIME only (2026-05-27, second probe)

| ID | Symptom | Cause | Fix |
|---|---|---|---|
| G5 | Behavior selector inert: Plan doesn't plan (Grok edits/runs tools); Auto still prompts; effort ignored. | `grok agent stdio` has **no per-session mode RPC** (`session/new` returns **no** `modes`/`availableModes` → ACP `session/set_mode` N/A) and **silently ignores** `permissionMode`/`effort`/`model` on `session/new`. Mode/effort/model are **spawn-time flags** on the `grok agent` parent. | Map mode→flags and spawn one child per `(cwd, mode, effort, model)`, pooled & re-keyed on flip (like Codex). `default`→none, `auto`→`--always-approve`, `plan`→`--agent-profile <bundled plan.md>`; effort→`--reasoning-effort` (`max`→`xhigh`); model→`-m`. See `grok.ts` `buildAgentArgs`/`clientFor`. |

Verified behaviors (probe):
- `--always-approve` (before `stdio`) → tool runs with **no** `session/request_permission`; file written.
- `--agent-profile ~/.grok/bundled/agents/plan.md` → **read-only**: Grok explores, refuses to write.
- `grok agent --permission-mode … stdio` → clap **rejects** (`--permission-mode` is TUI/headless-only).
- `--reasoning-effort max` → **invalid** (accepts `none|minimal|low|medium|high|xhigh`).

**G5a — edit capability is LOCKED AT SESSION CREATION; mid-session switching can't change it (verified BOTH directions).** A flip preserves history (`session/load` re-attaches the same Grok session under the new child — verified: a plan turn recalled a fact from an earlier auto turn), but the agent's toolset is fixed at `session/new` and `session/load` rehydrates it regardless of the loading child:
- auto/default-created (editable) → switch to `plan` → **still edits** (auto→plan wrote a file).
- plan-created (read-only) → switch to `auto`/`default` → **still read-only** (plan→auto refused: *"restricted to read-only … no file modification tools … permitted"*, no file written).
The only mid-session-mutable axis is **prompting** (`default`↔`auto`), and only within an editable session. This mirrors Codex sandbox immutability. No host fix without discarding history (fresh `session/new` loses the conversation; `x.ai/session/fork` unexplored). Choose plan-vs-editable at **agent creation**. See [`../reference/modes.md`](../reference/modes.md) "Edit capability is LOCKED AT SESSION CREATION".

**G5b — plan→execute now uses the NATIVE flow, not the read-only architect (resolved).** G5a's read-only dead-end was because `plan` mapped to Grok's bundled `plan.md` (an architect with no edit tools — can plan, never execute). Fixed by mapping `plan` to a MultiTable-owned **full-capability** profile (`permission_mode: plan`): it plans, then calls `exit_plan_mode` → the `_x.ai/exit_plan_mode` server-request, which `handleExitPlanMode` gates via the approval UI → approve **executes in the same session**, deny aborts the turn. So you no longer "switch plan→auto to execute" — the plan session executes itself on approval. Verified: the response `outcome` value doesn't gate (Grok proceeds on any reply); the gate is response-timing + turn-cancel-on-deny. See [`../reference/modes.md`](../reference/modes.md) "Plan mode = native plan→execute" + [`permission-wiring.md`](permission-wiring.md).

Reference: ACP session-modes spec (`agentclientprotocol.com/protocol/session-modes`) — note Grok 0.2.2 does **not** implement it over agent-stdio. Acknowledge-≠-enforce precedent for ACP set-mode: qwen-code #1806 (a host wiring `session/set_mode` can still see the agent not enforce — Grok sidesteps this entirely by having no set-mode at all, hence the spawn-flag approach).

## `ask_user_question` IS interactive — via the `_x.ai/ask_user_question` server-request

Grok's `ask_user_question` tool delegates to the client over ACP: it sends a JSON-RPC **server-request `_x.ai/ask_user_question`** and waits for the answer. If the client has no handler, the transport returns `-32601` and the tool fails with *"Failed to reach the client for user question: multitable has no handler registered for _x.ai/ask_user_question"* (the original bug — it looked non-interactive because the request was unhandled, not because Grok auto-completes).

**Verified wire shape (grok v0.2.2, spike):**
- Request params: `{ sessionId, toolCallId, questions: [{ question, options: [{ label, description?, preview? }], multiSelect: bool|null }], mode }`.
- Response (the `outcome` is a **string** tag, NOT the nested object `session/request_permission` uses):
  - `{ outcome: "accepted", answers: { "<questionIndex>": ["<selected label>", …] } }` — answers keyed by stringified question index → selected option labels.
  - `{ outcome: "cancelled" }` — also valid: `skip_interview`, `chat_about_this` (unused).
- A wrong shape fails the tool; serde errors are descriptive (e.g. *"unknown variant `selected`, expected one of `accepted`, `chat_about_this`, `skip_interview`, `cancelled`"*).

**Wiring:** `GrokAcpClient` registers a `_x.ai/ask_user_question` handler; `GrokAdapter.handleAskQuestion` routes it through `PermissionManager.requestFromSdk(…, 'AskUserQuestion', { questions })` — the **same interactive picker Claude's AskUserQuestion uses** (`PermissionBar`). The user's selections come back as the Claude-convention `{ behavior:'deny', message: '{"questions":[{…,"answer":[…]}]}' }`; we remap to `answers` keyed by index. All-empty selections (the picker's cancel) → `{ outcome: "cancelled" }`. `capabilities.userQuestion = 'tool'`. `ToolCallCard` also renders the question/options legibly in the transcript.
