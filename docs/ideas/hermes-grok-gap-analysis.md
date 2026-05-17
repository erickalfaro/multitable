# Hermes/Grok Provider — Gap Analysis vs Claude & Codex

## Context

MultiTable ships three live provider adapters (`claude`, `codex`, `hermes`) behind the
`ProviderAdapter` contract. Hermes (xAI Grok over `hermes acp` / ACP JSON-RPC) was
added most recently. This document audits any pattern Hermes is missing relative to the
two older, more mature adapters. It is **analysis only** — findings + severity, no
implementation steps. Findings were verified against source directly.

---

## Summary table

| # | Gap | Severity | Hermes vs Claude/Codex |
|---|-----|----------|------------------------|
| 1 | No "browse/resume past Hermes sessions" (API + UI) | **High** | Codex & Claude have it; Hermes parser exists but is unreachable |
| 2 | No `provisionSession()` for Hermes | **High** | Codex eagerly mints+persists id; Hermes only on first prompt |
| 3 | Live plan/task list never surfaces (ACP `plan` ignored) | **High** | Tasks tab populated for Claude/Codex, permanently empty for Hermes |
| 4 | No post-turn reconciliation against on-disk transcript | Medium | Codex self-heals disk↔memory drift; Hermes does not |
| 5 | No crash-respawn alert / watchdog parity | Medium | Codex surfaces a recovery alert; Hermes fails raw |
| 6 | `usage_update` ignored → no mid-turn token snapshots | Medium | Codex updates live; Hermes only at turn end |
| 7 | Resume-command string is a bare id | Low | Claude/Codex emit a runnable command |
| 8 | `generateSessionTags()` is dead code (all providers) | Low | Latent; `tags` column never auto-filled |
| 9 | Auto-title is truncation-only; AI title is manual-only | Cross-provider | Affects all three, with a Hermes-specific lookup weakness |

By-design non-gaps are listed separately at the end so they are not mistaken for bugs.

---

## High severity

### 1. No "browse/resume past Hermes sessions" (API + UI)

- **Claude**: `GET /api/transcripts` (lists `~/.claude/projects` JSONL) +
  `POST /api/transcripts/:sessionId/resume`; surfaced in `AddAgentModal` / `PastAgentsBrowser`.
- **Codex**: `GET /api/transcripts/codex` + `POST /api/transcripts/codex/:threadId/resume`
  (`packages/daemon/src/api/transcripts.ts:433-549`); UI section + `useCodexTranscripts`.
- **Hermes**: a working parser exists
  (`packages/daemon/src/transcripts/hermesParser.ts`) and on-disk conversations live at
  `~/.hermes/sessions/session_<id>.json`, but there is **no list endpoint, no resume
  endpoint, no `useHermesTranscripts` hook, and no `AddAgentModal` section**
  (`AddAgentModal.tsx:285-308` renders only Claude + Codex past-session groups).

**Impact:** prior Grok conversations are persisted but unreachable from MultiTable —
users must drop to the `hermes` CLI to resume. Largest parity gap.

### 2. No `provisionSession()` for Hermes

- **Codex**: implements `provisionSession()` (`manager.ts:360`; adapter calls
  `createThread()`), so a created-but-never-prompted session has its id + rollout file
  on disk immediately → hydratable/resumable.
- **Claude**: intentionally skips it (SDK assigns the id at `system:init` during the
  first turn — there is a backstop).
- **Hermes**: mints the session id **lazily on the first turn** inside
  `ensureSessionId()` (`packages/daemon/src/agent/providers/hermes.ts`). A Hermes
  session that is created but never prompted has **no `agentSessionId`**, so it cannot
  be hydrated and will never appear in any future "past sessions" list keyed off disk.

**Impact:** compounds gap #1 and breaks the "create now, talk later" lifecycle Codex
supports. Hermes has no equivalent of Claude's `system:init` backstop.

### 3. Live plan/task list never surfaces (ACP `plan` ignored)

`handleNotification` in `packages/daemon/src/agent/providers/hermes.ts` (~lines
678-684) explicitly **ignores** `plan`, `available_commands_update`,
`config_option_update`, `current_mode_update`, and `usage_update`.

- **Claude**: TodoWrite drives `session:task-event` → Tasks tab populated.
- **Codex**: maps `plan` items into system/task messages → Tasks tab populated.
- **Hermes**: ACP emits a `plan` notification, but it is dropped → the **Tasks tab is
  permanently empty for Hermes sessions** even when Grok is actively planning.

**Impact:** a visible, advertised UI surface silently does nothing for one provider.

---

## Medium severity

### 4. No post-turn reconciliation against the on-disk transcript

- **Codex**: ~250 ms after the stream closes it re-parses the rollout via
  `parseCodexThread()`, diffs against in-memory `s.messages`, broadcasts the delta, and
  emits `session:reconciled` (belt-and-braces self-heal).
