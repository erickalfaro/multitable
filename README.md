<p align="center">
  <img src="docs/images/logo.png" width="160" alt="MultiTable logo">
</p>

<h1 align="center">MultiTable</h1>

<p align="center">
  <img src="docs/images/demo.gif" alt="MultiTable" width="760">
</p>

## What it is

MultiTable is a local web app that puts every coding agent and every project behind
one interface. A Node.js daemon runs on your machine and drives Claude Code, OpenAI
Codex, and Hermes (xAI Grok) through one unified contract — same chat UI, same
permission prompts, same git diff, same notifications, regardless of which agent is
answering. Copilot and Gemini are next.

The point is context switching. Real work means jumping between several repos and,
increasingly, between several agents — Claude on one task, Codex on another, a dev
server and a shell open the whole time. MultiTable keeps all of it in one place: pick a
project, pick an agent, send a prompt; switch to another project and another agent
without losing any of the others. Past threads from the official Claude/Codex/Hermes
CLIs are listed and resumable — MultiTable reads and writes the same on-disk state, so
nothing is locked in.

It serves a React UI at `http://localhost:3000`. Because it's a web app it runs the
same on macOS, Linux, and Windows, and if you host the daemon on a machine you can
reach (a home server, a VPS, Tailscale) you can drive your agents from a phone or
tablet — including approving permission prompts remotely over Telegram.

Everything runs locally. No accounts, no telemetry — the only network calls are your
LLM provider's API and, if you opt in, Telegram.

## Prior art

Terminal multiplexers and modern terminals already solve part of this well —
[tmux](https://github.com/tmux/tmux), [Zellij](https://zellij.dev/),
[Warp](https://www.warp.dev/), [soloterm](https://soloterm.com/). MultiTable isn't
trying to be a better terminal. It's aimed at the newer problem: several coding agents,
across several projects, each with their own permission and review flow, that you need
to move between quickly. If your day is mostly one shell, those tools are lighter and
probably enough.

## Install

Pre-publish — install from source. Everywhere you need Node ≥18, npm ≥9, Git, and a
C/C++ toolchain (`better-sqlite3` and `node-pty` are native modules).

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

Use PowerShell, not `cmd.exe`. When installing Node from nodejs.org, check
"Automatically install the necessary tools for native modules."

```powershell
git clone https://github.com/erickalfaro/multitable.git
cd multitable
npm install
npm run build
cd packages\cli ; npm link ; cd ..\..
```

Known limitation: per-process CPU % shows `0` on Windows (the metrics poller uses Unix
`ps`). Memory and state work normally.

</details>

## Quick start

```bash
mt start          # daemon on http://localhost:3000
mt open           # open the UI

# …or dev mode (daemon + Vite HMR):
npm run dev
```

From the dashboard: Add Project → point at a directory → add an agent (Claude, Codex,
or Hermes) or a command (`npm run dev`) → send a prompt.

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

For phone / tablet access: install [Tailscale](https://tailscale.com), set
`host: 0.0.0.0`, open `http://<tailscale-hostname>:3000` from any device on your
tailnet. Don't bind `0.0.0.0` outside Tailscale — the daemon has no auth.

## Auth

- Claude — `ANTHROPIC_API_KEY` env var, or `claude login`.
- Codex — install `codex-cli`, then `codex login`.
- Hermes — `hermes login` (xAI OAuth).
- Telegram (optional) — set `MULTITABLE_TELEGRAM_BOT_TOKEN` and configure chat IDs in
  the UI's Integrations panel.

## Contributing

Not accepting unsolicited PRs right now — this is a solo project and the codebase
churns weekly. File an issue first; see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

Don't open public issues for vulnerabilities — see [`SECURITY.md`](SECURITY.md).

## License

MIT — see [`LICENSE`](LICENSE).

---

<p align="center"><sub>Architecture and code-level docs live in <a href="CLAUDE.md">CLAUDE.md</a>.</sub></p>
