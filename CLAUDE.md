# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MultiTable is a local, browser-based dashboard for managing AI coding agents and dev processes. A Node.js daemon drives **multiple agent providers** (Claude Code via `@anthropic-ai/claude-agent-sdk`, Codex via JSON-RPC against `codex app-server`) through a unified `ProviderAdapter` contract — no PTY for agent sessions. It spawns commands and terminals via `node-pty`, persists state in SQLite, brokers permission + elicitation prompts (including a Telegram bridge for remote approval), and serves a React UI over REST + WebSocket on `localhost:3000`. See `docs/OVERVIEW.md`, `docs/SPEC.md`, `docs/SDK_MIGRATION_PLAN.md`, `docs/CODEX_APP_SERVER_MIGRATION.md`, and `docs/THREE_PROVIDER_INTEGRATION_PLAN.md` for the product concept and migration history; this file is about working in the code.

## Monorepo layout

npm workspaces under `packages/*`:

- `packages/daemon` — Node.js + Express + `ws` + `node-pty` + `better-sqlite3` + `@anthropic-ai/claude-agent-sdk` + line-delimited JSON-RPC to `codex app-server` + `simple-git` + `chokidar`. The entire backend.
- `packages/web` — React + Vite + xterm.js (commands/terminals only) + CodeMirror 6 (composer) + Streamdown + shiki + Zustand + TailwindCSS. Builds into `packages/daemon/dist/public` so the daemon serves the SPA.
- `packages/cli` — the `mt` CLI entrypoint (commander).

## Commands

Run from the repo root unless noted.

```bash
npm install                      # installs all workspaces
npm run dev                      # concurrently runs daemon (tsx watch) + web (vite dev)
npm run build                    # builds all workspaces
npm run lint                     # eslint packages/*/src --ext .ts,.tsx
npm run format                   # prettier --write packages/*/src
```

Per-workspace:

```bash
# daemon
npm run dev   -w @multitable/daemon    # tsx watch src/index.ts
npm run build -w @multitable/daemon    # tsc + copies src/db/schema.sql → dist/db/schema.sql
npm run start -w @multitable/daemon    # node dist/index.js

# web
npm run dev   -w @multitable/web       # Vite dev server, proxies /api and /ws to :3000
npm run build -w @multitable/web       # tsc + vite build → packages/daemon/dist/public

# cli
npm run build -w @multitable/cli
```

The daemon listens on `http://127.0.0.1:3000` and exposes `ws://127.0.0.1:3000/ws`. In dev, Vite proxies both to the daemon — start the daemon before (or alongside) the web dev server.

No test framework is configured yet — do not invent `npm test` incantations.

## Auth

Two SDKs are wired today and authenticate independently.

**Claude Code SDK** reads from the same place the `claude` CLI does:
- `ANTHROPIC_API_KEY` env var (preferred for daemons), or
- `~/.claude/auth.json` (populated by `claude login`).

**Codex** speaks JSON-RPC over stdio against a long-lived `codex app-server` child process (one per daemon, lazy-spawned on first Codex use). The child inherits `process.env` and reads the codex CLI's own auth (`~/.codex/auth.json`, populated by `codex login`). The `@openai/codex-sdk` dependency was removed — see `agent/providers/codex-app-server/` for the transport + client and `agent/providers/codex-protocol/` for the generated TS bindings (regenerate via `codex app-server generate-ts`; pinned codex-cli version lives in `_codex-cli-version.ts`).

If credentials are missing, the first turn fails. Surface via the `session:turn-error` toast.

## Multi-provider architecture

`AgentSession.provider` is `'claude' | 'codex'` today (`'copilot'` is reserved in the type union, scaffolding only). **Both** active providers live as adapters under `packages/daemon/src/agent/providers/`:

- `types.ts` — `ProviderAdapter` contract (`runTurn(s, text, ctrl, callbacks)`, optional `reset(s)` / `destroy(s)` / `shutdown()`) plus `ProviderCapabilities` (`costUsd`, plan-mode flavor, `perCallApproval` type, `elicitation`, `subagents`, `modelSwitchScope`, `userQuestion`, etc.). The UI conditionally renders buttons against `capabilities`. `AdapterCallbacks` are the manager-owned hooks an adapter calls into.
- `claude.ts` — `ClaudeAdapter`. Owns SDK option assembly, `mode → permissionMode` translation, the `canUseTool` bridge into `PermissionManager`, the hook routing (`makeHooks`), and the `StreamBuffer` reducer for assistant/tool/reasoning deltas. **No longer inline in `manager.ts`.**
- `codex.ts` — `CodexAdapter`. Drives `codex app-server` via JSON-RPC. Owns a per-session `{threadId, mode}` cache that the `setMode` flow blows away on mode flip (Codex options are immutable post-thread-start). Forwards additive deltas and reconciles against the on-disk rollout.
- `codex-app-server/` — `CodexAppServerTransport` (line-delimited JSON-RPC over child stdio) + `CodexAppServerClient` (singleton with per-thread notification fan-out, auto-deny ServerRequest handlers, lazy spawn, crash-respawn watchdog).
- `codex-protocol/` — generated TS bindings for the `codex app-server` protocol. Regenerate via `codex app-server generate-ts --out packages/daemon/src/agent/providers/codex-protocol/` and bump `_codex-cli-version.ts`.
- `index.ts` — re-exports.

