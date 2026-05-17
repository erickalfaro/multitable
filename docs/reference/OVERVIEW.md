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
│  │ AI agent runs     │  │ Dev servers,      │  │ Ad-hoc     ││
│  │ (Claude, Codex,   │  │ queue workers,    │  │ shells     ││
│  │  Aider, etc.)     │  │ build watchers    │  │ (Ctrl+T)   ││
│  │                   │  │                   │  │            ││
│  │ Tracked: cost,    │  │ Auto-start,       │  │ No config  ││
│  │ tokens, diffs,    │  │ auto-restart,     │  │ needed     ││
│  │ timeline          │  │ file-watch restart │  │            ││
│  └───────────────────┘  └───────────────────┘  └────────────┘│
└──────────────────────────────────────────────────────────────┘
```

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Browser (any device: laptop, iPad, phone)  │
│  ┌───────────────────────────────────────┐  │
│  │         React + xterm.js UI           │  │
│  └──────────┬──────────────┬─────────────┘  │
│        REST API        WebSocket             │
└─────────────┼──────────────┼────────────────┘
              │   localhost   │
┌─────────────┼──────────────┼────────────────┐
│  mt daemon (Node.js)       │                 │
│  ┌──────────┐  ┌───────────┴──┐              │
│  │ Express  │  │ ws (streams)  │              │
│  └──────────┘  └──────────────┘              │
│  ┌──────────┐  ┌──────────────┐              │
│  │ node-pty │  │ SQLite (state)│              │
│  └──────────┘  └──────────────┘              │
│  ┌──────────┐  ┌──────────────┐              │
│  │ chokidar │  │ simple-git   │              │
│  │ (watch)  │  │ (diffs)      │              │
│  └──────────┘  └──────────────┘              │
│                                              │
│  REST  = CRUD for projects/sessions/commands │
│  WS    = terminal I/O, state changes, metrics│
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
│  ┌─────────┐ │    • Terminal output (xterm.js)               │
│  │my-projct│ │    • Dashboard (project cards grid)           │
│  │─────────│ │    • Project Overview (settings cards)        │
│  │SESSIONS │ │    • Session Detail (diffs, timeline, cost)   │
│  │ ● Claude│ │                                               │
│  │ ● Codex │ │  ┌──────────────────────────────────────┐     │
│  │TERMINALS│ │  │                                      │     │
│  │ ● Term 1│ │  │  $ claude                            │     │
│  │COMMANDS │ │  │  > I'll help you refactor the API... │     │
│  │ ● npm   │ │  │  Reading src/api/routes.ts...        │     │
│  │ ● Queue │ │  │  █                                   │     │
│  │─────────│ │  │                                      │     │
│  │Project 2│ │  └──────────────────────────────────────┘     │
│  │Project 3│ │                                               │
│  └─────────┘ │                                               │
├──────────────┴───────────────────────────────────────────────┤
│  [Focus][Pause][Clear][Stop][Restart]   CPU 2.1%  MEM 43MB  │
└──────────────────────────────────────────────────────────────┘
```

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

## Permission System (Claude Code)

```
┌──────────────────────────────────────────────────────────────┐
│  MAIN PANE (terminal)                                        │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  $ claude                                            │    │
│  │  > I need to edit src/api/routes.ts                  │    │
│  │  ...waiting for permission...                        │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─ Permission Request ────────────────────────────────────┐ │
│  │  Claude Code wants to use: Edit                         │ │
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
 │                                │ spawns PTYs via node-pty   │
 │                                │ streams output via WS      │
 │                                │────────────────────────────►
 │  Sidebar shows green dots      │                            │
 │  for all running processes     │                            │
```

### Flow 2: Daily Workflow — Multiple AI Agents

```
User                          Daemon                      Browser UI
 │                                │                            │
 │  $ mt start                    │                            │
 │ ──────────────────────────────►│                            │
 │                                │ reads mt.yml               │
 │                                │ autostarts:                │
 │                                │   • Claude Code            │
 │                                │   • npm:dev                │
 │                                │   • Queue worker           │
 │                                │────────────────────────────►
 │                                │                            │
 │  Opens browser                 │                            │
 │  Clicks "Claude Code" session  │                            │
 │ ────────────────────────────────────────────────────────────►
 │                                │ WS: subscribe claude_id    │
 │                                │ sends scrollback + output  │
 │                                │────────────────────────────►
 │                                │                            │
 │  Types prompt to Claude        │                            │
 │ ────────────────────────────────────────────────────────────►
 │                                │ WS: pty-input → PTY stdin  │
 │                                │                            │
 │                                │ Claude wants to Edit file  │
 │                                │ hook: PreToolUse fires     │
 │                                │◄────────────────────────────
 │                                │                            │
 │  Sees Permission card          │                            │
 │  Clicks [Allow]                │                            │
 │ ────────────────────────────────────────────────────────────►
 │                                │ WS: permission:respond     │
 │                                │ releases held HTTP response│
 │                                │ Claude proceeds with edit  │
 │                                │────────────────────────────►
 │                                │                            │
 │  Meanwhile, checks npm:dev     │                            │
 │  by clicking it in sidebar     │                            │
 │ ────────────────────────────────────────────────────────────►
 │                                │ WS: unsubscribe claude     │
 │                                │ WS: subscribe npm_dev      │
 │                                │ sends npm output           │
 │                                │────────────────────────────►
 │  Sees dev server output        │                            │
```

### Flow 3: Process Crashes and Auto-Restarts

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
│  Queue       ● running     │    │  Can view terminals           │
│                            │    │  Can approve permissions      │
└────────────────────────────┘    └──────────────────────────────┘
```

### Flow 6: Claude Code Session Resume

```
User                          Daemon                      Browser
 │                                │                            │
 │  Claude Code session idle      │                            │
 │  (PTY alive, Claude exited)    │                            │
 │                                │                            │
 │  Clicks [Resume] button        │                            │
 │ ────────────────────────────────────────────────────────────►
 │                                │ POST /sessions/:id/resume  │
 │                                │ writes to PTY:             │
 │                                │ "claude --resume abc123\r" │
 │                                │                            │
 │                                │ Claude reconnects to       │
 │                                │ previous conversation      │
 │                                │────────────────────────────►
 │  Sees Claude pick up where     │                            │
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
│  Ctrl+Shift+R  Restart selected process     │
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
v0.4 Claude Code    Hooks + permissions + options + resume + respawn
        │
v0.5 Intelligence   Cost tracking + timeline + search + scratchpad
        │
v0.6 Polish         Conflict detection + CLI + notifications
```

---

## Tech Stack (All TypeScript)

```
Frontend:  React · Vite · xterm.js · TailwindCSS · Zustand · cmdk
Backend:   Node.js · Express · ws · node-pty · better-sqlite3 · chokidar · simple-git
CLI:       commander
```
