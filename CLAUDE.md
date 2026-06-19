# CLAUDE.md

Guidance for Claude Code working in this repo. These instructions override default behavior.

## Project

MultiTable is a local, browser-based dashboard for managing AI coding agents and dev processes. A Node.js daemon drives **multiple agent providers** through a unified `ProviderAdapter` contract (no PTY for agent sessions), spawns commands/terminals via `node-pty`, persists state in SQLite, brokers permission + elicitation prompts (with a Telegram bridge for remote approval), and serves a React UI over REST + WebSocket on `localhost:3000`.

Product concept & history: `docs/reference/OVERVIEW.md`, `docs/reference/SPEC.md`, `docs/reference/THREE_PROVIDER_INTEGRATION_PLAN.md`, `docs/reference/archive/SDK_MIGRATION_PLAN.md`, `docs/reference/archive/CODEX_APP_SERVER_MIGRATION.md`. This file is about working in the code.

## Monorepo layout

npm workspaces under `packages/*`:

- `packages/daemon` — the entire backend. Express + `ws` + `node-pty` + `better-sqlite3` + `@anthropic-ai/claude-agent-sdk` + JSON-RPC to `codex app-server` + ACP JSON-RPC to `hermes acp` + `simple-git` + `chokidar`.
- `packages/web` — React + Vite + xterm.js (commands/terminals only) + CodeMirror 6 (composer) + Streamdown + shiki + Zustand + Tailwind. Builds into `packages/daemon/dist/public`.
- `packages/cli` — the `mt` CLI entrypoint (commander): `mt start`, `mt open`.

## Commands

Run from repo root unless noted.

```bash
npm install        # all workspaces
npm run dev        # daemon (tsx watch) + web (vite dev), concurrently
npm run build      # all workspaces
npm run lint       # eslint packages/*/src --ext .ts,.tsx
npm run format     # prettier --write packages/*/src
```

Per-workspace: `npm run dev|build|start -w @multitable/daemon`, `npm run dev|build -w @multitable/web`, `npm run build -w @multitable/cli`.

The daemon listens on `http://127.0.0.1:3000` and `ws://127.0.0.1:3000/ws`. In dev, Vite proxies `/api` and `/ws` to the daemon — **start the daemon before/alongside the web dev server.**

No test framework is configured — don't invent `npm test`.

## Auth

Each provider authenticates independently from the same place its own CLI does:

- **Claude** — `ANTHROPIC_API_KEY` env var, or `~/.claude/auth.json` (`claude login`).
- **Codex** — JSON-RPC over stdio to a long-lived `codex app-server` child (one per daemon, lazy-spawned). Inherits `process.env`, reads `~/.codex/auth.json` (`codex login`). The `@openai/codex-sdk` npm dep was removed — see `agent/providers/codex-app-server/`.
- **Hermes** — ACP JSON-RPC to `hermes acp` children; xAI OAuth under `~/.hermes/` (`hermes login`). See the `hermes-grok` skill.

Missing credentials fail the first turn, surfaced via `session:turn-error`.

## Multi-provider architecture

`AgentSession.provider` is `'claude' | 'codex' | 'hermes'` (`agent/types.ts`). All three are **live, fully-implemented adapters** under `packages/daemon/src/agent/providers/`, registered in `agent/manager.ts` (~line 109) in a `Record<string, ProviderAdapter>`:

- `types.ts` — the `ProviderAdapter` contract (`runTurn`, optional `reset`/`destroy`/`shutdown`), `ProviderCapabilities` (drives conditional UI), and the manager-owned `AdapterCallbacks`.
- `claude.ts` — `ClaudeAdapter`. SDK option assembly, `canUseTool` → `PermissionManager` bridge, `makeHooks`, `StreamBuffer` reducer.
- `codex.ts` + `codex-app-server/` + `codex-protocol/` — `CodexAdapter` over a `codex app-server` JSON-RPC child. `codex-protocol/` is generated (`codex app-server generate-ts`; bump `_codex-cli-version.ts`).
- `hermes.ts` + `hermes-acp/` — `HermesAdapter` over `hermes acp` (one child per project cwd). See the `hermes-grok` skill for the ACP wire contract.
- `index.ts` — re-exports.

