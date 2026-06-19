# Cursor persistence & hydration

Cursor writes its own per-project transcripts; MultiTable re-hydrates from them
after a daemon restart (the in-memory `agent.messages` starts empty) and for the
past-agents browser.

## On-disk layout

```
~/.cursor/projects/<encoded-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl
```

- `<encoded-cwd>` = the absolute workspace path with every `:` / `\` / `/`
  replaced by `-` (e.g. `C-Users-132188-Documents-myrepo`).
- The `.jsonl` lines (Anthropic-like message shape):
  ```json
  {"role":"user","message":{"content":[{"type":"text","text":"<user_query>…</user_query>"}]}}
  {"role":"assistant","message":{"content":[
     {"type":"text","text":"…"},
     {"type":"tool_use","name":"Glob","input":{…}}]}}
  {"type":"turn_ended","status":"success"}
  ```
  Assistant `content` interleaves `text` and `tool_use` blocks. There is no
  separate `tool_result` line — tool output is folded into Cursor's own state;
  the parser emits `tool_use` messages and (optionally) a synthetic note.

Cursor also keeps `~/.cursor/chats/<group>/<sessionId>` — **not** used for
hydration (the per-project `agent-transcripts` JSONL is cleaner and matches what
streamed live).

## `cursorParser.ts`

Mirrors `grokParser.ts`:

- `findCursorSessionDir(sessionId, cwd)` — direct lookup at the encoded-cwd path;
  fallback scan across `~/.cursor/projects/*/agent-transcripts/<sessionId>`.
- `parseCursorSession(sessionId, cwd): Message[]` — read the `.jsonl`, map
  `role:user` → `{kind:'user'}`, `role:assistant` text blocks → `{kind:'assistant', model}`,
  `tool_use` blocks → `{kind:'tool_use'}` (strip `<user_query>` / context
  wrappers from user text). Returns the same `Message[]` shape as the other
  parsers.

## Wiring

- `agent/manager.ts` `register()` — add a `provider === 'cursor'` branch calling
  `parseCursorSession(session.agentSessionId, session.workingDir)`.
- `api/sessions.ts` messages endpoint — add a `cursor` re-hydration branch
  mirroring the grok one (in-memory empty → parse from disk).
