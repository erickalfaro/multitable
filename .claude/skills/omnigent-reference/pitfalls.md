# Pitfalls when working with omnigent as a reference

Hard-won mistakes to avoid when consulting this skill.

## 1. omnigent is not a MultiTable provider

There is no omnigent adapter under `packages/daemon/src/agent/providers/` and there should not be. Don't write code that imports, references, or pretends to interop with omnigent. This skill is for comparison; everything else is out-of-scope.

## 2. Don't pattern-match "they spawn `claude`, so let's spawn `claude`"

`omnigent/claude_native.py` (and `codex_native.py`, `cursor_native.py`, `pi_native.py`) spawn the vendor CLI as a subprocess and bridge its TTY over WebSocket. We deliberately *moved off that pattern* — see `CLAUDE.md` § "Recently retired" (`claude --resume` PTY spawn, `'No conversation found'` / `/$bunfs/` zombie guards, `transcripts/tail.ts`, etc.).

If a future task seems to want CLI subprocess bridging, that's a red flag — re-read the retired-feature list before doing anything.

## 3. Don't conflate `omnigent/llms/` with `omnigent/<vendor>_native.py`

Two completely different layers:

- `omnigent/llms/` — direct LLM **HTTP API** adapters (Anthropic, OpenAI, etc.). Mirrors `openai-python` / `@anthropic-ai/sdk` patterns.
- `omnigent/<vendor>_native.py` — **CLI subprocess bridges** that spawn the *Claude Code / Codex / Cursor / Pi binary* and attach to its TTY.

A question like "how does omnigent talk to Claude?" has two correct answers depending on which one the user means.

## 4. Cloud sandbox backends are in `deploy/`, not `omnigent/sandbox/`

`omnigent/sandbox/` contains only **OS-level** sandbox primitives (`bwrap.py` for Linux, `seatbelt.py` for macOS). The README's pitch about Modal / Daytona / Islo cloud sandboxes refers to deployment-side wiring under the top-level `deploy/` directory. Don't search `omnigent/sandbox/` for `modal_*.py` — it isn't there.

## 5. Their multi-device model assumes a central authenticated server

`omnigent/server/host_registry.py`, `managed_hosts.py`, and `presence.py` all assume an OIDC-authenticated central server that registers multiple machines for a single user. MultiTable runs a localhost daemon and reaches the phone via a Telegram bot bridge. "Porting presence" is not a small refactor — it requires the whole authenticated-server foundation underneath.

## 6. Provider taxonomy mismatch

- **omnigent** ships: Claude, Codex, Cursor, Pi, custom.
- **MultiTable** ships: Claude, Codex, Cursor, Hermes (xAI/Grok), Grok Build. (`comingSoon`: Gemini CLI, GitHub Copilot, opencode, Amp, Aider, Goose, Pi.)

Don't accidentally introduce a "Pi" reference into our live code while comparing notes, and don't reference Hermes / Grok Build when describing omnigent.

## 7. This skill is read-only reference

If a future task ends up wanting to port code from omnigent (Apache-2.0 makes that legally possible), treat that as a **separate decision**:

1. Confirm with the user.
2. Re-read [`reference/caveats-and-license.md`](reference/caveats-and-license.md) for attribution requirements.
3. Translate behavioral patterns, not literal Python — the stacks don't match.

Loading this skill is **not** authorization to copy code.