`agent/manager.ts` is now a thin, provider-agnostic orchestrator: session state machine, DB persistence, WS dispatch, watchdog (5-min no-progress), and capability advertisement to the UI. Adapters are registered at construction in a `Record<string, ProviderAdapter>` keyed by provider id; `sendTurn` looks up the adapter and delegates.

To add a new provider: drop a `<provider>.ts` adapter under `agent/providers/`, register it in the manager's adapter map, and (if the adapter has on-disk persistence) add a parser under `transcripts/`. No surgery on the manager's turn logic is needed.

### Modes

`AgentSession.mode` is `'default' | 'plan' | 'accept-edits' | 'auto' | 'chat' | 'read-only'`. Each adapter translates differently:

- `ClaudeAdapter` maps mode → SDK `permissionMode` and reuses the same thread.
- `CodexAdapter` cannot change options on a live thread, so a mode flip discards the cached `threadId` and starts a fresh thread on the next turn (the cache is keyed by `{threadId, mode}` precisely for this).

Mode changes surface as `session:mode-changed` over WS so the UI's `ModeBadge` updates instantly.

### Codex specifics

- **Approval policy is hardcoded to `'never'`** on every `thread/start` and `thread/resume` request. Tool gating happens via the spawn-time `sandbox` enum (`read-only` / `workspace-write` / `danger-full-access`). The client also auto-denies any approval ServerRequests defensively. `PermissionManager` stays Claude-only by design.
- **Streaming response previews.** Codex emits per-chunk `item/agentMessage/delta` notifications (`streamingDeltaSemantics: 'additive'`); the adapter accumulates per-item buffers and forwards cumulative text over `session:assistant-delta`. `item/completed` carries the canonical final message. `item/reasoning/textDelta` and `item/commandExecution/outputDelta` follow the same pattern for reasoning + tool output.
- **No USD cost field on `Usage`.** Token counts populate; the dollar row is hidden in the cost UI for Codex sessions.
- **Thread persistence** is owned by the codex CLI under `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<thread_id>.jsonl`. `transcripts/codexParser.ts` reads these into the same `Message[]` shape the Claude JSONL parser produces. `AgentSessionManager.register` hydrates `s.messages` from disk on startup; `/api/sessions/:id/messages` re-hydrates if the in-memory cache is empty.
- **Past Codex threads** are listed via `GET /api/transcripts/codex` and resumed via `POST /api/transcripts/codex/:threadId/resume`. The AddAgentModal renders them as a separate section under "Or resume a Codex thread".

## Telegram bridge

The daemon can forward permission prompts, ask-questions, and session alerts to a Telegram chat and accept callback-button responses back over the same channel:

- `notifications/telegramBridge.ts` — listens to `PermissionManager` and `AgentSessionManager` events, formats messages, sends via Bot API, handles `callback_query` (Allow / Deny / Always Allow / answer-question selection), and maintains per-prompt state (message refs, HTML bodies) so resolutions edit the original message in place.
- `notifications/telegramApi.ts` — thin Bot API wrapper (`sendMessage`, `editMessageText`, `answerCallbackQuery`, long-poll `getUpdates`).
- `notifications/telegramFormat.ts` — HTML formatters + inline keyboard builders + footer append on resolution.
- `api/integrations.ts` — `GET /api/integrations/telegram` (view settings) and `PUT /api/integrations/telegram` (set token / chat IDs / per-event flags).
- Token resolution: env var `MULTITABLE_TELEGRAM_BOT_TOKEN` wins; otherwise read from `config/secrets.ts` (`~/.multitable/secrets.yml`, mode `0o600`, atomic temp+rename writes). Chat IDs and per-event toggles live in `globalConfig.integrations.telegram`.
- The bridge is started after the WS server in `index.ts` (so broadcast hooks are wired) and stopped during graceful shutdown.

## Elicitation (distinct from permissions)

MCP-style schema-driven form/URL prompts go through a *separate* flow from `canUseTool` permission prompts:

- `hooks/elicitationManager.ts` — EventEmitter holding open MCP elicitation requests. Each is an independent `Pending` (no dedup). Emits `elicitation:prompt` on the SDK's `elicitInput` callback; returns a Promise that resolves on UI response, AbortSignal, or timeout (auto-decline). Tracks `serverName`, `message`, `mode` (form vs url), `requestedSchema`, `title`, `displayName`, `description`.
- WS events: `session:elicitation:prompt`, `session:elicitation:resolved`, `session:elicitation:expired`.
- Inbound from UI: `session:elicitation:respond` `{ id, action: 'accept' | 'decline' | 'cancel', content? }`.
- UI: `components/elicitation/ElicitationModal.tsx` renders a schema-driven JSON form (type-aware inputs, enum dropdowns, defaults).

`PermissionManager` stays Claude-only by design; `ElicitationManager` is provider-agnostic and surfaces for whichever adapter wires it.

## Streaming buffers

`agent/streamBuffer.ts` is the canonical reducer for additive deltas. Three delta streams flow over WS while a turn is in flight:

