# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MultiTable is a local, browser-based dashboard for managing AI coding agents and dev processes. A Node.js daemon drives Claude Code sessions through the **`@anthropic-ai/claude-agent-sdk`** (no PTY for sessions), spawns commands and terminals via `node-pty`, persists state in SQLite, and serves a React UI over REST + WebSocket on `localhost:3000`. See `docs/OVERVIEW.md`, `docs/SPEC.md`, and `docs/SDK_MIGRATION_PLAN.md` for the product concept and the migration history; this file is about working in the code.

## Monorepo layout

npm workspaces under `packages/*`:

- `packages/daemon` — Node.js + Express + `ws` + `node-pty` + `better-sqlite3` + `@anthropic-ai/claude-agent-sdk`. The entire backend.
- `packages/web` — React + Vite + xterm.js (commands/terminals only) + CodeMirror 6 (composer) + react-markdown + shiki + Zustand + TailwindCSS. Builds into `packages/daemon/dist/public` so the daemon serves the SPA.
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

`AgentSession.provider` is `'claude' | 'codex'` (extensible). Each provider has an adapter under `packages/daemon/src/agent/providers/`:

- `types.ts` — `ProviderAdapter` contract: `runTurn(s, text, ctrl, callbacks)`, optional `reset(s)`, optional `destroy(s)` (per-session), optional `shutdown()` (daemon-wide). `AdapterCallbacks` are the manager-owned hooks an adapter calls into.
- `codex.ts` — `CodexAdapter`: drives `codex app-server` via JSON-RPC. Owns a per-session `{threadId, mode}` cache that the `setMode` flow blows away on mode flip (Codex options are immutable post-thread-start).
- `codex-app-server/` — `CodexAppServerTransport` (line-delimited JSON-RPC over child stdio) + `CodexAppServerClient` (singleton with per-thread notification fan-out, auto-deny ServerRequest handlers, lazy spawn, crash-respawn watchdog).
- `codex-protocol/` — generated TS bindings for the `codex app-server` protocol. Regenerate via `codex app-server generate-ts --out packages/daemon/src/agent/providers/codex-protocol/` and bump `_codex-cli-version.ts`.
- Claude logic still lives inline in `agent/manager.ts` (its handlers are tightly coupled to permission/elicitation/hook plumbing). Treat the manager as the de-facto Claude adapter.
- `index.ts` — re-exports.

To add a new provider: drop a `<provider>.ts` adapter under `agent/providers/`, add a dispatch branch in `manager.ts`'s `sendTurn`, and (if the adapter has on-disk persistence) add a parser under `transcripts/`.

### Codex specifics

- **Approval policy is hardcoded to `'never'`** on every `thread/start` and `thread/resume` request. Tool gating happens via the spawn-time `sandbox` enum (`read-only` / `workspace-write` / `danger-full-access`). The client also auto-denies any approval ServerRequests defensively. `PermissionManager` stays Claude-only by design.
- **Streaming response previews.** Codex emits per-chunk `item/agentMessage/delta` notifications (`streamingDeltaSemantics: 'additive'`); the adapter accumulates per-item buffers and forwards cumulative text over `session:assistant-delta`. `item/completed` carries the canonical final message. `item/reasoning/textDelta` and `item/commandExecution/outputDelta` follow the same pattern for reasoning + tool output.
- **No USD cost field on `Usage`.** Token counts populate; the dollar row is hidden in the cost UI for Codex sessions.
- **Thread persistence** is owned by the codex CLI under `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<thread_id>.jsonl`. `transcripts/codexParser.ts` reads these into the same `Message[]` shape the Claude JSONL parser produces. `AgentSessionManager.register` hydrates `s.messages` from disk on startup; `/api/sessions/:id/messages` re-hydrates if the in-memory cache is empty.
- **Past Codex threads** are listed via `GET /api/transcripts/codex` and resumed via `POST /api/transcripts/codex/:threadId/resume`. The AddAgentModal renders them as a separate section under "Or resume a Codex thread".

## Build gotcha: schema.sql

`tsc` does not copy non-TS assets. The daemon's `build` script already runs `cp src/db/schema.sql dist/db/schema.sql`, but if you ever invoke `tsc` directly (e.g. `npx tsc` inside `packages/daemon`), you must also copy the schema or the daemon will crash on startup when it tries to init the DB.

## Architecture

### Daemon (`packages/daemon/src`)