`agent/manager.ts` is a thin, provider-agnostic orchestrator: session state machine, DB persistence, WS dispatch, two-phase watchdog (hard-kill at 180s before any SDK byte arrives — for auth/network/CA diagnostics; warn-only every 90s after first byte — never kills live work), capability advertisement. `sendTurn()` looks up the adapter and delegates.

**To add a provider:** drop a `<provider>.ts` adapter, register it in the manager's adapter map, (if it persists to disk) add a `transcripts/<provider>Parser.ts`, advertise `capabilities.usageLimits` and either wire `applyUsageLimits(...)` or document why the provider has no live feed (see `docs/reference/USAGE_LIMITS.md`), **and create the provider's `.claude/skills/<provider>-sdk/` skill folder** (mandatory — see "Provider skill folders" below; a provider integration is not complete without it). No surgery on the manager's turn logic. Deep per-provider semantics live in the `claude-agent-sdk` / `openai-codex-sdk` / `hermes-grok` skills and `docs/reference/THREE_PROVIDER_INTEGRATION_PLAN.md` — consult those before changing an adapter.

### Provider skill folders (required)

**Every agent framework MUST ship its own skill folder under `.claude/skills/<provider>-sdk/`.** This is not optional and not deferrable — landing an adapter without its skill folder is an incomplete integration. The folder is the authoritative, provider-isolated knowledge base future work depends on (it's what makes adding the *next* provider, or fixing this one, correct rather than guesswork).

Mirror the existing folders (`claude-agent-sdk/`, `openai-codex-sdk/`, `hermes-grok/`, the forward-looking `github-copilot-sdk/`) exactly:

- `SKILL.md` — YAML frontmatter (`name`, `description` with concrete trigger terms, `allowed-tools`), then the authoritative reference: a "strictly `<provider>`-only" isolation note (do **not** import other providers' SDK/protocol concepts — see [[feedback_separate_sdks]]), the one fact that shapes everything, and a quick task→file map.
- `pitfalls.md` — the provider-specific traps (wire-shape gotchas, auth edge cases, abort/replay quirks).
- `reference/` — protocol / auth / feature deep-dives (one file per axis). **A `reference/usage-limits.md` is mandatory** — document how this provider's usage/rate-limit data is obtained (in-band event vs out-of-band credential read), its exact wire shape, and the adapter capture path (see `docs/reference/USAGE_LIMITS.md` for the cross-provider feature spec). If the provider has no live feed today, say so and describe the out-of-band path that would surface limits later.
- `multitable/` — how the adapter integrates here (adapter architecture, permission wiring, persistence/parser).

Keep each skill **strictly single-provider** — never blend two providers' SDK or protocol content in one skill or doc. Register the new skill's trigger terms so it auto-loads when its adapter files (`packages/daemon/src/agent/providers/<provider>.ts`, its parser) are touched.

### Modes

`AgentSession.mode` is a bare `string` (`agent/types.ts:45`). **MultiTable does not invent or translate modes** — the value is passed straight through, and each adapter declares its own native set in `capabilities.modes`:

- **Claude** (SDK `PermissionMode`): `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, `auto`.
- **Codex** (`SandboxMode`, OS-enforced): `workspace-write`, `read-only`, `danger-full-access`.
- **Hermes** (advisory only — ACP has no mode RPC): `default`, `plan`, `read-only`.

Claude reuses one thread across mode flips; Codex options are immutable post-thread-start so a flip discards the cached `threadId`. Mode changes broadcast `session:mode-changed`.

### Thinking effort

`ThinkingEffort` is `'low' | 'medium' | 'high' | 'xhigh' | 'max'`; the session field is `ThinkingEffort | null` (null = provider default). `xhigh`/`max` are model-gated — each `DiscoveredModel.effortLevels` declares the supported subset and the UI's `ThinkingEffortBadge` filters its dropdown to it. Claude passes `{ effort }` through SDK options; Codex forwards `effort` to `turn/start` (`max` → undefined); Hermes plumbs it as a `/reasoning <level>` prefix. `GlobalConfig.lastThinkingEffort` seeds new sessions; `PUT /api/sessions/:id/thinking-effort` updates it and emits `session:thinking-effort-changed`.

### Provider-specific notes

- **Codex** — `approvalPolicy` is hardcoded to `'never'`; tool gating is the spawn-time `sandbox` enum, and the client auto-denies approval ServerRequests defensively. Per-chunk additive deltas. No USD cost field. Threads persist as `~/.codex/sessions/.../rollout-*.jsonl`, parsed by `transcripts/codexParser.ts`; listed via `GET /api/transcripts/codex`, resumed via `POST /api/transcripts/codex/:threadId/resume`. Depth: `openai-codex-sdk` skill.
- **Hermes** — additive deltas, sessions persist under `~/.hermes/`, parsed by `transcripts/hermesParser.ts`. Depth: `hermes-grok` skill (gap analysis: `docs/ideas/hermes-grok-gap-analysis.md`).
- **Permission routing** — Claude **and** Hermes route per-call approvals through `PermissionManager`. Codex bypasses it entirely (sandbox-gated). `ElicitationManager` is provider-agnostic.

## Provider catalog

`packages/daemon/src/providers/` (top-level, distinct from `agent/providers/`) is the live model-catalog system feeding the AddAgentModal picker and the effort-tier filter:

- `baselines.ts` — `BaselineModel` shape + shipped seed catalogs (Claude holds the canonical `opus`/`sonnet`/`haiku` triple).
- `discovery.ts` — `discoverClaude` / `discoverCodex` / `discoverHermes` probe each provider for `DiscoveredModel[]`.
- `catalog.ts` — `ProviderCatalog` EventEmitter layering baseline → on-disk cache (`~/.cache/multitable/models.json`) → live discovery; emits `updated`.
- `api/providers.ts` — `VALID_PROVIDERS = ['claude','codex','hermes']`. `GET /:provider/models` and `GET /catalog` serve the in-memory cache (never block); `POST /refresh` triggers async discovery (202, shared in-flight Promise).

**Don't reintroduce per-request CLI calls** in the API handlers — they're cache-served by design. The web store updates off `providers:catalog-updated`.

## Subsystems (orientation — see code/skills for depth)

- **Telegram bridge** (`notifications/telegram*.ts`, `api/integrations.ts`) — forwards permission/ask-question/alert prompts to a chat and accepts callback-button responses, editing the original message in place on resolution. Token: env `MULTITABLE_TELEGRAM_BOT_TOKEN` wins, else `~/.multitable/secrets.yml` (`config/secrets.ts`, mode `0o600`); chat IDs + per-event toggles in `globalConfig.integrations.telegram`. Started after the WS server, stopped on shutdown.
- **Elicitation** (`hooks/elicitationManager.ts`) — MCP `elicitInput` schema/url prompts, **separate** from `canUseTool` permissions. WS: `session:elicitation:prompt|resolved|expired`; inbound `session:elicitation:respond`. UI: `components/elicitation/ElicitationModal.tsx`.
- **Streaming buffers** (`agent/streamBuffer.ts`) — canonical additive-delta reducer. All adapters normalize to additive; the daemon accumulates per-item buffers and forwards cumulative snapshots over `session:assistant-delta` / `:reasoning-delta` / `:tool-delta` / `:tool-progress`. The final assistant message / `item/completed` carries the canonical payload that supersedes the buffer; `session:message-rekeyed` swaps a synthetic id for the persisted one.
- **Alerts** (`agent/alerts.ts`) — `createAlert()` → `SessionAlert` with category + severity (info/success 3s, warning 5s, error 8s, attention persistent). WS `session:alert`; UI `NotificationCenter.tsx` + `lib/notify.ts` / `browserNotifications.ts` / `sound.ts` / `tabBadge.ts` / `notificationPrefs.ts`.
- **Dev log** (`devLog.ts`) — EventEmitter for in-app debugging; `trackedTimeout(label, ms)` logs timer start/fire/cancel. Broadcast as `daemon-log`; UI `DevLogPanel.tsx` (ring buffer, persisted toggle).
- **Usage limits** (`docs/reference/USAGE_LIMITS.md`) — always-present per-session indicator of the active provider/model's usage limits. Adapters normalize to a `UsageLimitSnapshot` via `applyUsageLimits(...)`, gated by `capabilities.usageLimits`; WS `session:usage-limits-changed`; UI `UsageLimitBadge.tsx` in `SessionHeaderBar`. Per-provider data sources live in each `<provider>-sdk/reference/usage-limits.md`.
- **Loaders + secrets** (`loaders.ts`, `config/secrets.ts`) — 60-variant dot-matrix loader registry; `pickLoaderVariant` assigns server-side so a project keeps its avatar across reloads. Secrets: atomic YAML store at `~/.multitable/secrets.yml`.

## Build gotcha: schema.sql

`tsc` does not copy non-TS assets. The daemon `build` script runs `cp src/db/schema.sql dist/db/schema.sql`; if you invoke `tsc` directly you must copy it too, or the daemon crashes on DB init.

## Architecture

### Daemon (`packages/daemon/src`)

Startup sequence in `index.ts` is **load-bearing — read it before changing boot order**:

1. Load global config (`config/loader.ts`, `~/.config/multitable/config.yml` via `env-paths`).
2. Check `pids.json` for orphans (`pids.ts`).
3. Init SQLite (`db/store.ts`, schema from `db/schema.sql`).
4. Create `PtyManager`, `PermissionManager`, `ElicitationManager`, `AgentSessionManager` (registers Claude + Codex + Hermes adapters).
5. Init `TelegramBridge`.
6. Create `FileWatcher` + `GitWatcher`.
7. Build Express + WS server (`server.ts`); wire the broadcast hook; start the bridge.
8. Load DB sessions, `agentManager.register(...)` each (no PTY spawn); attach git watchers; autostart commands.
9. Listen on `host:port`.
10. SIGTERM/SIGINT: `agentManager.shutdown()` (each adapter's `shutdown()` exits its child cleanly), `TelegramBridge.stop()`.

Key modules (one line each — see code for detail):

- `agent/manager.ts` — provider-agnostic orchestrator; in-memory `Map<sessionId, AgentSession>` + adapter registry; emits provider-agnostic events rebroadcast by `server.ts`.
- `agent/providers/*` — the three adapters (see Multi-provider architecture).
- `agent/sdkAdapter.ts` — SDK message shapes → MultiTable's `Message` union (same shape `transcripts/parser.ts` produces).
- `agent/streamBuffer.ts`, `agent/alerts.ts`, `agent/types.ts` — see Subsystems / types.
- `pty/manager.ts` + `ringBuffer.ts` + `stream.ts` — **commands and terminals only**; sessions never go through PTY. `stream.ts` is the WS message router (`handleWsMessage`).
- `db/store.ts` — synchronous better-sqlite3; exported functions are the DB API (routers call them directly).
- `api/*.ts` — one router per resource. `sessions`/`processes` receive both `manager` (PtyManager) and `agentManager`. `api/attachments.ts` is a mounted helper (20 MB cap, mime allowlist) used by sessions + terminals.
- `hooks/permissionManager.ts` — pending permission prompts; `requestFromSdk(...)` is awaited by Claude/Hermes per-call approval. Dedup, allowlist, auto-defer, 110s timeout. The HTTP `/api/hooks/*` receiver is gone.
- `hooks/elicitationManager.ts` — see Subsystems. `hooks/{costParser,labeler,optionDetector,promptsParser}.ts` read `~/.claude/projects/<cwd>/<sessionId>.jsonl` for `/cost`, `/prompts`, labels, option detection.
- `transcripts/{parser,codexParser,hermesParser}.ts` — JSONL/rollout → `Message[]` per provider; used by `/api/sessions/:id/messages`, the past-agents browser, adapter reconciliation.
- `watcher/index.ts` — chokidar watcher for `mt.yml` + per-command `fileWatchPatterns` restarts (commands only).
- `git/index.ts` + `git/watcher.ts` — `simple-git` read/write helpers for `/api/projects/:id/git/*` (incl. `getDiffSinceCommit` scoped by `sessions.git_baseline_commit`); `GitWatcher` debounces (500ms) working-tree changes → `git:status-changed`.
- `tracker/`, `conflict/`, `types.ts` — cost tracking, process-conflict detection, shared types (`GlobalConfig.integrations.telegram`, `PermissionPrompt` with optional `title`/`displayName`/`subtitle`/`blockedPath`).

Narrative architecture: `docs/reference/SPEC.md` §24–27.

### API routing quirk

Creation endpoints `POST /api/projects/:id/{sessions,commands,terminals}` live on the **projects router**, not the resource routers. Per-resource routers handle `PUT`/`DELETE`/lifecycle on an existing id. Add new creation routes to the projects router.

Routers mounted in `server.ts`: `/api/projects`, `/api/sessions`, `/api/commands`, `/api/terminals`, `/api/processes`, `/api/config`, `/api/search`, `/api/notes`, `/api/transcripts` (Claude JSONL + Codex/Hermes), `/api/integrations`, `/api/projects/:projectId/git`, `/api/providers`, `/api/_internal/agent/turn`.

### Session vs Command vs Terminal

- **Session** — AI agent, owned by `AgentSessionManager`, no PTY. Sending a message auto-starts/resumes the turn — there is **no separate Start/Resume action**; only `/stop` (`abortTurn`) and `/reset` (clears conversation for `/clear`).
- **Command** — long-running dev process, PTY child, has autorestart + file-watch-restart.
- **Terminal** — ad-hoc shell, PTY child.

State field: commands/terminals → `running`/`idle`/`stopped`/`errored`. Sessions → `stopped` (resting) / `running` (turn in flight) / `errored`, plus a `mode`. Autorestart fields are commands-only (kept on the schema for back-compat).

### DB schema highlights

`db/schema.sql`: `projects`, `sessions`, `claude_session_loaders`, `session_events`, `commands`, `terminals`, `cost_records`, `notes`. Notable `sessions` columns: `agent_provider`, `model` (nullable), `agent_session_id` + `_history` (provider-agnostic id), `claude_session_id` + `_history` (Claude `--resume` JSONL name), `mode`, `thinking_effort`, `scratchpad`, `tags` (JSON), `loader_variant`, `git_baseline_commit`. `claude_session_loaders` maps a Claude session id → loader variant for stable avatars across re-imports; `session_events` is a generic per-session event log.

### WebSocket

Single endpoint `/ws`; JSON `{ type, processId?, payload }`. One client subscribes to at most one process (`WsClientState.subscribedProcess`). 30s ping/pong heartbeat. **Single-delivery rule:** `pty-output` is sent directly to the subscribed client in `pty/stream.ts`'s `handleSubscribe` — do **not** also broadcast it from `server.ts` (load-bearing comment marks the double-delivery bug this caused).

**Inbound:** `subscribe`/`unsubscribe`, `session:send`, `pty-input`/`pty-resize` (commands/terminals only), `permission:respond`, `permission:answer-question`, `session:elicitation:respond`, `option:dismiss`.

**Outbound:** `process-state-changed`/`-metrics`/`-exited`, `daemon-log`, the `session:*` family (`assistant-message`/`-delta`, `reasoning-delta`, `tool-event`/`-delta`/`-progress`, `user-message`, `turn-result`/`-error`/`-complete`, `idle`, `state-updated`, `mode-changed`, `thinking-effort-changed`, `reconciled`, `message-rekeyed`, `notification`, `alert`, `status`, `task-event`, `options-detected`, `created`/`updated`/`deleted`/`ended`), `permission:prompt|resolved|expired`, `session:elicitation:prompt|resolved|expired`, `git:status-changed`, `providers:catalog-updated`, `pty-output`/`scrollback`. Full payload catalog: `docs/reference/SPEC.md` §26.

### Slash commands

The composer's `/`-autocomplete merges: (1) project `<project>/.claude/commands/*.md` (ranked highest, via `GET /api/projects/:id/slash-commands`), (2) user `~/.claude/commands/*.md`, (3) MultiTable-native built-ins intercepted client-side in `ChatInputCM`'s `handleNativeSlash` — currently only `/clear` (`POST /api/sessions/:id/reset`, nulls `claudeSessionId`, clears messages) and `/cost` (inline system message). Custom commands flow through `wsClient.sendTurn` → the SDK substitutes `$ARGUMENTS`. TUI built-ins (`/model`, `/compact`, `/init`) are deliberately not surfaced — to add one, intercept in `handleNativeSlash` and add it to `BUILTIN_SLASH_COMMANDS` in `cm-completions.ts`.

### Web (`packages/web/src`)

The UI says "agent" wherever code says "session"/`AgentSession` — that's the on-disk/on-the-wire shape; **don't rename the types.**

- `main.tsx` → `App.tsx` — single root; wires WS → Zustand, re-fetches on `ws:reconnected`, uses `useAppStore.getState()` in WS handlers (not stale closures).
- `stores/appStore.ts` — the single store: projects/processes/permissions/options/themes/modals/selection/`messagesBySession` plus `alerts`+`unreadBySession`+`notificationCenterOpen`, `pendingElicitations`, `gitByProject`, `tasksBySession`, `toolProgressBySession`, `statusBySession`, `streamingBySession`, `modelCatalog`+`modelCatalogStatus`, `attentionBySession`+`attentionFilters` (FIFO-trimmed 500/session), `devLogOpen`. `detailPanelTab` is `'files' | 'tasks' | 'cost' | 'prompt-builder'`.
- `lib/` — `ws.ts`/`api.ts` (talk to these, not raw fetch; `wsClient.sendTurn` is the only way to send a session message), `cm-completions.ts` (`@` mentions + `/` commands), `cm-theme.ts`, `shiki.ts`, plus `notify`/`browserNotifications`/`sound`/`tabBadge`/`notificationPrefs`/`devLog`/`markdown`/`pastAgents`/`processState`/`rafBatch`/`nodeColor`/`relativeTime`/`attention`/`composerDrafts`/`clipboard`/`modelName`/`projectColor`/`terminalManager`/`useIsMobile`.
- `components/main-pane/` — `MainPane` branches on `process.type === 'session'` → `chat/` (`SessionChat`, `MessageList`, `AssistantMessage`, `UserMessage`, `ToolCallCard`, `ReasoningCard`, `CodeBlock`, `ChatInputCM`, `ExpandedComposer`, `ModelChip`, `LoaderNode`, …) else `TerminalView` (xterm). Also `git/` (`GitPanel`, `GitFileList`, `GitDiffPane`, …), `context/` (`AttentionStream`, `ProviderCapabilityStrip`), `SessionDetailPanel`, `SessionHeaderBar`, `ModeBadge`, `ThinkingEffortBadge`, `AttachButton`. `MainPane` also routes a `selectedFileViewerProjectId` surface (`file-viewer/` — `FileViewerMainView` + lazy `FileTree` + CM6 `FileEditor`; reads/writes `GET|POST /api/projects/:id/file-content`, and `/files` takes `?all=1` to expose dotfolders), mutually exclusive with process/git/overview selection — any one setter clears the others.
- `components/` — `sidebar/` (`Sidebar`, `PastAgentsList`, `SidebarFileViewerSection`, …), `modals/` (`AddAgentModal` — live: Claude Code / Codex / Hermes (Grok); `comingSoon`: Gemini CLI, GitHub Copilot, opencode, Amp, Aider, Goose, Pi — plus `AddProjectModal`, `GlobalSettingsModal`, `IntegrationsSection`, `NotificationsSection`, `PastAgentsBrowser`), `elicitation/`, `notifications/`, `dev-log/`, `permission/`, `command-palette/`, `context-menu/`, `ui/` (primitives + 60 dotmatrix variants), `ConnectionOverlay.tsx`.
- Styling: Tailwind is set up but most components use inline `style={{ }}` with `var(--...)` CSS-variable tokens (theme system in `hooks/useTheme.ts` + `lib/themes.ts`). Match the file you're editing.

## TypeScript / module system

- Root `tsconfig.json` is `module: Node16` / `moduleResolution: Node16` — **relative imports in the daemon must include the `.js` extension** (e.g. `import { initDb } from './db/store.js'`). Web uses Vite bundler resolution (no suffix).
- Strict mode on. `@typescript-eslint/no-explicit-any` is a warning — prefer real types.

## Prettier / ESLint

Prettier: single quotes, trailing commas, semicolons, 100-char width, 2-space tabs. ESLint extends `eslint:recommended` + `@typescript-eslint/recommended`. Unused vars prefixed `_` are allowed.

## How to push to master

Master is protected — **direct pushes are blocked, including for the owner** (`enforce_admins: true`). Every change goes through a PR. CI runs lint + build on a 3×3 matrix; the rollup job named **`ci`** is the only required status check.

```bash
git checkout master && git pull
git checkout -b <type>/<short-description>     # feat|fix|chore|docs|refactor
git add <files> && git commit -m "..."
git push -u origin HEAD
gh pr create --fill
gh pr merge --squash --delete-branch           # after CI green
```

- **Always squash-merge** (PR title → commit subject, body → commit body).
- Batching unrelated changes in one PR is fine — the user prefers velocity over strict per-PR atomicity.
- After merge: delete the local branch + `git fetch --prune`.
- **Releases:** bump versions in all four `package.json`, update the README badge, tag `vX.Y.Z` on master post-merge, `gh release create vX.Y.Z --target master --generate-notes`.
- **Don't rename the `ci` job** without updating the branch-protection `required_status_checks` via `gh api` — the rule references it by name; a silent rename turns the gate off.
- Emergency override (true emergencies only): toggle `repos/erickalfaro/multitable/branches/master/protection/enforce_admins` off, push, back on.

## Recently retired (don't reintroduce)

- `hooks/installer.ts` / `hooks/receiver.ts` + `/api/hooks/*` — replaced by SDK `options.hooks` in `ClaudeAdapter:makeHooks`.
- `transcripts/tail.ts` / `TranscriptTailerRegistry` — replaced by adapter-driven event streams.
- `claude --resume` PTY spawn, the `'No conversation found'` / `/$bunfs/` zombie guards, `resume-failed` — sessions have no child process.
- `/api/sessions/:id/{start,restart,spawn-claude,resume-claude}` — sessions auto-start; only `/stop` + `/reset` remain.
- `hook:*` WS events — replaced by specific `session:*` events.
- xterm `TerminalView` for sessions — commands/terminals only now.
- `@openai/codex-sdk` npm dep — replaced by direct JSON-RPC to `codex app-server`.
- Claude logic inline in `manager.ts` — extracted to `agent/providers/claude.ts`; keep the manager provider-agnostic.
- `components/sidebar/PastSessions.tsx` — replaced by `PastAgentsList` + `PastAgentsBrowser`.
