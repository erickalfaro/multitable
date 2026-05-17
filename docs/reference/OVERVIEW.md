# MultiTable — Simplified Overview

> A browser-based dashboard + process manager for AI coding agents and dev tools.
> Local Node.js daemon serves a React UI. Define processes in `mt.yml`, see everything in one window.
> Runs on Linux, macOS, and Windows.

---

## What Is It?

```
Instead of this:                      You get this:
┌──────┐ ┌──────┐ ┌──────┐          ┌──────────────────────────────┐
│Claude│ │ Codex│ │ npm  │          │  MultiTable (one browser tab)│
│ Code │ │      │ │ dev  │          │                              │
└──────┘ └──────┘ └──────┘          │  All processes. One view.    │
┌──────┐ ┌──────┐ ┌──────┐          │  Status at a glance.         │
│Queue │ │ Logs │ │ bash │          │  Auto-restart on crash.      │
│worker│ │      │ │      │          │  Access from any device.     │
└──────┘ └──────┘ └──────┘          └──────────────────────────────┘
 6+ terminal tabs scattered            1 tab, everything managed
```

---

## Core Concepts

```
┌─ Project ────────────────────────────────────────────────────┐
│  A directory path + optional mt.yml config                    │
│  All sessions/commands/terminals run from this path           │
│                                                              │
│  ┌─ Sessions ───────┐  ┌─ Commands ────────┐  ┌─ Terminals ┐│
│  │ AI agent          │  │ Dev servers,      │  │ Ad-hoc     ││
│  │ (Claude, Codex,   │  │ queue workers,    │  │ shells     ││
│  │  Hermes/Grok)     │  │ build watchers    │  │ (Ctrl+T)   ││
│  │                   │  │                   │  │            ││
│  │ SDK-driven,       │  │ PTY child,        │  │ PTY child  ││
│  │ no PTY. Tracked:  │  │ auto-start,       │  │ No config  ││
│  │ cost, tokens,     │  │ auto-restart,     │  │ needed     ││
│  │ diffs, timeline   │  │ file-watch restart │  │            ││
│  └───────────────────┘  └───────────────────┘  └────────────┘│
└──────────────────────────────────────────────────────────────┘
```

A **Session** is an AI-agent conversation driven through a provider adapter
(Claude via the in-process Agent SDK, Codex via a `codex app-server` JSON-RPC
child, Hermes/Grok via `hermes acp` ACP JSON-RPC). Sessions have **no PTY** —
the daemon talks to the provider directly and streams the conversation to a
React chat UI. **Commands** and **Terminals** are real PTY children (`node-pty`).

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Browser (any device: laptop, iPad, phone)  │
│  ┌───────────────────────────────────────┐  │
│  │  React UI                             │  │
│  │   • chat view for sessions            │  │
│  │   • xterm.js for commands/terminals   │  │
│  └──────────┬──────────────┬─────────────┘  │
│        REST API        WebSocket             │
└─────────────┼──────────────┼────────────────┘
              │   localhost   │