Startup sequence lives in `index.ts` and is load-bearing — read it before changing boot order:

1. Load global config (`config/loader.ts`, reads `~/.config/multitable/config.yml` via `env-paths`).
2. Check `pids.json` for orphaned processes from prior runs (`pids.ts`).
3. Init SQLite (`db/store.ts` — schema from `db/schema.sql`).
4. Create `PtyManager`, `PermissionManager`, and `AgentSessionManager`.
5. Build Express + WS server (`server.ts`).
6. Load DB sessions and `agentManager.register(...)` each one (no PTY spawn). Autostart commands; attach file watchers for commands.
7. Listen on `host:port`.

Key modules:

- **`agent/manager.ts` — `AgentSessionManager`**. Owns every Claude Code session. Holds an in-memory `Map<sessionId, AgentSession>` (state, claudeSessionId, cost/token totals, in-flight turn). `sendTurn()` calls SDK `query()` with `resume`, `canUseTool`, and `hooks`; `handleSdkMessage` routes the SDK's async-iterable events through `sdkAdapter` to typed `Message[]`. Emits `state-changed`, `session-updated`, `assistant-message`, `tool-event`, `user-message`, `turn-result`, `turn-error`, `turn-complete`, `state-snapshot`, `options-detected`, `label-updated`, `notification`, `session-ended` — all consumed by `server.ts` and rebroadcast over WS.
- **`agent/sdkAdapter.ts`** — pure converters from SDK message shapes to MultiTable's `Message` union (the same shape `transcripts/parser.ts` produces from the on-disk JSONL, so the frontend treats both identically).
- **`agent/types.ts`** — `AgentSession`, `AgentMessageOut`, `SendTurnInput`.
- **`pty/manager.ts`** — `PtyManager`, the source of truth for **commands and terminals only** (sessions never go through it). Spawn / restart / metrics / ring-buffer scrollback. Emits `state-changed`, `metrics`, `exit`. The `--resume` / zombie / crash-detection branches are gone — that was the PTY-era session path.
- **`pty/ringBuffer.ts`** — per-process scrollback buffer replayed to new WS subscribers (commands and terminals).
- **`pty/stream.ts`** — the WS message router (`handleWsMessage`). Routes `subscribe`/`unsubscribe`/`pty-input`/`pty-resize` for commands and terminals; routes `session:send` to `agentManager.sendTurn`. For session subscribes, it auto-registers the session from the DB if missing and emits `process-state-changed`; sessions never trigger PTY spawn.
- **`db/store.ts`** — better-sqlite3, synchronous. Exported functions are the DB API; routers call them directly rather than going through a service layer.
- **`api/*.ts`** — one router per resource (`projects`, `sessions`, `commands`, `terminals`, `processes`, `config`, `search`, `transcripts`, `notes`). Each is a factory; `sessions` and `processes` receive both `manager` (PtyManager, for command/terminal lifecycle) and `agentManager` where needed. Sessions auto-register from the DB on `_internal/agent/turn` and on `session:send` so newly-created or post-boot rows always work.
- **`hooks/permissionManager.ts`** — holds pending permission prompts until the UI resolves them. Exposes `requestFromSdk(sessionId, ..., signal, extras)` that the SDK's `canUseTool` callback awaits. Reuses the existing dedup, allowlist (`always-allow`), auto-defer, and 110s timeout. The HTTP `/api/hooks/*` receiver is **gone** — Phase 6 retired it.
- **`hooks/costParser.ts`, `labeler.ts`, `optionDetector.ts`, `promptsParser.ts`** — JSONL-driven utilities still used by the `/cost`, `/prompts`, label generation, and option detection paths. They read the same `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` files the SDK writes.
- **`transcripts/parser.ts`** — JSONL → `Message[]` parser, used by `/api/sessions/:id/messages` and the transcript browser.
- **`watcher/index.ts`** — chokidar-based file watcher for `mt.yml` changes and per-command `fileWatchPatterns` restart triggers (commands only; sessions don't have a "restart on file change" concept).
- **`git/index.ts`** — `simple-git`–backed read + write helpers used by `/api/projects/:id/git/*` (status, diff, log, branches, stage, unstage, commit, discard, branch create/switch, stash). Plus `getDiffSinceCommit` for the per-agent diff scope (uses `sessions.git_baseline_commit` captured on session create).
- **`git/watcher.ts`** — `GitWatcher` class. One chokidar watcher per project's working tree (ignores `node_modules`, `.git/objects`, `.git/logs`); on debounced fs change recomputes `getStatusSummary` and broadcasts `git:status-changed` so the GitPanel updates live as agents write files.
- **`tracker/`, `conflict/`** — cost tracking and process-conflict detection.
- **`types.ts`** — shared types (`ManagedProcess`, `ProcessState`, `WsMessage`, `PermissionPrompt`, `Project`, `GlobalConfig`, `ProjectConfig`, `SpawnConfig`). The `PermissionPrompt` carries optional `title`/`displayName`/`subtitle`/`blockedPath` fields surfaced from the SDK's `canUseTool` options bag.

### API routing quirk

Creation endpoints `POST /api/projects/:id/{sessions,commands,terminals}` live on the **projects router**, not the resource routers. The projects router calls DB store functions directly. The per-resource routers (`/api/sessions`, `/api/commands`, `/api/terminals`) handle mutations on an existing id (`PUT`, `DELETE`, lifecycle actions). If you're adding a creation route, put it on the projects router to stay consistent.

### Session vs Command vs Terminal

Three process types, modeled separately and managed by **different** owners:

- **Session** — AI agent. Owned by `AgentSessionManager`. No PTY child. Conversation history persists at `~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl` (the same file the `claude` CLI uses — full interop). Sending a message auto-starts the SDK turn; if a `claudeSessionId` is on file the SDK resumes, otherwise it creates a fresh conversation. There is **no separate "Resume" or "Start" action**.
- **Command** — long-running dev process (dev server, worker). PTY child. Has autorestart + file-watch-restart.
- **Terminal** — ad-hoc shell. PTY child.

Process state machine (the `state` field):

- For commands/terminals: `running` (PTY alive) / `idle` / `stopped` (no PTY) / `errored` (auto-restart exhausted).
- For sessions: `stopped` (resting; ready for next turn) / `running` (turn in flight) / `errored` (last turn threw, see `session:turn-error`). There's no `idle` distinction for sessions — they sit at `stopped` until you send something.

Auto-restart respects `autorestartMax`, `autorestartDelayMs`, and resets count after `autorestartWindowSecs`. Sessions ignore all autorestart fields — those columns are kept in the DB schema for backward compatibility but are commands-only in practice.

### WebSocket

Single endpoint: `/ws`. Messages are JSON `{ type, processId?, payload }`. One client subscribes to at most one process at a time (`WsClientState.subscribedProcess`). State / permission / agent events are broadcast to subscribers (`sendToSubscribers`) or all clients (`broadcast`). Heartbeat: 30s ping/pong, terminate on missed pong.

**Inbound (client → server):**

- `subscribe` / `unsubscribe` — bind/release the client's `subscribedProcess` for per-process events.
- `session:send` `{ processId, payload: { text } }` — dispatch a user turn to `agentManager.sendTurn`. Auto-registers the session from the DB if needed.
- `pty-input` / `pty-resize` — commands and terminals only; silently dropped for session ids.
- `permission:respond` / `permission:answer-question` — UI's response to a permission prompt; resolves the SDK's `canUseTool` Promise.

**Outbound (server → client):**

- `process-state-changed` / `process-metrics` / `process-exited` — for any process type. Sessions emit `process-state-changed` from the agent manager with the same payload shape.
- `session:assistant-message` `{ messages: Message[] }` — text + tool_use blocks for one assistant turn.
- `session:tool-event` `{ messages: Message[] }` — tool_result blocks; rendered by `ToolCallCard`.
- `session:user-message` `{ messages: Message[] }` — confirms the user's recorded turn; dedupe by `Message.id`.
- `session:turn-result` `{ subtype, totalCostUsd, usage, text }` — fires when the SDK's `result` message arrives.
- `session:turn-error` `{ message }` — surfaced as a toast.
- `session:turn-complete` `{}` — fires after `turn-result` regardless of success/error.
- `session:state-updated` `{ sessionId, state }` — live cost / token / currentTool snapshot. Mirrored onto `Session.claudeState` in the store.
- `session:notification` `{ sessionId, payload }` — replaces the old `hook:Notification`; surfaces a toast + chime.
- `session:updated` / `session:created` / `session:deleted` — DB-row events.
- `session:options-detected` / `session:label-updated` — Stop-time JSONL parses for option detection and the labeler.
- `permission:prompt` / `permission:resolved` / `permission:expired` — permission flow.
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

- `main.tsx` → `App.tsx` — single root. `App.tsx` wires WebSocket events to the Zustand store; re-fetches everything on `ws:reconnected`. Uses `useAppStore.getState()` inside WS handlers (not the closure's stale `store`) so updates always read live state.
- `stores/appStore.ts` — the single Zustand store. Projects, processes (sessions/commands/terminals keyed by id), permissions, options, themes, modal state, selection, **per-session message lists** (`messagesBySession`).
- `lib/ws.ts`, `lib/api.ts` — WS client (with reconnect) and fetch wrapper. UI code talks to these, not `fetch` directly. `wsClient.sendTurn(processId, text)` is the only way to send a session message; commands and terminals still use `wsClient.sendInput`.
- `lib/cm-completions.ts` — CodeMirror autocompletion sources for `@` file mentions (fuzzy-matched against the project file index, `filter: false` because labels don't share the `@` prefix) and `/` slash commands.
- `lib/cm-theme.ts` — CM6 theme bound to live CSS variables via `getComputedStyle`. Tooltip styles (autocomplete popup) live in `globals.css` because fixed-position tooltips mount on `document.body` and don't inherit the editor's themed class scope.
- `lib/shiki.ts` — lazy singleton highlighter for assistant code blocks.
- `components/main-pane/chat/` — `SessionChat`, `MessageList`, `AssistantMessage` (react-markdown + shiki), `UserMessage`, `ToolCallCard` (collapsible), `CodeBlock`, `ChatInputCM` (CodeMirror 6 composer). Sessions render here; commands and terminals still render through `TerminalView` (xterm).
- `components/main-pane/MainPane.tsx` — branches on `process.type === 'session'` to mount `SessionChat`; everything else mounts `TerminalView`.
- `components/sidebar/`, `components/main-pane/` (Dashboard / ProjectOverview / SessionDetailPanel), `components/modals/`, `components/command-palette/`, `components/permission/`, `components/option/`, `components/status-bar/`, `components/mobile/`, `components/ui/` (primitives) — organized by area.
- `hooks/useTheme.ts`, `lib/themes.ts` — theme system; CSS variables on `:root` drive colors. Inline styles throughout the codebase use `var(--...)` tokens.
- Styling: Tailwind is set up, but most components use inline `style={{ ... }}` with CSS variables. Follow the existing pattern in the file you're editing rather than mixing approaches.

## TypeScript / module system

- Root `tsconfig.json` uses `module: Node16` / `moduleResolution: Node16` — **relative imports in the daemon must include the `.js` extension** (e.g. `import { initDb } from './db/store.js'`), even though the source is `.ts`. Follow existing imports.
- The web package uses Vite's bundler resolution; no `.js` suffix needed there.
- Strict mode is on. `@typescript-eslint/no-explicit-any` is a warning, not an error — but prefer real types.

## Prettier / ESLint

- Prettier: single quotes, trailing commas, semicolons, 100-char width, 2-space tabs.
- ESLint extends `eslint:recommended` + `@typescript-eslint/recommended`. Unused vars prefixed with `_` are allowed.

## Recently retired (don't reintroduce)

These were part of the pre-SDK architecture and have been deleted. Rebuilding them would re-create bugs we already fixed:

- `hooks/installer.ts` and `hooks/receiver.ts` — wrote curl-based webhook hooks into project `.claude/settings.json` and exposed `/api/hooks/*`. Replaced by SDK `options.hooks` callbacks in `agent/manager.ts:makeHooks`.
- `transcripts/tail.ts` and `TranscriptTailerRegistry` — chokidar tail of session JSONL feeding `session:transcript-delta`. Replaced by the SDK's async-iterable event stream feeding `session:assistant-message` / `session:tool-event` / `session:user-message`.
- `claude --resume <id>` PTY spawn, the `'No conversation found'` detector, the `/$bunfs/...` zombie/crash guard, the `resume-failed` event — sessions don't have a child process anymore.
- `/api/sessions/:id/start`, `/restart`, `/spawn-claude`, `/resume-claude` — sessions auto-start on first turn; the only lifecycle endpoint is `/stop` (calls `agentManager.abortTurn`) and the new `/reset` (clears the conversation for `/clear`).
- `hook:*` WS events — replaced by specific `session:*` events (notification, turn-complete, etc.).
- The xterm `TerminalView` for sessions — now used only for commands and terminals.