- **Claude**: rekeys optimistic user messages against canonical ids.
- **Hermes**: relies **solely** on live ACP notifications + the 500 ms replay-drain +
  tool-id dedup. If a notification is dropped or the `hermes acp` child dies mid-turn,
  in-memory `s.messages` silently drifts from `~/.hermes/sessions/session_<id>.json`
  with **no self-heal until daemon restart**. The parser that would enable
  reconciliation already exists and is only used at register-time.

### 5. No crash-respawn alert / watchdog parity

- **Codex**: `respawnFlag` + a one-time "Codex restarted; resuming conversation" alert
  + a crash-respawn watchdog in `codex-app-server`.
- **Hermes**: `transport.ts` fails all pending requests on child exit but there is
  **no user-facing alert and no respawn watchdog** — recovery is only the lazy
  `clientFor()` re-spawn on the *next* turn. A mid-turn crash surfaces as a raw
  rejected RPC ("`session/prompt failed: …`") with no graceful messaging.

### 6. `usage_update` ignored → no mid-turn token snapshots

Hermes applies usage only from the **final `prompt()` response**
(`packages/daemon/src/agent/providers/hermes.ts:383-396`). Codex emits live
`ThreadTokenUsageUpdated` notifications mid-turn. Result: Hermes token counters in the
UI don't move until the turn ends — inconsistent with Codex's live counter.

> Note: token tracking itself **is** wired for Hermes (`cb.applyUsage({…, costUsd: 0})`).
> Only USD is suppressed (`costUsd: false`), which is **by design** (subscription model)
> — *not* a gap.

---

## Low severity

### 7. Resume-command string is a bare id

`SessionHeaderBar.tsx:32-36` returns `claude --resume <id>` / `codex resume <id>` for
those providers but a **bare session id** for Hermes. There is likely no user-facing
`hermes` resume verb, so this may not be fixable as a literal command — but the UI
presents the bare id as if it were one (copy-as-command affordance is misleading).

### 8. `generateSessionTags()` is dead code

`labeler.ts:252` defines `generateSessionTags()` with **zero callers** for any
provider. The `tags` column exists in the schema but is never auto-populated. Latent,
cross-provider, not Hermes-specific.

---

## Cross-provider finding: auto-title

The auto-rename path is **plain 60-char truncation of the first prompt for all three
providers**: adapters call `cb.maybeRenameFromFirstPrompt(text)` when
`s.userMessages.length === 1` (`hermes.ts:255`, `codex.ts:232`, `claude.ts:160` &
`:550`), which reaches `manager.ts:839 maybeRenameFromFirstPrompt` →
`titleFromFirstPrompt()` (`manager.ts:51`) — a truncation, **not** an AI summary.

The only AI-summarized title is the **manual Sparkles button** in `SessionHeaderBar` →
`POST /api/sessions/:id/rename-ai` → `generateSessionLabel()` (Haiku). **No provider
auto-generates an AI title at end of first turn**; `session:turn-complete` (App.tsx)
does not trigger it. So a "Hermes never gets an AI title" observation is real but
missing everywhere — it just *feels* Hermes-specific.

Recommended direction (future implementation pass, out of scope here): an automatic
AI-rename trigger at first-turn-complete for Claude, Codex **and** Hermes.

**Hermes-specific weakness inside this path:** the `/rename-ai` prompt-lookup chain
(`sessions.ts:464-481`) special-cases `agentProvider === 'codex'` and Claude JSONL,
then falls through to in-memory `agent.userMessages`. For Hermes that final fallback is
the *only* source. A resumed/hydrated Hermes session populates `s.messages` (via
`parseHermesSession`) but **not** `s.userMessages`, so manual AI-rename on a resumed
Hermes session *before* sending a new prompt can fail with "No prompts yet." Any
auto-title work must read Hermes prompts from the hydrated transcript, not just the
in-memory `userMessages` array.

---

## By design — NOT gaps (documented to prevent false positives)

- `costUsd: false` — Grok is subscription; per-turn USD intentionally hidden. Tokens
  are still tracked.
- `hooks: 'none'`, `elicitation: false`, `subagents: 'none'`,
  `userQuestion: 'unsupported'` — the ACP surface does not expose these.
- `planMode: 'simulated'` — ACP has no native plan-mode RPC; modes are advisory.
- Hermes **self-gates** permissions via its own hardcoded `DANGEROUS_PATTERNS`; the
  host cannot force-prompt non-flagged tools. Hermes design property, not a MultiTable
  omission — do **not** add fake interception.
- Mandatory `bwrap` sandbox, fail-closed (`SandboxUnavailableError`) — intentional
  confinement; only opt-out is `MULTITABLE_HERMES_SANDBOX=off` (logged loudly).
- Per-cwd child pool, additive delta semantics, and the nested permission outcome shape
  `{ outcome: { outcome: 'selected', optionId } }` are correct ACP-isms, not
  inconsistencies.
- No option detection for Hermes (`runStopWork` is Claude-only, `manager.ts:627`) — it
  parses Claude JSONL specifically; provider-specific by nature, not a gap.