- `session:assistant-delta` — text chunks.
- `session:reasoning-delta` — chain-of-thought (Codex always; Claude when surfaced).
- `session:tool-delta` — tool input/output mid-execution.
- `session:tool-progress` — numeric/percent progress when the tool emits it.

Both adapters normalize to **additive** semantics; the daemon accumulates per-item buffers and forwards cumulative text so the UI always renders the latest snapshot per item. `item/completed` (Codex) and the SDK's final assistant message (Claude) carry the canonical payload that supersedes the running buffer; `session:message-rekeyed` notifies the UI when an in-flight synthetic id is replaced by the real persisted id.

## Alerts + notifications

`agent/alerts.ts` is the factory for in-app alerts. `createAlert()` produces a `SessionAlert` with category + severity. Severity defaults: `info`=3s, `success`=3s, `warning`=5s, `error`=8s, `attention`=persistent. Categories: `turn`, `tool`, `permission`, `elicitation`, `rate-limit`, `auth`, `task`, `compaction`, `sync`, `budget`, `status`.

Wire-up:

- WS event: `session:alert`.
- UI: `components/notifications/NotificationCenter.tsx` — alert history with severity icons, dismiss/clear, unread badges per session.
- Browser side: `lib/notify.ts` (toasts + audio), `browserNotifications.ts` (OS notifications), `sound.ts`, `tabBadge.ts`, `notificationPrefs.ts` (per-category + per-severity prefs, persisted).

## Dev log

`devLog.ts` (top-level in `packages/daemon/src/`) is an EventEmitter for in-app debugging. `trackedTimeout(label, ms, opts)` logs `start` / `fire` / `cancel` of timers; categories include `timer`, `permission`, `elicitation`, `watchdog`, `codex`, `agent`, `info`, `warn`, `error`. Entries broadcast as the `daemon-log` WS message.

UI: `components/dev-log/DevLogPanel.tsx` — in-memory ring buffer panel with pause/play, live search, and `useSyncExternalStore` subscription. Toggle state persists to localStorage (`devLogOpen`).

## Loaders + secrets

- `loaders.ts` — canonical 60-variant dot-matrix loader registry (`square` / `circular` / `triangle`, 1–20 each). `pickLoaderVariant(usedVariants)` round-robins to avoid collisions across active projects/sessions. Variant assignment is server-side so the same project always gets the same loader across reloads.
- `config/secrets.ts` — YAML secrets store at `~/.multitable/secrets.yml` (mode `0o600`). Atomic write via temp file + `rename`. Helpers: `getTelegramToken`, `setTelegramToken`, `hasTelegramToken`, `isTelegramTokenFromEnv`. Env var `MULTITABLE_TELEGRAM_BOT_TOKEN` always wins over the file.

## Build gotcha: schema.sql

`tsc` does not copy non-TS assets. The daemon's `build` script already runs `cp src/db/schema.sql dist/db/schema.sql`, but if you ever invoke `tsc` directly (e.g. `npx tsc` inside `packages/daemon`), you must also copy the schema or the daemon will crash on startup when it tries to init the DB.

## Architecture

### Daemon (`packages/daemon/src`)

Startup sequence lives in `index.ts` and is load-bearing — read it before changing boot order:

1. Load global config (`config/loader.ts`, reads `~/.config/multitable/config.yml` via `env-paths`).
2. Check `pids.json` for orphaned processes from prior runs (`pids.ts`).
3. Init SQLite (`db/store.ts` — schema from `db/schema.sql`).
4. Create `PtyManager`, `PermissionManager`, `ElicitationManager`, and `AgentSessionManager` (the agent manager registers `ClaudeAdapter` + `CodexAdapter` at construction).
5. Init `TelegramBridge` (token from env or `secrets.yml`; chat IDs + per-event toggles from `globalConfig.integrations.telegram`).
6. Create `FileWatcher` (`mt.yml` + command file-watch) and `GitWatcher` (per-project working-tree debounced).
7. Build Express + WS server (`server.ts`); wire the broadcast hook used by `TelegramBridge` and start the bridge.
8. Load DB sessions and `agentManager.register(...)` each one (no PTY spawn). For each project: attach `GitWatcher`. Autostart commands; attach file watchers for commands.
9. Listen on `host:port`.
10. Graceful shutdown on SIGTERM/SIGINT: `agentManager.shutdown()` calls each adapter's `shutdown()` so the `codex app-server` child exits cleanly; `TelegramBridge.stop()` ends long-poll.

Key modules:

- **`agent/manager.ts` — `AgentSessionManager`**. Provider-agnostic orchestrator. Holds an in-memory `Map<sessionId, AgentSession>` (state, provider, mode, agentSessionId, claudeSessionId, cost/token totals, in-flight turn) and a `Record<string, ProviderAdapter>` adapter registry. `sendTurn()` looks up the adapter and delegates. Maintains a 5-minute no-progress watchdog so silent SDK hangs surface as `turn-error`. Emits provider-agnostic events (`state-changed`, `session-updated`, `assistant-message`, `assistant-delta`, `tool-event`, `tool-delta`, `tool-progress`, `reasoning-delta`, `user-message`, `turn-result`, `turn-error`, `turn-complete`, `idle`, `mode-changed`, `reconciled`, `message-rekeyed`, `state-snapshot`, `options-detected`, `notification`, `session-ended`, `alert`, `status`, `task-event`) — all consumed by `server.ts` and rebroadcast over WS.
- **`agent/providers/claude.ts`, `agent/providers/codex.ts`** — see [Multi-provider architecture](#multi-provider-architecture) above.
- **`agent/sdkAdapter.ts`** — pure converters from SDK message shapes to MultiTable's `Message` union (the same shape `transcripts/parser.ts` produces from the on-disk JSONL, so the frontend treats both identically).
- **`agent/streamBuffer.ts`** — additive delta reducer shared by both adapters (see [Streaming buffers](#streaming-buffers)).
- **`agent/alerts.ts`** — `createAlert()` factory (see [Alerts + notifications](#alerts--notifications)).
- **`agent/types.ts`** — `AgentSession`, `AgentMessageOut`, `SendTurnInput`, `ProviderCapabilities`, `SessionAlert`.
- **`pty/manager.ts`** — `PtyManager`, the source of truth for **commands and terminals only** (sessions never go through it). Spawn / restart / metrics / ring-buffer scrollback. Emits `state-changed`, `metrics`, `exit`. The `--resume` / zombie / crash-detection branches are gone — that was the PTY-era session path.
- **`pty/ringBuffer.ts`** — per-process scrollback buffer replayed to new WS subscribers (commands and terminals).
- **`pty/stream.ts`** — the WS message router (`handleWsMessage`). Routes `subscribe`/`unsubscribe`/`pty-input`/`pty-resize` for commands and terminals; routes `session:send` to `agentManager.sendTurn`; routes `permission:respond`, `permission:answer-question`, `session:elicitation:respond`, and `option:dismiss`. For session subscribes, it auto-registers the session from the DB if missing and emits `process-state-changed`; sessions never trigger PTY spawn.
- **`db/store.ts`** — better-sqlite3, synchronous. Exported functions are the DB API; routers call them directly rather than going through a service layer.
- **`api/*.ts`** — one router per resource (`projects`, `sessions`, `commands`, `terminals`, `processes`, `config`, `search`, `transcripts`, `notes`, `integrations`, `git`, `providers`). Each is a factory; `sessions` and `processes` receive both `manager` (PtyManager) and `agentManager`. Sessions auto-register from the DB on `_internal/agent/turn` and on `session:send` so newly-created or post-boot rows always work.
- **`hooks/permissionManager.ts`** — holds pending permission prompts until the UI (or Telegram, or auto-allow) resolves them. Exposes `requestFromSdk(sessionId, ..., signal, extras)` that Claude's `canUseTool` callback awaits. Reuses the existing dedup, allowlist (`always-allow`), auto-defer, and 110s timeout. The HTTP `/api/hooks/*` receiver is **gone** — Phase 6 retired it.
- **`hooks/elicitationManager.ts`** — separate from permissions; handles MCP `elicitInput` schema/url prompts (see [Elicitation](#elicitation-distinct-from-permissions)).
- **`hooks/costParser.ts`, `labeler.ts`, `optionDetector.ts`, `promptsParser.ts`** — JSONL-driven utilities still used by the `/cost`, `/prompts`, label generation, and option detection paths. They read the same `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` files the SDK writes.
- **`transcripts/parser.ts`, `transcripts/codexParser.ts`** — JSONL / rollout → `Message[]` parsers for Claude and Codex respectively. Used by `/api/sessions/:id/messages`, the past-agents browser, and adapter reconciliation.
- **`notifications/*`** — Telegram bridge (see [Telegram bridge](#telegram-bridge)).
- **`watcher/index.ts`** — chokidar-based file watcher for `mt.yml` changes and per-command `fileWatchPatterns` restart triggers (commands only; sessions don't have a "restart on file change" concept).
- **`git/index.ts`** — `simple-git`–backed read + write helpers used by `/api/projects/:id/git/*` (status, diff, log, branches, stage, unstage, commit, discard, branch create/switch/delete, stash/stash-pop, fetch/pull/push). Plus `getDiffSinceCommit` for the per-agent diff scope (uses `sessions.git_baseline_commit` captured on session create).
- **`git/watcher.ts`** — `GitWatcher` class. One chokidar watcher per project's working tree (ignores `node_modules`, build/cache dirs, and most `.git/` subdirs but watches `.git/HEAD` + `.git/index` for branch/commit changes); on debounced (500ms) fs change recomputes `getStatusSummary` and broadcasts `git:status-changed` so the GitPanel updates live as agents write files.
- **`devLog.ts`, `loaders.ts`, `config/secrets.ts`** — see [Dev log](#dev-log) and [Loaders + secrets](#loaders--secrets).
- **`tracker/`, `conflict/`** — cost tracking and process-conflict detection.
- **`types.ts`** — shared types (`ManagedProcess`, `ProcessState`, `WsMessage`, `PermissionPrompt`, `Project`, `GlobalConfig` (with `integrations.telegram`), `ProjectConfig`, `SpawnConfig`). The `PermissionPrompt` carries optional `title`/`displayName`/`subtitle`/`blockedPath` fields surfaced from the SDK's `canUseTool` options bag.

### API routing quirk

Creation endpoints `POST /api/projects/:id/{sessions,commands,terminals}` live on the **projects router**, not the resource routers. The projects router calls DB store functions directly. The per-resource routers (`/api/sessions`, `/api/commands`, `/api/terminals`) handle mutations on an existing id (`PUT`, `DELETE`, lifecycle actions). If you're adding a creation route, put it on the projects router to stay consistent.

Routers mounted in `server.ts`:

- `/api/projects` — CRUD + creation endpoints for sessions/commands/terminals + per-project slash-commands discovery.
- `/api/sessions` — mutations on existing sessions; `GET` enrichment merges `state`, `mode`, and `capabilities` from the agent manager.
- `/api/commands`, `/api/terminals`, `/api/processes` — mutations + lifecycle on existing rows.
- `/api/config`, `/api/search`, `/api/notes`.
- `/api/transcripts` — Claude JSONL + Codex rollout browsing; `GET /api/transcripts/codex` lists past Codex threads, `POST /api/transcripts/codex/:threadId/resume` re-attaches one.
- `/api/integrations` — Telegram config (token, chat IDs, per-event toggles).
- `/api/projects/:projectId/git` — full git workflow (status, diff, file diff, log, branches, stage/unstage, commit, discard, branch create/switch/delete, stash, fetch, pull, push). Short-circuits 400 if the project isn't a git repo.
- `/api/providers` — `GET /api/providers/models` discovers live model catalogs (Codex via `codex debug models`; Anthropic via `/v1/models` if `ANTHROPIC_API_KEY` is set; fallback to canonical aliases on timeout or failure).
- `/api/_internal/agent/turn` — internal turn dispatch used by tooling/CLI.

### Session vs Command vs Terminal

Three process types, modeled separately and managed by **different** owners:

- **Session** — AI agent. Owned by `AgentSessionManager`. No PTY child. Conversation history persists at `~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl` (the same file the `claude` CLI uses — full interop). Sending a message auto-starts the SDK turn; if a `claudeSessionId` is on file the SDK resumes, otherwise it creates a fresh conversation. There is **no separate "Resume" or "Start" action**.
- **Command** — long-running dev process (dev server, worker). PTY child. Has autorestart + file-watch-restart.
- **Terminal** — ad-hoc shell. PTY child.

Process state machine (the `state` field):

- For commands/terminals: `running` (PTY alive) / `idle` / `stopped` (no PTY) / `errored` (auto-restart exhausted).
- For sessions: `stopped` (resting; ready for next turn) / `running` (turn in flight) / `errored` (last turn threw, see `session:turn-error`). There's no `idle` distinction for sessions — they sit at `stopped` until you send something. Sessions also carry a `mode` (`default` / `plan` / `accept-edits` / `auto` / `chat` / `read-only`) — see [Modes](#modes).

Auto-restart respects `autorestartMax`, `autorestartDelayMs`, and resets count after `autorestartWindowSecs`. Sessions ignore all autorestart fields — those columns are kept in the DB schema for backward compatibility but are commands-only in practice.

### DB schema highlights

`db/schema.sql` defines `projects`, `sessions`, `claude_session_loaders`, `session_events`, `commands`, `terminals`, `cost_records`, `notes`. Multi-provider columns on `sessions`:

- `agent_provider` (`'claude'` default, `'codex'` for Codex sessions).
- `model` — current model id; nullable so the adapter falls back to its default.
- `agent_session_id` + `agent_session_id_history` — provider-agnostic id (Codex thread id, or mirror of `claude_session_id`); history is a JSON array kept across resumes.
- `claude_session_id` + `claude_session_id_history` — Claude-specific; the `claude --resume <id>` JSONL filename.
- `mode`, `scratchpad`, `tags` (JSON array).
- `loader_variant` — assigned by `loaders.ts:pickLoaderVariant`.
- `git_baseline_commit` — captured on session create so `getDiffSinceCommit` can scope diffs to "what this agent changed".
- `terminal_alerts` — kept for commands, no-op for sessions.

`claude_session_loaders` maps a Claude session id → loader variant so re-imports from disk get a stable avatar. `session_events` is a generic per-session event log (event_type, payload, created_at) used by reconcile + audit paths.

### WebSocket

Single endpoint: `/ws`. Messages are JSON `{ type, processId?, payload }`. One client subscribes to at most one process at a time (`WsClientState.subscribedProcess`). State / permission / agent events are broadcast to subscribers (`sendToSubscribers`) or all clients (`broadcast`). Heartbeat: 30s ping/pong, terminate on missed pong.

**Inbound (client → server):**

- `subscribe` / `unsubscribe` — bind/release the client's `subscribedProcess` for per-process events.
- `session:send` `{ processId, payload: { text } }` — dispatch a user turn to `agentManager.sendTurn`. Auto-registers the session from the DB if needed.
- `pty-input` / `pty-resize` — commands and terminals only; silently dropped for session ids.
- `permission:respond` `{ id, decision, updatedInput, alwaysAllow? }` — UI's response to a permission prompt; resolves the adapter's `canUseTool` Promise.
- `permission:answer-question` `{ id, answer }` — response to an `AskUserQuestion` prompt.
- `session:elicitation:respond` `{ id, action: 'accept' | 'decline' | 'cancel', content? }` — response to an MCP elicitation prompt; resolves `ElicitationManager`'s pending Promise.
- `option:dismiss` `{ sessionId, optionId }` — UI dismisses a detected option (option detector results are stored, not transient).

**Outbound (server → client):**

- `process-state-changed` / `process-metrics` / `process-exited` — for any process type. Sessions emit `process-state-changed` from the agent manager with the same payload shape.
- `daemon-log` `{ entry }` — `devLog` entries fed to the in-app DevLog panel.
- `session:assistant-message` `{ messages: Message[] }` — final text + tool_use blocks for one assistant turn.
- `session:assistant-delta` `{ sessionId, itemId, text }` — cumulative text snapshot per in-flight assistant item.
- `session:reasoning-delta` `{ sessionId, itemId, text }` — cumulative chain-of-thought snapshot.
- `session:tool-event` `{ messages: Message[] }` — tool_result blocks; rendered by `ToolCallCard`.
- `session:tool-delta` `{ sessionId, itemId, input?, output? }` — in-flight tool input/output snapshot.
- `session:tool-progress` `{ sessionId, itemId, progress }` — numeric/percent progress when the tool emits it.
- `session:user-message` `{ messages: Message[] }` — confirms the user's recorded turn; dedupe by `Message.id`.
- `session:turn-result` `{ subtype, totalCostUsd, usage, text }` — fires when the canonical turn result arrives (Claude SDK `result` message; Codex `turn/completed`).
- `session:turn-error` `{ message }` — surfaced as a toast / alert.
- `session:turn-complete` `{}` — fires after `turn-result` regardless of success/error.
- `session:idle` — session has finished any in-flight work and is ready for the next turn.
- `session:state-updated` `{ sessionId, state }` — live cost / token / currentTool snapshot. Mirrored onto `Session.claudeState` (Claude) or the provider-agnostic state in the store.
- `session:mode-changed` `{ sessionId, mode }` — mode flip acknowledged.
- `session:reconciled` `{ sessionId }` — adapter has finished merging persisted disk state with in-memory state (Codex rollout reconciliation).
- `session:message-rekeyed` `{ sessionId, oldId, newId }` — synthetic in-flight id replaced by the persisted id.
- `session:notification` `{ sessionId, payload }` — replaces the old `hook:Notification`; surfaces a toast + chime.
- `session:alert` `{ alert }` — `SessionAlert` for the NotificationCenter (see [Alerts + notifications](#alerts--notifications)).
- `session:status` `{ sessionId, status }` — transient status (`compacting`, `requesting`, etc.).
- `session:task-event` `{ sessionId, tasks }` — live task list (Codex `TaskList` items, Claude TodoWrite renders).
- `session:options-detected` — JSONL parse for option detection.
- `session:updated` / `session:created` / `session:deleted` — DB-row events.
- `session:ended` — final wind-down event for the session lifecycle.
- `permission:prompt` / `permission:resolved` / `permission:expired` — permission flow.
- `session:elicitation:prompt` / `:resolved` / `:expired` — elicitation flow.
- `git:status-changed` `{ projectId, status: GitStatusSummary }` — broadcast by the daemon's `GitWatcher` (debounced 500ms) on any working-tree change. The web GitPanel reads this off the `gitByProject` slice and re-renders without polling.
- `pty-output` / `scrollback` — commands and terminals only.

Single-delivery rule: `pty-output` is sent directly to the subscribed client in `pty/stream.ts`'s `handleSubscribe` data listener. Do **not** also broadcast it from `server.ts` — there's a load-bearing comment about the double-delivery bug this caused.

### Slash commands

The composer's `/`-autocomplete merges:

1. Custom commands from `<project>/.claude/commands/*.md` (project-scoped, ranked highest) — discovered via `GET /api/projects/:id/slash-commands` which parses YAML frontmatter.
2. Custom commands from `~/.claude/commands/*.md` (user-global).
3. **MultiTable-native built-ins** that are intercepted client-side in `ChatInputCM`'s `handleNativeSlash`. Currently only `/clear` (calls `POST /api/sessions/:id/reset`, nulls `claudeSessionId`, clears messages) and `/cost` (renders cost as an inline system message via `appendMessages`).

Custom commands flow through `wsClient.sendTurn` → SDK `query()`; the SDK reads the `.md` file and substitutes `$ARGUMENTS`. Built-in TUI commands like `/model`, `/compact`, `/init` are deliberately NOT surfaced — the SDK doesn't intercept them, so they'd land as plain text. To add one, intercept in `handleNativeSlash` and add it to `BUILTIN_SLASH_COMMANDS` in `cm-completions.ts`.

### Web (`packages/web/src`)

A note on terminology: **the UI says "agent" wherever it used to say "session"** (sidebar, modals, "Add Agent", "Past Agents"). The internal types still say `Session` / `AgentSession` because that's the on-disk and on-the-wire shape — don't rename them when you're working in code.

- `main.tsx` → `App.tsx` — single root. `App.tsx` wires WebSocket events to the Zustand store; re-fetches everything on `ws:reconnected`. Uses `useAppStore.getState()` inside WS handlers (not the closure's stale `store`) so updates always read live state.
- `stores/appStore.ts` — the single Zustand store. Beyond the original slices (projects, processes, permissions, options, themes, modals, selection, `messagesBySession`), it now also owns: `alerts` + `unreadBySession` + `notificationCenterOpen`, `pendingElicitations`, `gitByProject`, `tasksBySession`, `toolProgressBySession`, `statusBySession`, `streamingBySession`, `modelCatalog` + `modelCatalogStatus`, `devLogOpen` (persisted to localStorage). `detailPanelTab` is `'brainstorm' | 'tasks' | 'prompts' | 'cost' | 'diff' | 'files'`.
- `lib/ws.ts`, `lib/api.ts` — WS client (with reconnect) and fetch wrapper. UI code talks to these, not `fetch` directly. `wsClient.sendTurn(processId, text)` is the only way to send a session message; commands and terminals still use `wsClient.sendInput`.
- `lib/cm-completions.ts` — CodeMirror autocompletion sources for `@` file mentions (fuzzy-matched against the project file index, `filter: false` because labels don't share the `@` prefix) and `/` slash commands.
- `lib/cm-theme.ts` — CM6 theme bound to live CSS variables via `getComputedStyle`. Tooltip styles (autocomplete popup) live in `globals.css` because fixed-position tooltips mount on `document.body` and don't inherit the editor's themed class scope.
- `lib/shiki.ts` — lazy singleton highlighter for assistant code blocks.
- Other `lib/`: `notify.ts` (toasts + audio), `browserNotifications.ts` (OS notifications), `sound.ts`, `tabBadge.ts`, `notificationPrefs.ts` (per-category + per-severity prefs), `devLog.ts` + `devLogCapture.ts` (in-app ring buffer), `markdown.tsx` (custom Streamdown components), `pastAgents.ts` (resume + project resolution), `processState.ts` (`isProcessActive`), `rafBatch.ts` (rAF-coalesced setState), `nodeColor.ts`, `relativeTime.ts`.
- `components/main-pane/chat/` — `SessionChat` (orchestrator), `MessageList` (turn-grouped list + loaders), `AssistantMessage` (Streamdown markdown + shiki), `UserMessage`, `ToolCallCard` (collapsible tool I/O with icon registry), `ReasoningCard` (collapsible CoT, live + canonical), `CodeBlock` (shiki + copy), `ChatInputCM` (CodeMirror 6 composer; `handleNativeSlash` intercepts `/clear` and `/cost`), `ExpandedComposer` (modal for long drafts + image attachments), `ModelChip` (current model with catalog prettifier), `LoaderNode` (project-colored dot-matrix avatar that animates during turns), `TurnRow` (dot/line rail geometry), `ChatScroller` (ResizeObserver-driven sticky scroll), `TasksTab` (live task list from `session:task-event`), `StreamingContext`, `turnGrouping.ts`.
- `components/main-pane/git/` — `GitPanel` (top-level, watches `gitByProject[projectId]`), `GitFileList` (staged / unstaged / untracked / conflicted with icons), `GitDiffPane`, `GitBranchPicker`, `GitCommitComposer`, `DiffFileSection`.
- `components/main-pane/MainPane.tsx` — branches on `process.type === 'session'` to mount `SessionChat`; everything else mounts `TerminalView` (xterm). Other main-pane surfaces: `DashboardView`, `ProjectOverview`, `ProjectMonitor`, `SessionDetailPanel`, `SessionHeaderBar`, `ModeBadge`, `ProcessBanner`.
- `components/sidebar/` — `Sidebar`, `SidebarItem`, `ProjectSidebarItem`, `ProjectHeader`, `SidebarSection`, `StatusDot`, `SessionStatusLoader`, **`PastAgentsList`** (replaces the old `PastSessions`), `LogoArt`.
- `components/modals/` — `AddAgentModal` (provider picker — Claude / Codex / scaffolds for Gemini / Copilot / opencode), `AddProjectModal`, `GlobalSettingsModal`, `IntegrationsSection` (Telegram), `NotificationsSection` (per-category + per-severity prefs), `PastAgentsBrowser` (deep transcript browser merging `useTranscripts` + `useCodexTranscripts`).
- `components/elicitation/ElicitationModal.tsx` — schema-driven JSON form (type-aware inputs, enum dropdowns, defaults).
- `components/notifications/NotificationCenter.tsx` — alert history with severity icons, dismiss/clear, unread badges per session.
- `components/dev-log/DevLogPanel.tsx` — in-memory ring buffer with pause/play and live search; reads via `useSyncExternalStore`.
- `components/permission/` — `PermissionBar`, `ToolInputPreview` (renders the optional `title`/`displayName`/`subtitle`/`blockedPath` fields from `PermissionPrompt`).
- `components/ui/dotmatrix-core.tsx` + `dotmatrix-hooks.ts` + 60 `dotm-{square,circular,triangle}-{1..20}.tsx` — the project loader/avatar system. Patterns: `diamond`, `full`, `outline`, `rose`, `cross`, `rings`; phases: `idle`, `collapse`, `hoverRipple`, `loadingRipple`. Variant assignment happens server-side via `loaders.ts:pickLoaderVariant` so a project keeps its avatar across reloads.
- `components/command-palette/`, `components/option/`, `components/status-bar/`, `components/mobile/`, `components/ui/` (primitives) — organized by area.
- `hooks/useTheme.ts`, `lib/themes.ts` — theme system; CSS variables on `:root` drive colors. Inline styles throughout the codebase use `var(--...)` tokens.
- Styling: Tailwind is set up, but most components use inline `style={{ ... }}` with CSS variables. Follow the existing pattern in the file you're editing rather than mixing approaches.

## TypeScript / module system

- Root `tsconfig.json` uses `module: Node16` / `moduleResolution: Node16` — **relative imports in the daemon must include the `.js` extension** (e.g. `import { initDb } from './db/store.js'`), even though the source is `.ts`. Follow existing imports.
- The web package uses Vite's bundler resolution; no `.js` suffix needed there.
- Strict mode is on. `@typescript-eslint/no-explicit-any` is a warning, not an error — but prefer real types.

## Prettier / ESLint

- Prettier: single quotes, trailing commas, semicolons, 100-char width, 2-space tabs.
- ESLint extends `eslint:recommended` + `@typescript-eslint/recommended`. Unused vars prefixed with `_` are allowed.

## How to push to master

Master is protected. **Direct pushes to master are blocked, including for the repo owner** (`enforce_admins: true`). Every change — even a one-line typo — goes through a PR. The CI workflow runs lint + build on a 3×3 matrix (Linux/macOS/Windows × Node 18/20/22); a single rollup job named `ci` aggregates the matrix and is the only required status check on the protection rule.

The standard flow:

```bash
# 1. Branch from master
git checkout master && git pull
git checkout -b <type>/<short-description>   # e.g. fix/typo, feat/foo, chore/bar

# 2. Make changes, commit
git add <files> && git commit -m "..."

# 3. Push branch + open PR
git push -u origin HEAD
gh pr create --fill                          # or --title / --body for releases

# 4. Wait for CI green, then squash-merge
gh pr merge --squash --delete-branch
```

Conventions:

- **Always squash-merge** — the repo only has squash + rebase enabled; squash is the default and matches GitHub's recommendation. PR title becomes the master commit subject, PR body becomes the body.
- **One PR = one logical change.** Small fixes are fine — don't batch unrelated work just to avoid the PR overhead.
- **Branch naming:** `feat/`, `fix/`, `chore/`, `docs/`, `refactor/` prefixes. Anything you'd put in a conventional commit message.
- **Releases:** bump versions in all four `package.json` files (root + 3 packages), update the README badge, tag `vX.Y.Z` on master after the PR merges, then `gh release create vX.Y.Z --target master --generate-notes` (hand-edit the auto-notes for the headline summary).

Emergency override (don't do this casually):

```bash
# Temporarily disable enforcement, push hotfix, re-enable.
gh api -X DELETE repos/erickalfaro/multitable/branches/master/protection/enforce_admins
git push origin master
gh api -X POST   repos/erickalfaro/multitable/branches/master/protection/enforce_admins
```

This exists for true emergencies (broken CI infra blocking a critical fix, etc.). For everything else, even a one-line README change goes through a PR — that's what the protection rule is for.

The required check name is `ci` (the rollup job in `.github/workflows/ci.yml`). **Don't rename the `ci` job without also updating the branch protection rule** via `gh api -X PUT repos/erickalfaro/multitable/branches/master/protection/required_status_checks` — the rule references the check by name, and a rename silently turns the gate into "no required checks ever arrive" → admin bypass becomes the only way through.

## Recently retired (don't reintroduce)

These have been deleted on the way to today's architecture. Rebuilding them would re-create bugs we already fixed:

- `hooks/installer.ts` and `hooks/receiver.ts` — wrote curl-based webhook hooks into project `.claude/settings.json` and exposed `/api/hooks/*`. Replaced by SDK `options.hooks` callbacks in `ClaudeAdapter:makeHooks` (was `agent/manager.ts:makeHooks`).
- `transcripts/tail.ts` and `TranscriptTailerRegistry` — chokidar tail of session JSONL feeding `session:transcript-delta`. Replaced by adapter-driven async-iterable event streams feeding `session:assistant-message` / `session:assistant-delta` / `session:tool-event` / `session:tool-delta` / `session:reasoning-delta` / `session:user-message`.
- `claude --resume <id>` PTY spawn, the `'No conversation found'` detector, the `/$bunfs/...` zombie/crash guard, the `resume-failed` event — sessions don't have a child process anymore.
- `/api/sessions/:id/start`, `/restart`, `/spawn-claude`, `/resume-claude` — sessions auto-start on first turn; the only lifecycle endpoint is `/stop` (calls `agentManager.abortTurn`) and `/reset` (clears the conversation for `/clear`).
- `hook:*` WS events — replaced by specific `session:*` events.
- The xterm `TerminalView` for sessions — now used only for commands and terminals.
- **`@openai/codex-sdk` dependency** — replaced by direct line-delimited JSON-RPC to `codex app-server` (see `agent/providers/codex-app-server/`). Don't reintroduce the npm package.
- **"Claude logic inline in `manager.ts`"** — Claude was extracted into `agent/providers/claude.ts`. The manager is now provider-agnostic; don't pull Claude-specific code back into it.
- **`components/sidebar/PastSessions.tsx`** — replaced by `PastAgentsList.tsx` (sidebar) + `PastAgentsBrowser.tsx` (modal). Part of the UI-wide "session" → "agent" rename.