┌─────────────┼──────────────┼────────────────┐
│  mt daemon (Node.js)       │                 │
│  ┌──────────┐  ┌───────────┴──┐              │
│  │ Express  │  │ ws (streams)  │              │
│  └──────────┘  └──────────────┘              │
│  ┌────────────────────┐  ┌────────────────┐  │
│  │ Agent providers     │  │ node-pty        │  │
│  │ Claude SDK / Codex  │  │ (commands &     │  │
│  │ app-server / Hermes │  │  terminals)     │  │
│  │ ACP   → sessions    │  │                 │  │
│  └────────────────────┘  └────────────────┘  │
│  ┌──────────┐  ┌──────────────┐              │
│  │ SQLite   │  │ chokidar      │              │
│  │ (state)  │  │ (watch)       │              │
│  └──────────┘  └──────────────┘              │
│  ┌──────────────┐                            │
│  │ simple-git    │                            │
│  │ (diffs)       │                            │
│  └──────────────┘                            │
│                                              │
│  REST  = CRUD for projects/sessions/commands │
│  WS    = session deltas, terminal I/O,       │
│          state changes, metrics              │
└──────────────────────────────────────────────┘
```

---

## Main UI Layout

```
┌──────────────────────────────────────────────────────────────┐
│  Browser Tab: "MultiTable - my-project - Claude Code"        │
├──────────────┬───────────────────────────────────────────────┤
│  SIDEBAR     │  MAIN PANE                                    │
│  (~300px)    │                                               │
│              │  Shows ONE of:                                │
│  ┌─────────┐ │    • Session chat (messages, tools, cost)     │
│  │my-projct│ │    • Terminal output (xterm.js)               │
│  │─────────│ │    • Dashboard (project cards grid)           │
│  │SESSIONS │ │    • Project Overview (settings cards)        │
│  │ ● Claude│ │                                               │
│  │ ● Codex │ │  ┌──────────────────────────────────────┐     │
│  │TERMINALS│ │  │ ▸ refactor the API                   │     │
│  │ ● Term 1│ │  │   I'll start by reading routes.ts…   │     │
│  │COMMANDS │ │  │   ⚙ Read  src/api/routes.ts          │     │
│  │ ● npm   │ │  │   ⚙ Edit  src/api/routes.ts          │     │
│  │ ● Queue │ │  │   ▍ (streaming…)                     │     │
│  │─────────│ │  └──────────────────────────────────────┘     │
│  │Project 2│ │  ┌──────────────────────────────────────┐     │
│  │Project 3│ │  │ Type a message…           [send ▸]   │     │
│  └─────────┘ │  └──────────────────────────────────────┘     │
├──────────────┴───────────────────────────────────────────────┤
│  ● Running   Opus 4.7   $0.42   ↑12k ↓3k tokens             │
└──────────────────────────────────────────────────────────────┘
```

The session main pane is a **React chat**, not a terminal — assistant text,
tool cards, and reasoning stream in live over the WebSocket. xterm.js is used
only when a Command or Terminal is selected.

---

## Dashboard View

```
┌──────────────────────────────────────────────────────────────┐
│  🔍 Search all sessions...                                   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                  │
│  │ my-project    ●  │  │ api-service   ●  │                  │
│  │ 3 sessions       │  │ 1 session        │                  │
│  │ 5 commands       │  │ 3 commands       │                  │
│  │ $1.42 today      │  │ $0.38 today      │                  │
│  └──────────────────┘  └──────────────────┘                  │
│                                                              │
│  ┌──────────────────┐                                        │
│  │ mobile-app    ○  │                                        │
│  │ 0 sessions       │                                        │
│  │ 2 commands       │                                        │
│  │ idle             │                                        │
│  └──────────────────┘                                        │
└──────────────────────────────────────────────────────────────┘
```

---

## Project Overview (Settings)

```
┌──────────────────────────────────────────────────────────────┐
│  my-project  [edit]  │  ● 4/5 Running                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ▼ npm:dev  [AUTO]                                           │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Command:       npm run dev                          │    │
│  │  Auto-start:    [■ on ]    Auto-restart:  [□ off]    │    │
│  │  File watching:  src/**/*.ts  [x]                    │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ▶ Queue  [AUTO]            php artisan queue:work            │
│  ▶ Claude Code  [AUTO]     claude                            │
│                                                              │
│  [+ Add Session]  [+ Add Command]  [+ Add Terminal]          │
└──────────────────────────────────────────────────────────────┘
```

---

## Permission System

Claude and Hermes route per-call tool approvals to the UI (Codex is
sandbox-gated and never prompts). The request appears as a card below the
session chat:

```
┌──────────────────────────────────────────────────────────────┐
│  SESSION CHAT                                                │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  ▸ edit the routes file                              │    │
│  │  I need to edit src/api/routes.ts                    │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─ Permission Request ────────────────────────────────────┐ │
│  │  Claude wants to use: Edit                              │ │
│  │  File: src/api/routes.ts                                │ │
│  │  ████████████░░░░░░░░░░░░  85s remaining                │ │
│  │                                                         │ │
│  │  [Allow]  [Deny]  [Always Allow]                        │ │
│  └─────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│  Status Bar                                                  │
└──────────────────────────────────────────────────────────────┘
```

---

## Process State Machine

**Commands & Terminals** (PTY children):

```
              start()
  Created ──────────► Running ◄─────────┐
                       │    │            │
              user     │    │ crash      │ restart()
              stops    │    │            │
                       ▼    ▼            │
                   Stopped  Errored ─────┘
                             │       (if autorestart
                             │        and under limit)
                             ▼
                         Errored (final)
                      (if limit reached)
