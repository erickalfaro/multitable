# Caveats and license

## License (informational only)

omnigent is **Apache-2.0**. This skill notes the license for awareness, but any decision to port code is out-of-scope for this skill. If a future session reaches for omnigent code, that is the moment to revisit license/attribution requirements (preserve copyright notices, add a `NOTICE` line or top-of-file `// Portions adapted from omnigent (Apache-2.0): <url>`).

The skill loading does not, by itself, authorize copying.

## Stack divergence — patterns map, APIs don't

| Axis | MultiTable | Omnigent |
|---|---|---|
| Language | TypeScript (Node.js) | Python 3.12 (~83%) + small TS slice |
| Package manager | npm workspaces | `uv` |
| Backend framework | Express + `ws` | (Python web framework — see `omnigent/server/app.py`) |
| DB | `better-sqlite3` (sync, hand-managed `schema.sql`) | SQLAlchemy + Alembic migrations |
| Frontend | React + Vite + xterm.js + CodeMirror | Rich + prompt_toolkit (TUI only) |
| Distribution | `npm` workspaces, `mt` CLI | PyPI / Homebrew, `omnigent` + `omni` CLIs |

Concept-level patterns (event reducers, approval queues, model overrides) often transfer; literal code does not.

## Their Claude/Codex/Cursor strategy is not ours

`omnigent/claude_native.py`, `codex_native.py`, `cursor_native.py`, `pi_native.py` **spawn the vendor CLI as a subprocess and proxy its TTY over a WebSocket attach loop** (with reconnect, byte-offset resume, "cold resume" handling).

MultiTable deliberately moved off CLI-subprocess+TTY-bridging — see `CLAUDE.md` § "Recently retired":

- `claude --resume` PTY spawn — gone
- `/$bunfs/` zombie guards — gone
- `transcripts/tail.ts` / `TranscriptTailerRegistry` — gone

Our model is SDK-direct (Claude) or JSON-RPC (Codex `app-server`, Hermes/Grok ACP) or stream-json NDJSON (Cursor). When comparing, treat `claude_native.py` as a *different architecture*, not a template — and don't be tempted to "port it back" without re-reading the retired-feature list and asking why we moved off it.

## Different multi-device model

| | MultiTable | Omnigent |
|---|---|---|
| Daemon visibility | localhost (`127.0.0.1:3000`) | central authenticated server (`server/auth.py` + `oidc.py`) |
| "Phone access" | Telegram bot bridge over the local daemon | OIDC-authenticated mobile client against the central server |
| Multi-machine | not supported | `server/host_registry.py` + `managed_hosts.py` + `presence.py` |
| Co-drive / attach | not supported | `omnigent attach` + presence |

Porting any of `host_registry.py` / `presence.py` would require rethinking our security model — they assume a central authenticated server we don't run.

## Provider taxonomy mismatch

omnigent's vendor set: **Claude, Codex, Cursor, Pi, custom.**

MultiTable's vendor set: **Claude, Codex, Cursor, Hermes (xAI/Grok), Grok Build.** (`comingSoon` in our `AddAgentModal`: Gemini CLI, GitHub Copilot, opencode, Amp, Aider, Goose, Pi.)

Don't drop "Pi" references into our live code by accident; don't drop "Hermes"/"Grok Build" references into omnigent comparisons.

## What's *missing* from omnigent vs us

- No TypeScript/React web UI in their repo (only TUI under `sdks/ui/`).
- No `Hermes` / `Grok Build` providers.
- No equivalent of our `~/.multitable/secrets.yml` + Telegram bridge (they solve the same problem with OIDC).

## What's *missing* from us vs omnigent

- No declarative policy engine (`omnigent/policies/`).
- No advisory cost layer (`runner/cost_advisor.py`, `cost_judge.py`).
- No OS sandboxing (`omnigent/sandbox/bwrap.py`, `seatbelt.py`).
- No multi-host registry / presence / attach.
- No cloud sandbox integration (Modal / Daytona / Islo — in their `deploy/`).
- No explicit tool-registration layer (`omnigent/tools/` with `base.py` + `manager.py` + `builtins/`).
- No example agents in-tree (their `examples/Polly`, `examples/Debby`).

These are *gaps observed in comparison* — not roadmap items.
