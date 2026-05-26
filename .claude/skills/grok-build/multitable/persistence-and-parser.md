# Persistence & the Grok transcript parser

Grok Build is **local-first** — session history lives under `~/.grok/` (xAI markets "no source code is transmitted to xAI's servers"). MultiTable trusts the on-disk log as "what really happened" and hydrates `Message[]` from it via `transcripts/grokParser.ts`, the same role `codexParser.ts` / `hermesParser.ts` play for their providers.

> **The exact on-disk path and format are `VERIFY`.** Inspect a real session after running `grok` in a repo (look under `~/.grok/`; `grok inspect` may reveal the sessions dir). Don't write the parser against an assumed schema — read a live file first. Everything below is the *shape* of the work, not a confirmed format.

## What the parser produces

`parseGrokSession(...)` → `Message[]`, the **same `Message` union** that `transcripts/parser.ts` (Claude) and the live adapter produce. The chat UI is provider-agnostic; the parser's job is to translate Grok's on-disk records into that union: user messages, assistant messages, `tool_use` / `tool_result` pairs, and (if present) reasoning blocks.

Wire it into:
- `GET /api/sessions/:id/messages` (re-hydration) — [`api/sessions.ts`](../../../../packages/daemon/src/api/sessions.ts) calls the right parser by provider.
- The past-agents browser (`PastAgentsBrowser` / `transcripts` API) — **VERIFY** whether we expose a `GET /api/transcripts/grok` list + `POST /api/transcripts/grok/:id/resume` like Codex/Hermes have. If Grok sessions are resumable by id, mirror that surface.
- Adapter reconciliation — the disk log is the source of truth the adapter diffs in-memory state against.

## Id scheme — decide and keep it consistent

Two id schemes exist and they must be reconcilable:

- **Disk (parser):** something like `grok:<sessionId>:<seq>:<kind>` — chosen by the parser. **VERIFY** whether Grok's on-disk records carry a stable per-event id/seq you can anchor to (Codex has per-event ids enabling `emitMessageRekey`; the other ACP agent's single-file rewrite-on-save format does not, so it dedupes by `toolUseId` scan instead).
- **Live (adapter):** `grok:<grokSessionId|pending>:tool_use:<toolCallId>` / `:assistant:<Date.now()>`.

If the disk format has stable ids → you can do Codex-style canonical-id reconciliation (`emitMessageRekey`). If not → dedupe tool messages by `toolUseId` scan against `s.messages` and skip `emitMessageRekey` (the Hermes approach). **Verify the format before choosing** — don't assume either.

## The replay-flood guard (if `session/load` replays)

If, like other ACP agents, Grok replays full history as `session/update` notifications after `session/load`, you must avoid duplicating what you already hydrated from disk:

- Subscribe to the session **after** `session/load` returns, and/or drain a short window so most replay lands with no listener.
- Drop any `tool_call`/`tool_call_update` whose `toolCallId` is already in `s.messages` (`isHistoricalToolId`).
- Ignore `user_message_chunk` (the manager already has user messages).

**VERIFY** whether Grok actually replays on load, and how much — the guard's parameters depend on it. If Grok's `session/load` is quiet (no replay), you don't need the drain at all.

## Effort-prefix stripping (only if effort is wired)

If [`../reference/models-and-effort.md`](../reference/models-and-effort.md) proves Grok uses a slash-command effort prefix (e.g. some `/...` injected before the user text), the parser must strip it from user messages so old transcripts don't render the prefix as user-typed — and the strip regex must change **in lockstep** with the adapter's prefix format. If effort is `'unsupported'` (the v1 default), there's nothing to strip.

## What we do NOT persist

The adapter never writes Grok's session files — Grok owns `~/.grok/`. MultiTable persists only its own `sessions` row (`agent_provider='grok'`, `agent_session_id`, `mode`, etc.) and the `Message[]` cache it already manages for every provider. Treat `~/.grok/` as read-only ground truth (and remember `~/.grok/auth.json` is in Grok's write-protected set anyway — see [`../reference/xai-auth.md`](../reference/xai-auth.md)).
