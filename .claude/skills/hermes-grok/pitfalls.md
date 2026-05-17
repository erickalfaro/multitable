# Top pitfalls — read before changing Hermes code

Condensed checklist of things that have bitten us or that the docs don't make obvious. If a PR touches `hermes.ts`, `hermes-acp/*`, or `hermesParser.ts`, scan this first.

## 1. The permission outcome shape is a nested literal

Return `{ outcome: { outcome: 'selected', optionId } }` or `{ outcome: { outcome: 'cancelled' } }`. The **inner** `outcome` (`'selected'`/`'cancelled'`) is the Pydantic discriminator. Not `'allowed'`/`'denied'`, not flat. Wrong shape silently coerces every approval to a **deny** (bug #20). Use the `AcpPermissionOutcome` type and don't hand-roll the object.

## 2. ACP deltas are ADDITIVE — append, then emit the running total

`agent_message_chunk` / `agent_thought_chunk` carry a *piece*, not a cumulative snapshot. `buffers.assistantText += text; cb.emitAssistantDelta(buffers.assistantText)`. This is the **opposite** of Codex's "replace, don't append." Do not copy Codex's delta handler. `capabilities.streamingDeltaSemantics: 'additive'` describes the wire, not the emit boundary.

## 3. One `hermes acp` child per project cwd — never a daemon singleton

Hermes reads its own `os.getcwd()` for self-perception and context-file discovery. A shared child loads the wrong project's `AGENTS.md`/`CLAUDE.md`. `clientFor(cwd)` pools per resolved cwd; `shutdown()` must loop the whole map. Don't collapse to a singleton "for efficiency."

## 4. `session/load` triggers a replay flood

Hermes re-emits all history as `session/update` after `session/load`. We already hydrated from disk. Guards: 500ms drain in `ensureSessionId` (subscribe happens *after*, so replay has no listener) + `isHistoricalToolId` tool-id dedupe + `user_message_chunk` ignored. Don't move `subscribe()` earlier; don't delete the sleep.

## 5. Disk and live id schemes do NOT match (unlike Codex)

Parser: `hermes:<session_id>:m<seq>:<kind>`. Live: `hermes:<…>:tool_use:<toolCallId>` / `:assistant:<Date.now()>`. Tool dedupe is by **`toolUseId` scan**, not id equality. There is no `emitMessageRekey` for Hermes. Don't assume a Codex-style canonical-id match — Hermes' rewrite-on-save single-file persistence has no turn-index/per-event id to anchor one.

## 6. No USD cost — ever

`capabilities.costUsd: false`. `applyUsage({ …, costUsd: 0 })`, `emitTurnResult({ totalCostUsd: 0, … })`. Don't derive USD from tokens; Grok-OAuth billing is subscription-based and opaque to us.

## 7. `'max'` thinking effort is dropped, not mapped

`hermesEffort = effort === 'max' ? null : effort`. `max` is Claude-only; Hermes/Grok reject it. We send no `/reasoning` prefix and let Hermes' default (medium) stand. `minimal`/`none` are never sent (not MultiTable tiers). Only `low`/`medium`/`high`/`xhigh` become a `/reasoning` arg.

## 8. `/reasoning` prefix is emitted only on change — and the parser strips it

Keyed by `lastSentEffort` (MultiTable `s.id`). Poisoned on turn error and `reset()`. `hermesParser` strips `^/reasoning\s+\S+\s*` from user messages. Change the prefix format in `hermes.ts` and you MUST change the regex in `hermesParser.ts` in lockstep, or old transcripts show `/reasoning high` as user-typed.

## 9. The session cache is keyed by `{sessionId, mode}` and poisons on throw

`ensureSessionId` returns cached only if `entry.mode === s.mode`. `runTurn`'s `catch` deletes the `sessions` + `lastSentEffort` entries so the next turn re-`session/load`s from `state.db`. Don't reuse a cached `hermesSessionId` after a throw — Hermes-side state is uncertain.

## 10. `acpToMt` reverse map is required for permission routing

`session/request_permission` carries only the Hermes session id. `handleAcpPermission` needs `acpToMt.get(req.sessionId)` → MultiTable id. It's populated in `ensureSessionId` and cleared in `reset()`. An unknown id → return `cancelled` (don't crash).

## 10b. Hermes self-gates — the host CANNOT force-prompt every tool call

This is the single most common false bug report ("Hermes deleted a file / ran a command without asking"). It is **not** a MultiTable bug and **not** fixable in the adapter.

Hermes only emits `session/request_permission` for commands its **own** `tools/approval.py` flags. The gate (Hermes-side, `requires_approval`):