```

**Sessions** (no PTY, no autorestart): `stopped` (resting, ready for the next
message) → `running` (a turn is in flight) → back to `stopped`, or `errored`
if the turn threw. Sending a message auto-starts (or resumes) a turn; there is
no Start / Restart / Resume action. The only controls are `/stop` (abort the
in-flight turn) and `/reset` (clear the conversation).

---

## Process Flows

### Flow 1: First-Time Setup

```
User                          CLI / Daemon                  Browser
 │                                │                            │
 │  $ mt start                    │                            │
 │ ──────────────────────────────►│                            │
 │                                │ read config.yml            │
 │                                │ open SQLite                │
 │                                │ serve React app            │
 │                                │ listen on :3000            │
 │                                │────────────────────────────►
 │                                │                            │
 │  Browser opens localhost:3000  │                            │
 │ ◄──────────────────────────────┼────────────────────────────│
 │                                │                            │
 │  Sees empty dashboard          │                            │
 │  Clicks [+ Add Project]        │                            │
 │  Picks a directory path         │                            │
 │ ──────────────────────────────►│                            │
 │                                │ POST /api/projects {path}  │
 │                                │ scans for mt.yml           │
 │                                │ auto-detects framework     │
 │                                │ suggests commands           │
 │                                │◄────────────────────────────
 │                                │                            │
 │  Sees project with suggested   │                            │
 │  commands. Clicks "Start All"  │                            │
 │ ──────────────────────────────►│                            │
 │                                │ spawns command PTYs        │
 │                                │ streams output via WS      │
 │                                │────────────────────────────►
 │  Sidebar shows green dots      │                            │
 │  for all running processes     │                            │
```

### Flow 2: Daily Workflow — Talking to an Agent

```
User                          Daemon                      Browser UI
 │                                │                            │
 │  $ mt start                    │                            │
 │ ──────────────────────────────►│                            │
 │                                │ reads mt.yml               │
 │                                │ autostarts commands:       │
 │                                │   • npm:dev                │
 │                                │   • Queue worker           │
 │                                │ registers sessions (no spawn)
 │                                │────────────────────────────►
 │                                │                            │
 │  Opens browser                 │                            │
 │  Clicks "Claude Code" session  │                            │
 │ ────────────────────────────────────────────────────────────►
 │                                │ WS: subscribe sessionId    │
 │                                │ loads history from disk    │
 │                                │────────────────────────────►
 │                                │                            │
 │  Types a prompt, hits send     │                            │
 │ ────────────────────────────────────────────────────────────►
 │                                │ WS: session:send           │
 │                                │ adapter starts a turn      │
 │                                │ (Claude SDK query())       │
 │                                │ session:assistant-delta ──►│
 │                                │ session:tool-event ───────►│
 │                                │                            │
 │                                │ Claude wants to Edit a file│
 │                                │ canUseTool → PermissionMgr │
 │                                │◄────────────────────────────
 │  Sees Permission card          │                            │
 │  Clicks [Allow]                │                            │
 │ ────────────────────────────────────────────────────────────►
 │                                │ WS: permission:respond     │
 │                                │ resolves canUseTool promise│
 │                                │ turn continues, then       │
 │                                │ session:turn-result ──────►│
 │                                │                            │
 │  Meanwhile, checks npm:dev     │                            │
 │  by clicking it in sidebar     │                            │
 │ ────────────────────────────────────────────────────────────►
 │                                │ WS: unsubscribe session    │
 │                                │ WS: subscribe npm_dev      │
 │                                │ sends scrollback + output  │
 │                                │────────────────────────────►
 │  Sees dev server output        │                            │
