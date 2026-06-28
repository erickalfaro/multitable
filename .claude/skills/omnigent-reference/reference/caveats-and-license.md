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

## Their Claude/Codex/Cursor strategy is *dual* — and only half of it is "not ours"

omnigent runs each vendor **two ways** (see [`repo-map.md`](repo-map.md) "Two provider layers"):

- **Headless inner harness** (`omnigent/inner/<vendor>_harness.py`) — SDK / ACP / `--print` stream-json. This **matches MultiTable's approach**: their `claude-sdk` harness ≈ our `claude.ts`, their Goose/Qwen ACP ≈ our Hermes/Grok ACP, their `kimi --print` ≈ our Cursor stream-json.
- **Native bridge** (`omnigent/<vendor>_native.py` + `inner/<vendor>_native_harness.py`) — **spawns the vendor TUI in a runner-owned tmux terminal**, injects turns via tmux paste, and captures output by **tailing the JSONL transcript** (`<vendor>_native_forwarder.py`) with reconnect / byte-offset / "cold resume" (`--resume <sid>` + `start_at_end=True`).

It's the **native** layer — not the whole product — that MultiTable deliberately moved off. See `CLAUDE.md` § "Recently retired":

- `claude --resume` PTY spawn — gone
- `/$bunfs/` zombie guards — gone
- `transcripts/tail.ts` / `TranscriptTailerRegistry` — gone

So when comparing, be precise: their **inner harness** is a fair peer to our adapters; their **native bridge** is the TTY-tail pattern we retired (a deliberate "terminal-first / co-drive" feature for them, a removed legacy path for us). Don't "port back" the native bridge without re-reading the retired-feature list and asking why we moved off it.

## Different multi-device model

| | MultiTable | Omnigent |
|---|---|---|
| Daemon visibility | localhost (`127.0.0.1:3000`) | central authenticated server (`server/auth.py` + `oidc.py`) |
| "Phone access" | Telegram bot bridge over the local daemon | OIDC-authenticated mobile client against the central server |
| Multi-machine | not supported | `server/host_registry.py` + `managed_hosts.py` + `presence.py` |
| Co-drive / attach | not supported | `omnigent attach` + presence |

Porting any of `host_registry.py` / `presence.py` would require rethinking our security model — they assume a central authenticated server we don't run.

## Provider taxonomy mismatch

omnigent's vendor set has grown well beyond the old "Claude, Codex, Cursor, Pi" list. Live harnesses (per `_HARNESS_MODULES` + `NATIVE_HARNESSES`): **Claude (`claude-sdk` + `claude-native`), Codex, Cursor, Pi, Goose (ACP), Qwen (ACP), Kimi (`--print`), Hermes, OpenCode, Kiro, OpenAI Agents (`openai-agents`), Copilot (GitHub), Antigravity (Google Gemini SDK).** Most vendors ship a headless harness *and* a `-native` terminal bridge.

MultiTable's vendor set: **Claude, Codex, Cursor, Hermes (xAI/Grok), Grok Build.** (`comingSoon` in our `AddAgentModal`: Gemini CLI, GitHub Copilot, opencode, Amp, Aider, Goose, Pi.)

So omnigent already ships several of *our* `comingSoon` targets (Goose, GitHub Copilot, opencode, Gemini-via-antigravity, Pi) — the overlap is larger than the old skill implied. **But the spellings differ:** omnigent has its own `hermes` harness (not our Hermes/xAI provider) and no "Grok Build". Don't drop "Pi"/"antigravity"/"kiro" into our live code by accident; don't drop "Hermes (xAI/Grok)"/"Grok Build" into omnigent comparisons.

## What's *missing* from omnigent vs us

- No TypeScript/React web UI in their repo (only TUI under `sdks/ui/`).
- No **xAI/Grok** provider in our sense — they have their own `hermes` harness, and no "Grok Build".
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
