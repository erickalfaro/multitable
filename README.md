<p align="center">
  <img src="docs/images/logo.png" width="160" alt="MultiTable logo">
</p>

<h1 align="center">MultiTable</h1>

<p align="center">
  <em>Run Claude Code, Codex, Copilot, and Gemini side by side — plus your dev servers, terminals, and git, all in one app.</em><br/>
  <sub>Because <code>tmux</code> wasn't built for the day Claude, Codex, and <code>npm run dev</code> all need your attention at once.</sub>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node ≥18" src="https://img.shields.io/badge/node-%E2%89%A518-brightgreen">
  <img alt="100% local" src="https://img.shields.io/badge/runs-100%25%20local-success">
  <img alt="v0.9.0" src="https://img.shields.io/badge/version-0.9.0-blue">
</p>

<p align="center">
  <img src="docs/images/demo.gif" alt="MultiTable in action" width="760">
</p>

---

## What is it?

A local, browser-based dashboard for the chaos of agentic coding. A Node.js daemon runs on your machine, drives **Claude Code** and **OpenAI Codex** through their respective SDKs (no PTY screen-scraping), spawns dev servers and shells via [`node-pty`](https://github.com/microsoft/node-pty), and serves a React UI at `http://localhost:3000`. One tab. Every project. Every agent. Every dev server.

Approve permission prompts from your phone over Telegram. Resume any past Claude or Codex thread. See exactly what each agent changed via a per-agent git diff.

**Privacy:** everything runs on your machine. No accounts, no telemetry — only the network calls you opt into (your LLM provider's API, and optionally Telegram).

## Features

- **Multi-agent in one UI.** Claude Code via the Agent SDK; Codex via direct JSON-RPC to `codex app-server`. Both render in the same chat UI; both feed the same permission, diff, and notification plumbing.
- **Approve permissions from your phone.** Optional Telegram bridge forwards `canUseTool` prompts with inline Allow / Deny / Always-Allow buttons. No relay server — your daemon talks to the Bot API directly.
- **Sleek chat UI.** CodeMirror composer with `@file` mentions, `/` slash commands, image attachments. Streaming markdown, shiki code highlighting, collapsible tool cards, live chain-of-thought, live task lists.
- **Modes per agent:** `default`, `plan`, `accept-edits`, `auto`, `chat`, `read-only`. Each adapter translates the right way.
- **Full git panel.** Status, stage, commit composer, branch picker, stash, fetch/pull/push — live-updated by `chokidar` + `simple-git`. Each agent gets a baseline commit so you can see exactly what *it* changed.
- **Live cost + token tracking** per agent, straight from the SDK's result message.
- **Live model picker** (`codex debug models` + Anthropic `/v1/models`).
- **Past Agents browser.** Resume any past Claude or Codex thread from disk — full interop with the official CLIs.
- **Auto-restart with backoff** for commands. File-watch restart for dev servers — edit `src/**/*.ts`, the right process restarts.
- **Notification center.** Per-category + per-severity prefs, OS notifications, tab badges, audio chimes.
- **LAN / Tailscale / mobile.** Bind to `0.0.0.0`, open from your phone or iPad. Touch toolbar built in.
- **Themeable** via CSS variables; **config-as-code** via `mt.yml`; **SQLite persistence** across restarts.

## How it compares

|                                       | tmux / zellij | Warp / Wave | **MultiTable** |
|---------------------------------------|---------------|-------------|----------------|
| Multiple PTYs                         | ✅            | ✅          | ✅             |
| Survives reboot                       | ⚠️            | ❌          | ✅             |
| Per-process auto-restart + file-watch | ❌            | ❌          | ✅             |
| Agent in a chat UI                    | ❌            | ❌          | ✅             |
| **Multi-provider (Claude + Codex)**   | ❌            | ❌          | ✅             |
| **Approve permissions from your phone** | ❌          | ❌          | ✅             |
| **Full in-UI git workflow**           | ❌            | ❌          | ✅             |
| Use from your phone                   | ❌            | ❌          | ✅             |
| 100% local, no account                | ✅            | ❌          | ✅             |

## Install

Pre-npm-publish — install from source. **Prereqs everywhere:** Node ≥18, npm ≥9, Git, and a C/C++ toolchain (`better-sqlite3` and `node-pty` are native modules).

<details>
<summary><strong>macOS</strong></summary>

```bash
xcode-select --install
git clone https://github.com/erickalfaro/multitable.git && cd multitable
npm install && npm run build
cd packages/cli && npm link && cd ../..
```

</details>

<details>
<summary><strong>Linux</strong></summary>

```bash
# Debian / Ubuntu
sudo apt-get install -y build-essential python3 git
# Fedora / RHEL:  sudo dnf install -y gcc-c++ make python3 git
# Arch:           sudo pacman -S --needed base-devel python git

git clone https://github.com/erickalfaro/multitable.git && cd multitable
npm install && npm run build
cd packages/cli && sudo npm link && cd ../..
```

</details>

<details>
<summary><strong>Windows 10 / 11</strong></summary>

Use **PowerShell**, not `cmd.exe`. When installing Node from nodejs.org, check *"Automatically install the necessary tools for native modules."*

```powershell
git clone https://github.com/erickalfaro/multitable.git
cd multitable
npm install
npm run build
cd packages\cli ; npm link ; cd ..\..
```

Known limitation: per-process CPU % shows `0` on Windows (the metrics poller uses Unix `ps`). Memory and state work normally. PR welcome.

</details>

## Quick start

```bash
mt start          # daemon on http://localhost:3000
mt open           # open the UI

# …or dev mode (daemon + Vite HMR):
npm run dev
```

From the dashboard: **+ Add Project** → point at a directory → add an agent (Claude or Codex) or a command (`npm run dev`) → send your first prompt.

## Configure with `mt.yml`

Drop in the root of any project:

```yaml
name: my-project
sessions:
  - name: Claude
    command: claude
    autostart: true
commands:
  - name: npm:dev
    command: npm run dev
    autostart: true
    fileWatchPatterns: ["src/**/*.ts"]
```

## Global config + remote access

`~/.config/multitable/config.yml`:

```yaml
port: 3000
host: 127.0.0.1   # change to 0.0.0.0 for LAN / Tailscale
```

For phone / iPad access: install [Tailscale](https://tailscale.com), set `host: 0.0.0.0`, open `http://<tailscale-hostname>:3000` from any device on your tailnet. **Don't bind `0.0.0.0` outside Tailscale** — the daemon has no auth.

## Auth

- **Claude:** `ANTHROPIC_API_KEY` env var, or `claude login`.
- **Codex:** install `codex-cli`, then `codex login`. The daemon spawns one `codex app-server` child lazily on first Codex turn.
- **Telegram (optional):** set `MULTITABLE_TELEGRAM_BOT_TOKEN` and configure chat IDs in the UI's Integrations panel.

## Roadmap

- [x] **v0.6** Sessions driven by the Claude Agent SDK (no PTY for sessions)
- [x] **v0.7** Multi-provider architecture; Codex as a first-class adapter
- [x] **v0.8** Telegram bridge, full git panel, notification center, elicitation forms, model picker, Past Agents
- [ ] **v0.9** Global keyboard shortcuts, richer search, more adapters (Gemini, Copilot), packaged binaries

## Contributing

> ⚠️ **Not accepting unsolicited PRs right now.** MultiTable is a solo project moving fast — the codebase churns weekly. **Please file an issue first** if you've spotted a bug or have a feature idea, and I'll let you know if a PR would be welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

Please **don't open public issues** for vulnerabilities — see [`SECURITY.md`](SECURITY.md).

## License

MIT — see [`LICENSE`](LICENSE).

---

<p align="center"><sub>Architecture and code-level docs live in <a href="CLAUDE.md">CLAUDE.md</a>.</sub></p>