```

### Flow 3: Process Crashes and Auto-Restarts

(Commands only — sessions have no autorestart.)

```
                           Daemon                         Browser
                              │                              │
  Queue worker exits(1)       │                              │
  ──────────────────────────► │                              │
                              │ checks autorestart: true     │
                              │ checks restartCount < max    │
                              │                              │
                              │ WS: process-state-changed    │
                              │   state: "errored"           │
                              │──────────────────────────────►
                              │                              │ sidebar dot → red
                              │                              │ toast: "Queue crashed"
                              │ waits 2000ms                 │
                              │ spawns new PTY               │
                              │                              │
                              │ WS: process-state-changed    │
                              │   state: "running"           │
                              │──────────────────────────────►
                              │                              │ sidebar dot → green
                              │                              │ toast: "Queue restarted"
```

### Flow 4: Config-File Driven Setup

```
User edits mt.yml directly (or configures via UI):

  # mt.yml
  name: "my-project"
  sessions:
    - name: "Claude Code"
      command: "claude"
      autostart: true
  commands:
    - name: "npm:dev"
      command: "npm run dev"
      autostart: true
    - name: "Queue"
      command: "php artisan queue:work"
      autostart: true
      autorestart: true

                           Daemon
                              │
  mt.yml saved on disk        │
  ──────────────────────────► │
                              │ chokidar detects change
                              │ reloads config
                              │ starts new processes
                              │──────────────────────────► Browser
                              │                            UI updates
```

### Flow 5: Accessing from Another Device (Tailscale)

```
Dev Machine (running daemon)              iPad on Tailscale
┌────────────────────────────┐    ┌──────────────────────────────┐
│  mt daemon on 0.0.0.0:3000 │    │  Safari opens:               │
│                            │    │  devbox.tail1234.ts.net:3000  │
│  Claude Code ● running     │◄──►│                              │
│  npm:dev     ● running     │ WS │  Same UI, full control       │
│  Queue       ● running     │    │  Can view sessions            │
│                            │    │  Can approve permissions      │
└────────────────────────────┘    └──────────────────────────────┘
```

### Flow 6: Resuming a Past Conversation

There is no "Resume" button. A session keeps its provider conversation id
(Claude `claude_session_id`, Codex thread id, Hermes session id) on disk and in
SQLite. Re-opening the session and sending a message transparently resumes the
existing conversation:

```
User                          Daemon                      Browser
 │                                │                            │
 │  Opens an old session          │                            │
 │  (state: stopped)              │                            │
 │ ────────────────────────────────────────────────────────────►
 │                                │ WS: subscribe sessionId    │
 │                                │ parses on-disk transcript  │
 │                                │ → renders prior messages   │
 │                                │────────────────────────────►
 │  Types a new message           │                            │
 │ ────────────────────────────────────────────────────────────►
 │                                │ WS: session:send           │
 │                                │ adapter resumes the saved  │
 │                                │ conversation id (no spawn) │
 │                                │ session:assistant-delta ──►│
 │  Sees the agent pick up where  │                            │
 │  it left off                   │                            │
```

---

## Key Keyboard Shortcuts

```
┌─────────────────────────────────────────────┐
│  Ctrl+K        Command palette              │
│  Ctrl+T        New terminal                 │
│  Ctrl+W        Close terminal               │
│  Alt+1..9      Switch project               │
│  Alt+S/T/C     Jump to Sessions/Terms/Cmds  │
│  Ctrl+Shift+R  Restart selected command     │
│  Ctrl+Shift+S  Start all                    │
│  Ctrl+Shift+X  Stop all                     │
└─────────────────────────────────────────────┘
```

---

## MVP Build Phases

```
v0.1 Foundation     Daemon + React + single terminal + projects
        │
v0.2 Persistence    SQLite state + Dashboard view + status indicators
        │
v0.3 Git            Diff viewer + rollback + file explorer
        │
v0.4 Agents         Provider adapters (Claude/Codex/Hermes) +
        │           hooks + permissions + options
v0.5 Intelligence   Cost tracking + timeline + search + scratchpad
        │
v0.6 Polish         Conflict detection + CLI + notifications
```

---

## Tech Stack (All TypeScript)

```
Frontend:  React · Vite · xterm.js (commands/terminals) · CodeMirror 6
           (composer) · TailwindCSS · Zustand · cmdk
Backend:   Node.js · Express · ws · node-pty (commands/terminals) ·
           @anthropic-ai/claude-agent-sdk · codex app-server (JSON-RPC) ·
           hermes acp (ACP JSON-RPC) · better-sqlite3 · chokidar · simple-git
CLI:       commander
```
