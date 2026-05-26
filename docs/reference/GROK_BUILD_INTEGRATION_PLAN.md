# Grok Build Integration Plan — MultiTable's 4th agent provider

> **Drafted 2026-05-26.** Research-derived from xAI docs + third-party ACP integrations (CodexBar, OpenACP/cmux) + the ACP spec; **not yet validated against a running `grok agent stdio`.** Every wire-level claim tagged **`VERIFY`** must be confirmed against the installed binary before code depends on it. Companion skill: [`.claude/skills/grok-build/`](../../.claude/skills/grok-build/SKILL.md) (authoritative, single-provider). Cross-provider design reasoning: [`THREE_PROVIDER_INTEGRATION_PLAN.md`](THREE_PROVIDER_INTEGRATION_PLAN.md).

## TL;DR

**Grok Build** is xAI's official agentic coding CLI (binary `grok`, launched 2026-05-14; model `grok-build-0.1`, 256K context, 2026-05-20). It ships **full ACP support** via `grok agent stdio` — **line-delimited JSON-RPC 2.0 over stdio, no Content-Length framing** — which is the *same protocol family the Hermes adapter already speaks*. So this is not a green-field integration: it's a **sibling of the Hermes adapter**, implemented as a **separate** `grok.ts` + `grok-acp/` + `grokParser.ts` (no shared code — see [Decision 1](#decision-1-separate-not-shared)).

- **Provider key:** `grok` · **UI label:** "Grok Build" · **command:** `grok` · **badge glyph:** `G`.
- **Transport:** `grok agent stdio`, line-delimited JSON-RPC 2.0; **mandatory `\/`→`/` method-name shim**.
- **Auth:** `~/.grok/auth.json` (OAuth, SuperGrok/SuperHeavy sub) or env `GROK_CODE_XAI_API_KEY` / `XAI_API_KEY`.
- **Modes:** `code` (auto) / `plan` (diffs+approval) / `ask` (read-only).
- **Cost:** off for v1 (`x.ai/billing` is TUI-only over agent-stdio → `-32601`).

## Context

MultiTable ships three live providers (Claude Agent SDK, Codex `app-server` JSON-RPC, Hermes ACP) behind a stable `ProviderAdapter` contract; the React UI is provider-agnostic, rendering off `ProviderCapabilities`. Adding Grok Build follows the documented "to add a provider" recipe in `CLAUDE.md`: drop a `<provider>.ts` adapter, register it in the manager's adapter map, add a `transcripts/<provider>Parser.ts`, **and create the provider's `.claude/skills/<provider>/` skill folder** (done first — see [`grok-build/`](../../.claude/skills/grok-build/SKILL.md)).

The good news: because Grok speaks ACP, the **hard parts are already solved once** by the Hermes adapter (line-delimited JSON-RPC transport, `session/request_permission` → `PermissionManager` bridge, additive-delta accumulation, per-cwd child pooling, replay-flood dedupe). We **re-implement** them for Grok rather than share them, per the repo's strict single-provider isolation rule.

## Decision 1: separate, not shared {#decision-1-separate-not-shared}

Grok Build and Hermes both speak ACP. The tempting move is a shared `acp/` transport. **The repo's rules forbid it** — CLAUDE.md: "Keep each skill **strictly single-provider** — never blend two providers' SDK or protocol content," and the memory `[[feedback_separate_sdks]]`. So:

- New `agent/providers/grok-acp/` (transport + client + index), **copy-adapted** from `hermes-acp/`, not a shared module.
- The wire details **diverge** enough to justify the duplication: the `grok agent stdio` subcommand, the **`\/` method-name bug** (Hermes doesn't have it), the `x.ai/billing` extension, native `code`/`plan`/`ask` modes (vs Hermes' advisory ones), subagents/Arena (Hermes has none), and different auth/error strings.
- Isolation is the *feature*: a future provider added by cloning the Hermes adapter must not silently inherit Grok's quirks, and vice-versa.

If duplication ever becomes painful, that's a separate, deliberate refactor discussion — not something to pre-optimize into v1.

## Decision 2: provider naming

- Provider enum value: **`grok`** (DB `agent_provider`, `AgentProvider` union, `VALID_PROVIDERS`).
- UI: **"Grok Build"** (distinct from the existing **"Hermes (Grok)"** — both are xAI, but different agents/binaries).
- Command: `grok`; resume id label: "Grok session ID"; badge glyph `G` with an xAI-tinted color.

## Part 1 — Capability matrix vs the three live providers

Legend: ✅ first-class · ⚠️ partial/workaround · ❌ not supported · ❓ `VERIFY`

| Capability | Claude | Codex | Hermes | **Grok Build (proposed)** |
|---|---|---|---|---|
| Transport | in-proc SDK | app-server JSON-RPC child | `hermes acp` (ACP stdio) | **`grok agent stdio` (ACP stdio)** |
| Streaming deltas | additive | cumulative | additive | **additive** (accumulate, emit total) |
| Per-call approval | `canUseTool` | sandbox (none) | `session/request_permission` | **`session/request_permission`** → PermissionManager |
| Plan mode | ✅ native | ⚠️ 2-spawn | ⚠️ advisory | **❓ native if ACP set-mode works, else simulated** |
| Modes | 6 PermissionModes | 3 SandboxModes | 3 advisory | **`code`/`plan`/`ask`** |
| Cost (USD) | ✅ | ❌ | ❌ | **❌ v1** (`x.ai/billing` TUI-only → -32601) |
| Subagents | manual | ❌ | ❌ | **❓ auto (up to 8 + Arena)** — map to `emitTaskEvent` |
| Thinking effort | ✅ | ✅ | ✅ `/reasoning` | **❓ unsupported until proven** |
| Elicitation / user-Q | ✅ | ❌ | ❌ | **❓ unsupported until proven** |
| Hooks (host-brokered) | 29 events | 0 | none | **none** (Grok hooks run Grok-side) |
| Hard sandbox | ❌ soft | ✅ OS | ✅ own | **❓ true** (workspace-trust + protected dirs) |
| Persistence | `~/.claude/projects/*.jsonl` | `~/.codex/sessions/rollout-*.jsonl` | `~/.hermes/sessions/*.json` | **`~/.grok/` (format ❓)** |
| Auth | API key / `~/.claude/auth.json` | `~/.codex/auth.json` | `~/.hermes/` OAuth | **`~/.grok/auth.json` OR `GROK_CODE_XAI_API_KEY`** |

Full per-axis reasoning lives in the skill: [`multitable/adapter-architecture.md`](../../.claude/skills/grok-build/multitable/adapter-architecture.md).

## Part 2 — File-by-file change list

### A. New files (daemon)

| File | Modeled on | Contents |
|---|---|---|
| `agent/providers/grok-acp/transport.ts` | `hermes-acp/transport.ts` | line-delimited JSON-RPC 2.0; frame classification; id correlation; server-request dispatch; **`\/`→`/` outbound method shim** |
| `agent/providers/grok-acp/client.ts` | `hermes-acp/client.ts` | spawn `grok agent stdio`; `initialize`/`authenticate`; `session/new`·`load`·`prompt`·`cancel`; `subscribe`; permission fan-out; `AcpPermissionOutcome` |
| `agent/providers/grok-acp/index.ts` | `hermes-acp/index.ts` | re-exports |
| `agent/providers/grok.ts` | `hermes.ts` | adapter: per-cwd client pool, `runTurn`, `handleNotification`, `handleAcpPermission`, capabilities, session cache |
| `transcripts/grokParser.ts` | `hermesParser.ts` / `codexParser.ts` | `~/.grok/<sessions>` → `Message[]` (format `VERIFY` first) |

### B. Edits (daemon — provider union + registration)

| File:line | Change |
|---|---|
| `agent/types.ts:3` | `AgentProvider = 'claude' \| 'codex' \| 'hermes' \| 'grok'` |
| `agent/providers/types.ts:204` | add `'grok'` to `ProviderAdapter.name` |
| `agent/providers/index.ts` | re-export `GrokAdapter` + `grok-acp` |
| `agent/manager.ts` (~L111, ~L233) | register `grok: new GrokAdapter(permManager)`; hydrate grok sessions from disk on `register()` |
| `db/store.ts` (L315/362/407/443/522) | extend provider unions; default-provider logic if any |
| `api/providers.ts:26` | add `'grok'` to `VALID_PROVIDERS` |
| `api/projects.ts:394` | accept `'grok'` in session-creation provider validation |
| `api/sessions.ts` (~L309) | re-hydrate via `parseGrokSession` for grok sessions |
| `providers/baselines.ts:89` | add `GROK_BASELINE` + `case 'grok'` in `baselineFor` |
| `providers/catalog.ts:33` | add `'grok'` to `Provider` |
| `providers/discovery.ts` | add `discoverGrok(env)` (model list or baseline fallback) |

### C. Edits (web)

| File | Change |
|---|---|
| `lib/types.ts:3` | add `'grok'` to `AgentProvider` |
| `lib/api.ts` (L165/226/246/264) | extend provider unions in catalog calls |
| `stores/appStore.ts` (~L1261) | `modelCatalog.grok`; provider cast |
| `components/modals/AddAgentModal.tsx:35` | add `{ name: 'Grok Build', command: 'grok', provider: 'grok' }` to the **live** list (not `comingSoon`); wire `grokModels` |
| `components/ui/ProviderLogo.tsx` | add Grok/x.ai logo path + `grok: 'Grok Build'` label |
| `components/ui/AgentBadge.tsx` | add `grok` label/glyph (`G`) + `tintFor` color |
| `lib/resumeCommand.ts` | `buildResumeCommand`/`sessionIdLabel` for grok (resume verb `VERIFY`; "Grok session ID") |
| `lib/modeTone.ts` | fallback tones for `code`/`plan`/`ask` (the adapter declares tones; this is the resilience fallback) |
| `App.tsx`, `chat/ChatInputCM.tsx`, `chat/SessionChat.tsx`, `SessionDetailPanel.tsx` | audit `provider ===` branches; should all be capability-driven, but verify none assume a closed set |

### D. The skill folder (already created)

[`.claude/skills/grok-build/`](../../.claude/skills/grok-build/SKILL.md) — `SKILL.md`, `pitfalls.md`, `reference/{acp-protocol,xai-auth,modes,models-and-effort,slash-commands}.md`, `multitable/{adapter-architecture,permission-wiring,persistence-and-parser,known-bugs}.md`. Per CLAUDE.md this is mandatory and was written first.

## Part 3 — Verification protocol (do this before/with the adapter PRs)

The capability table is full of `❓` because it can only be settled against a live binary. Before PR3/PR4, run the baseline in [`grok-build/multitable/known-bugs.md`](../../.claude/skills/grok-build/multitable/known-bugs.md) and resolve the **open VERIFY checklist** there:

1. `grok --version`, `grok inspect`.
2. Scripted `grok agent stdio` handshake → capture `initialize` result, `authMethods`, `agentCapabilities`.
3. `session/new` → `session/prompt "hello"` → record the `session/update` kinds.
4. Trigger a write in `code` mode → capture the `session/request_permission` payload (option ids, `toolCall` fields).
5. Try `session/load`, a mode switch, an effort knob, `x.ai/billing` → confirm support/`-32601`.
6. Inspect `~/.grok/` for the sessions path + record format.

Each resolved item promotes a `VERIFY` in the skill to a confirmed fact and pins a capability value.

## Part 4 — PR phasing (one PR = one logical change)

1. **PR1 — Skill folder + this plan.** ✅ done. The spec the code follows; mandatory per CLAUDE.md.
2. **PR2 — Provider plumbing.** Type unions, `VALID_PROVIDERS`, `GROK_BASELINE`, `discoverGrok`, AddAgentModal/ProviderLogo/AgentBadge/resumeCommand/modeTone. Compiles; "Grok Build" appears in the picker; the adapter is a stub that throws "not implemented." No behavior change for existing providers.
3. **PR3 — `grok-acp/` transport + client.** Wire contract + `\/` shim + auth handshake; covered by a scripted-handshake smoke test or an injected-client unit test.
4. **PR4 — `GrokAdapter` + `grokParser`.** `runTurn`, `handleNotification`, permission bridge, persistence + replay dedupe. End-to-end: create a Grok session, send a turn, approve a tool, resume.
5. **PR5 — Capability finalization.** Flip the `❓` capabilities (`planMode`, `subagents`, `thinkingEffort`, `hardSandbox`, `costUsd`) to their verified values; wire subagent `emitTaskEvent` and native plan-mode set-mode if confirmed.

Each PR is independently green (CI: lint + build on the 3×3 matrix; required check `ci`). Remember the `schema.sql` copy gotcha and the `.js` extension rule for daemon relative imports.

## Part 5 — Risks & mitigations

| Risk | Mitigation |
|---|---|
| Early-beta CLI churn breaks the wire contract | Version-stamp every observation; re-baseline after each `grok` upgrade ([`known-bugs.md`](../../.claude/skills/grok-build/multitable/known-bugs.md)) |
| `\/` parser bug → silent hangs | Mandatory transport shim ([`pitfalls.md`](../../.claude/skills/grok-build/pitfalls.md) §1); smoke test asserts `session/new` responds |
| Subscription-gated (SuperGrok Heavy ~$300/mo, $99 intro) | Auth-state alert with a clear setup message; degrade gracefully when unauthenticated (typed `auth` alert, no session persisted) |
| Users confuse "Grok Build" with "Hermes (Grok)" | Distinct labels/glyphs/logos; skill cross-links clarify they're separate providers |
| Assuming TUI features (modes/effort/subagents) work over agent-stdio | Everything speculative is `❓`; PR5 only flips what the verification protocol confirms |
| Cost expectations | `costUsd:false` documented; `/cost` shows hidden-USD state by design |