```
detect_dangerous_command(cmd)  →  matches DANGEROUS_PATTERNS / HARDLINE_PATTERNS?
  └─ NO  → runs immediately, {"approved": true}, NO server-request, host never sees it
  └─ YES → approvals.mode:
            manual (default) → prompt_dangerous_approval → our ACP callback → UI ✅
            smart            → auxiliary LLM auto-approves "low-risk" → usually no UI
            off / HERMES_YOLO_MODE / session yolo → auto-approve, no UI
```

`DANGEROUS_PATTERNS` for `rm` only match **recursive/root** deletes (`rm -r`, `rm --recursive`, `rm … /`). A plain `rm -f foo.py`, `mv`, `>file`, `git reset`, single-file overwrite, etc. are **not** flagged → Hermes runs them with no prompt and **nothing reaches MultiTable**. There is no ACP server-request, so `handleAcpPermission` is never called — adding code there cannot help.

There is **no host-side lever** to widen this:
- No ACP "ask me about every tool" channel; `capabilities.hooks: 'none'`, no `canUseTool` equivalent (that's Claude — do not reach for it).
- No sandbox/trust enum we set (we advertise `fs:false, terminal:false`; Hermes runs tools in *its own* sandbox).
- `approvals.mode` is read from `~/.hermes/config.yaml` via `load_config()`, **not** an env var — we cannot override it at spawn. The only approval envs are `HERMES_YOLO_MODE` (disables prompting — wrong direction) and `HERMES_SESSION_PLATFORM` (a tag).
- `DANGEROUS_PATTERNS` is hardcoded in Hermes; widening it = forking Hermes.

What you *can* truthfully tell a user: gating granularity is Hermes', not MultiTable's. Options are (a) accept Hermes' model, (b) set `approvals.mode: manual` in `~/.hermes/config.yaml` so flagged commands at least always hit the UI instead of LLM-auto-approve (default is already `manual`; only helps if they'd switched to `smart`), or (c) use Claude/Codex for workflows that need per-tool host approval. Do **not** "fix" this by faking interception in the adapter — there is no tool call to intercept.

## 11. Permission requests have no abort signal (v1 limitation)

`handleAcpPermission` passes a fresh never-aborted controller. Cancelling a turn while a prompt is open leaves it open; a late answer returns a stale optionId Hermes ignores. Accepted. Don't fake an abort (it'd become a deny).

## 12. We don't advertise fs/terminal — and we reject them

`clientCapabilities: { fs:{readTextFile:false,writeTextFile:false}, terminal:false }`. `fs/*` and `terminal/*` server-request handlers **throw** by design. Don't implement them "to help" — that punches a hole in `hardSandbox`. Hermes runs file/terminal work in its own sandbox.

## 13. `mcpServers` is always `[]` on `session/new` / `session/load`

MCP wiring is Hermes-side (`hermes tools`), never daemon-side. Don't pass MCP servers from MultiTable.

## 14. stdout is JSON-RPC only; stderr is logs

Non-JSON stdout lines are dropped. Hermes logs to stderr (surfaced as `[hermes-acp]` warnings, never load-bearing). Don't parse stderr for state; don't write non-JSON to the child's stdin.

## 15. `cancel` is a notification — no response, no await

`session/cancel` is fire-and-forget; the in-flight `session/prompt` resolves with `stopReason: 'cancelled'`. If the transport is dead, `cancel` is a silent no-op. Don't `await client.cancel(...)`; it returns void.

## 16. `provisionSession` / `warmup` are NOT implemented for Hermes

The session id is minted lazily on the first turn's `ensureSessionId`. Unlike Codex/Claude there's no eager provision. If a feature needs a live session id before the first turn, that's net-new work, not a wired path.

## 17. The canonical assistant message comes from the buffer, not the response

`session/prompt`'s response only carries `stopReason` + `usage`. The assistant text is whatever accumulated in `buffers.assistantText`. Pure-tool turns (no assistant text) emit no assistant Message — that's intentional, not a dropped message.

## 18. `resolveCwd` never returns empty

Empty `workingDir` → log loudly, fall back to `homedir()`. An empty cwd would make Hermes use the child's process cwd for self-perception *and* terminal execution. Don't "simplify" this to return `s.workingDir` directly.

## 19. needsSetup throws BEFORE a session exists

Auth-not-configured surfaces as a persistent `auth` alert and a throw in `runTurn` *before* `ensureSessionId`. Don't create/persist a session id for an unauthenticated turn.

## 20. Frontend should ignore unknown session ids gracefully

After session removal the daemon may still emit a few in-flight WS events (late `session/update`, replay tail). The store should drop them silently — don't crash on an unknown id.
