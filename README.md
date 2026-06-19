<div align="center">

# <img src="docs/images/logo.png" alt="" height="38" valign="middle" /> MultiTable

### The local-first AI agent framework and meta-harness for all your coding agents.

MultiTable is an open-source **AI agent framework** and meta-harness that gives you a common orchestration layer over every coding agent you already use: swap or combine harnesses without rewriting, approve risky actions from anywhere, and keep every project and every agent in one place.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)
![Node ≥18](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![100% local](https://img.shields.io/badge/runs-100%25%20local-success)

</div>

<p align="center">
  <img src="docs/images/demo.gif" alt="MultiTable" width="760">
</p>

---

## Why MultiTable?

MultiTable lets you:

- **📱 Drive agents from any device, including your phone.** The daemon runs
  on your machine and serves a React UI at `http://localhost:3000`. Pair it
  with [Tailscale](https://tailscale.com) and pick up the same project,
  agent, and chat from a laptop, tablet, or phone.

- **🤖 Run multiple agents, side by side.** One agent scaffolds, another
  reviews, a third runs the migration — each in its own session, each with
  its own model, all in one window. Same chat UI, same permission prompts,
  same git view, no matter who's answering.

- **🔌 Use any provider you already pay for.** Bring an API key or sign in
  through the provider's own CLI. MultiTable reuses the credentials on disk —
  no duplicate logins, no token storage of its own.

- **🛡️ Approve risky actions from anywhere.** Permission prompts, MCP
  elicitations, and alerts forward to a Telegram chat with one-tap callback
  buttons — edited in place when you resolve them.

- **🔓 Nothing is locked in.** Past threads from each provider's official
  CLI are listed and resumable. MultiTable reads and writes the same on-disk
  state — your sessions stay yours.

- **🏠 Everything runs locally.** No accounts, no telemetry. The only
  network calls are your LLM provider's API and, if you opt in, Telegram.

---

## Quick start

### 1. Install

Pre-publish — install from source. You need **Node 18+**, **npm 9+**, **Git**, and a C/C++ toolchain (`better-sqlite3` and `node-pty` are native modules).

```bash
git clone https://github.com/erickalfaro/multitable.git && cd multitable
npm install && npm run build
cd packages/cli && npm link && cd ../..
```

<details>
<summary>Platform-specific toolchain notes</summary>

- **macOS** — `xcode-select --install` covers the toolchain.
- **Debian / Ubuntu** — `sudo apt-get install -y build-essential python3 git`.
- **Fedora / RHEL** — `sudo dnf install -y gcc-c++ make python3 git`.
- **Arch** — `sudo pacman -S --needed base-devel python git`.
- **Windows 10 / 11** — use PowerShell, not `cmd.exe`. When installing Node from nodejs.org, check *"Automatically install the necessary tools for native modules."* Then `npm link` from `packages\cli`. Per-process CPU % shows `0` on Windows (the metrics poller uses Unix `ps`) — memory and state work normally.

</details>

> [!NOTE]
> The install puts the `mt` CLI on your PATH. `mt start` runs the daemon; `mt open` opens the UI in your browser.

### 2. Start your first agent

```bash
mt start          # daemon on http://localhost:3000
mt open           # open the UI
```

From the dashboard: **Add Project** → point at a directory → **Add Agent** → pick a provider → send a prompt. Add a long-running command (`npm run dev`, a worker, a watcher) the same way and MultiTable supervises it alongside the agents.

> [!TIP]
> On first run, MultiTable picks up credentials already on disk (an `ANTHROPIC_API_KEY`, a `claude` / `codex` / `cursor-agent` CLI you're logged into, etc.) and lists the providers that are ready to go.

### 3. Choose & switch models

Each session has its own provider and model. Switch mid-conversation from the model picker, or set a default per project in [`mt.yml`](#configure-with-mtyml). MultiTable works with the credential each provider's own CLI uses:

| | Kind | What it is |
|---|---|---|
| 🔑 | **API key** | A first-party vendor key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROK_CODE_XAI_API_KEY`, …) |
| 🎟️ | **Subscription** | A Claude Pro/Max, ChatGPT, Cursor, or xAI plan, via the official provider CLI's `login` command |
| 🤝 | **OAuth** | Provider OAuth flows that drop a token in `~/.<provider>/` (Hermes, Cursor, …) |

Defaults are per provider, so a Claude default and a Codex default coexist.

### 4. Use it from your phone 📱

`~/.config/multitable/config.yml`:

```yaml
port: 3000
host: 127.0.0.1   # change to 0.0.0.0 for LAN / Tailscale
```

Install [Tailscale](https://tailscale.com), set `host: 0.0.0.0`, and open `http://<tailscale-hostname>:3000` from any device on your tailnet. The web UI is built for mobile — chat, permission prompts, git view, and terminals all work on a phone.

> [!WARNING]
> Don't bind `0.0.0.0` outside Tailscale (or another auth layer) — the daemon has no auth of its own.

### 5. Approve from anywhere

Permission prompts, MCP elicitations, and alerts can forward to a Telegram chat with one-tap callback buttons — edited in place when you resolve them.

```bash
export MULTITABLE_TELEGRAM_BOT_TOKEN=...   # or store in ~/.multitable/secrets.yml
```

Then open the **Integrations** panel in the UI, add the chat ID, and pick which event categories forward.

---

## Configure with `mt.yml`

Drop in the root of any project. Agents auto-start, commands auto-start and restart on file changes:

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

---

## Prior art

The neighbourhood is agent harnesses and meta-harnesses. Read these before deciding MultiTable is the right fit:

- **Closest sibling** — [omnigent](https://github.com/omnigent-ai/omnigent) (Python + TS, same multi-provider scope, deeper governance + cloud sandboxes).
- **Harness frameworks** — [Mastra](https://github.com/mastra-ai/mastra), [OpenHarness](https://github.com/HKUDS/OpenHarness), [Strands / Harness SDK](https://github.com/strands-agents/harness-sdk), [VoltAgent](https://github.com/voltagent/voltagent).
- **Parallel-agent runners** — [Claude Squad](https://github.com/smtg-ai/claude-squad), [artificial](https://github.com/AndreBaltazar8/artificial), [OpenCode](https://github.com/sst/opencode), [ruflo](https://github.com/ruvnet/ruflo).
- **Governance & observability** — [Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit), [Cordum](https://github.com/cordum-io/cordum), [CodexBar](https://github.com/steipete/CodexBar).
- **Meta-lists** — [awesome-agent-harness](https://github.com/AutoJunjie/awesome-agent-harness), [awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering).

MultiTable's wedge: the **local-first, browser-driven dashboard** with mobile-grade remote approval — Mastra/OpenHarness without writing TypeScript, Claude Squad with a real UI, CodexBar with the agents themselves. (Not a terminal multiplexer — if your day is one shell, [tmux](https://github.com/tmux/tmux) / [Zellij](https://zellij.dev/) / [Warp](https://www.warp.dev/) are lighter.)

---

## Contributing

Not accepting unsolicited PRs right now — this is a solo project and the codebase churns weekly. File an issue first; see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

Don't open public issues for vulnerabilities — see [`SECURITY.md`](SECURITY.md).

## License

MIT — see [`LICENSE`](LICENSE).

---

<p align="center"><sub>Architecture and code-level docs live in <a href="CLAUDE.md">CLAUDE.md</a>.</sub></p>
