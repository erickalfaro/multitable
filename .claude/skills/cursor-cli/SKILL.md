---
name: cursor-cli
description: >-
  Authoritative reference for working on MultiTable's Cursor provider, driven by
  the Cursor CLI (`cursor-agent`) in headless `--print --output-format
  stream-json` mode. Trigger when the user mentions Cursor, cursor-agent, the
  Cursor adapter, CursorAdapter, stream-json / NDJSON events, `--resume` /
  `--continue`, `--mode plan|ask`, `--force` / `--yolo`, `--sandbox`,
  composer-2.5, `cursor-agent models`, `~/.cursor`, agent-transcripts, usage
  limits / rate limits (why they're off for Cursor; the cursor.com billing
  out-of-band path), or modifying anything under
  `packages/daemon/src/agent/providers/cursor.ts`,
  `packages/daemon/src/agent/providers/cursor-cli/`, or
  `packages/daemon/src/transcripts/cursorParser.ts`.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

# Cursor CLI provider (`cursor-agent`)

This skill is **strictly Cursor-only**. Do **not** import other providers' SDK or
protocol concepts (ACP `session/prompt`, Codex `app-server` JSON-RPC, the Claude
Agent SDK `query()` loop) into Cursor code or docs — Cursor speaks its own
headless NDJSON contract. See `[[feedback_separate_sdks]]`.

## The one fact that shapes everything

**MultiTable drives Cursor as a one-shot child process per turn.** Each turn
spawns `cursor-agent --print --output-format stream-json --stream-partial-output …
"<prompt>"`, reads newline-delimited JSON (NDJSON) events from stdout until the
terminal `{"type":"result"}` line, then the child exits. There is **no
long-lived child, no JSON-RPC, no persistent stdio session** (unlike Hermes/Grok
ACP or the Codex app-server).

Continuity across turns is by **session id**: the first turn's
`{"type":"system","subtype":"init", session_id}` line gives the id; every
subsequent turn re-spawns with `--resume <session_id>`, which replays full
context. Abort = kill the child.

## Auth, in one line

`cursor-agent` reads its own login state from `~/.cursor` (written by
`cursor-agent login`) or `CURSOR_API_KEY`. The adapter inherits `process.env`;
missing creds fail the first turn. `cursor-agent status` prints the logged-in
account.

## Task → file map

| Task | File |
| --- | --- |
| Adapter (turn loop, capabilities, modes) | `packages/daemon/src/agent/providers/cursor.ts` |
| Spawn + NDJSON line reader, executable resolver | `packages/daemon/src/agent/providers/cursor-cli/runner.ts` |
| Stream-json event TS types | `packages/daemon/src/agent/providers/cursor-cli/events.ts` |
| Mode/model/resume → CLI flags | `packages/daemon/src/agent/providers/cursor-cli/args.ts` |
| Transcript hydration (restart / past-agents) | `packages/daemon/src/transcripts/cursorParser.ts` |
| Model discovery (`cursor-agent models`) | `packages/daemon/src/providers/discovery.ts` → `discoverCursor` |
| Seed catalog | `packages/daemon/src/providers/baselines.ts` → `CURSOR_BASELINE` |
| Adapter registration + hydration branch | `packages/daemon/src/agent/manager.ts` |

## Deep dives

- `reference/protocol.md` — the full stream-json event union + `tool_call` shape.
- `reference/modes.md` — `plan` / `ask` / default / `force`, sandbox, allowlist.
- `reference/models.md` — `cursor-agent models` parsing; effort-in-model-id.
- `reference/auth.md` — login / `CURSOR_API_KEY` / `~/.cursor`.
- `reference/usage-limits.md` — **why usage limits are off** and the out-of-band path.
- `multitable/adapter.md` — adapter architecture + capabilities rationale.
- `multitable/persistence.md` — on-disk transcript layout + `cursorParser`.
- `pitfalls.md` — the traps (Windows `.cmd`, double-counted deltas, …).
