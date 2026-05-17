# Hydration & the `session/load` replay flood

Two separate mechanisms put Hermes history on screen: **disk hydration** (we parse Hermes' own session JSON) and the **ACP replay** Hermes pushes after `session/load`. They overlap, so the adapter actively de-duplicates. This is the area behind #18 (parser) and #21 (replay suppression).

## Disk hydration — `hermesParser.ts`

Hermes persists each ACP session as a **single JSON file** at `~/.hermes/sessions/session_<sessionId>.json`, in **OpenAI chat-completions shape**: a flat `messages: ChatMessage[]` with roles `user` / `assistant` / `tool`. This is *not* JSONL and *not* an append log — it's the whole conversation rewritten.

`findHermesSessionFile(sessionId)`:
1. direct: `~/.hermes/sessions/session_<sessionId>.json`
2. fallback: scan the dir for any `session_*.json` whose name *contains* the id (Hermes files some under a timestamped prefix `session_<ts>_<id>.json` when not given an explicit id)
3. dir missing → `[]` (Hermes never ran here)

`parseHermesSession` → `Message[]`:

| Hermes role | Produces |
|---|---|
| `user` | one `user` Message — **after** stripping a leading `/reasoning <level>` prefix (we injected it; see [`../reference/reasoning-effort.md`](../reference/reasoning-effort.md)); a message that was *only* the prefix is dropped; empty content skipped |
| `assistant` | `reasoning` Message (from `reasoning_content`, if any) **then** `assistant` Message (from `content`) **then** a `tool_use` Message per `tool_calls[]` (args JSON-parsed; `parentId` links to the assistant text) — in that order so scrollback matches the live streaming order |
| `tool` | one `tool_result` Message keyed by `tool_call_id` |
| `system` / unknown | skipped (system prompts aren't shown) |

**Timestamps are interpolated.** Hermes stamps only the *file* (`session_start` / `last_updated`), not individual messages. The parser spreads messages linearly across that span (`span = max(end-start, raw.length)`, ≥1ms/slot; `raw.length <= 1` → all at `start`). Don't trust Hermes message timestamps to be real — they're synthetic ordering aids.

## Where hydration is wired

| Call site | When |
|---|---|
| [`agent/manager.ts`](../../../../packages/daemon/src/agent/manager.ts) `register()` (~L233) | on daemon boot / session register: `provider === 'hermes' && agentSessionId` → `parseHermesSession` populates `s.messages` |
| [`api/sessions.ts`](../../../../packages/daemon/src/api/sessions.ts) (~L309) | `GET /api/sessions/:id/messages` re-hydrates if the in-memory cache is empty |

So by the time a turn runs against a resumed session, `s.messages` **already contains the full prior conversation** from disk. That's the premise the replay suppression depends on.

## The replay flood (#21)

Hermes schedules `_replay_session_history` (`acp_adapter/server.py`) to run **after `session/load` returns**. It re-emits every persisted user/assistant/tool message as `session/update` notifications so Zed-style fresh UIs can rebuild history from nothing. MultiTable does **not** start from nothing — we hydrated from disk — so unsuppressed replay = every message duplicated in the UI.

Two guards, both load-bearing:

### Guard 1 — the 500ms drain window (`ensureSessionId`)

```ts
if (loaded) await new Promise<void>((r) => setTimeout(r, 500));
```

`ensureSessionId` sleeps 500ms **after `session/load` resolves and before returning** to `runTurn`. `runTurn` only `subscribe()`s *after* `ensureSessionId` returns. During the sleep there is **no listener registered for that session id**, so `client.dispatchNotification` finds `listeners.get(sessionId) === undefined` and drops the replay silently. Most replay lands inside this window. Don't move the `subscribe()` call before `ensureSessionId`, and don't remove the sleep.

### Guard 2 — tool-id dedupe (`isHistoricalToolId`)

For replay that arrives *after* the 500ms window (large histories), `handleNotification` drops any `tool_call` / `tool_call_update` whose `toolCallId` already exists as a `tool_use` Message in `s.messages`:

```ts
function isHistoricalToolId(s, toolUseId) {
  for (const m of s.messages) if (m.kind === 'tool_use' && m.toolUseId === toolUseId) return true;
  return false;
}
```

Linear scan is fine — histories are bounded by the ACP context window and this only runs on tool notifications. This works because the **`toolUseId`/`tool_call_id` is stable** across the disk JSON and the ACP replay (Hermes persists and replays the same id).

### Guard 3 — `user_message_chunk` is ignored outright

`handleNotification`'s `user_message_chunk` case is a bare `return`. It fires *only* during replay; the manager already has user messages from hydration / prior turns.

## Residual risk you should know about

The id schemes are **not** identical across the two paths (unlike Codex, where live ids and parser ids match exactly):

- parser mints `hermes:<session_id>:m<seq>:<kind>`
- live adapter mints `hermes:<agentSessionId|pending>:tool_use:<toolCallId>` / `:tool_result:<toolCallId>` / `:assistant:<Date.now()>`

So tool de-dup relies on **`toolUseId` matching** (Guard 2), *not* canonical-id equality, and there is **no rekey** (`emitMessageRekey` is unused for Hermes). The one gap: a stray `agent_message_chunk` from *assistant* replay that lands **after** the 500ms window has no id-based guard — it would append to `buffers.assistantText`. This is why the drain window exists and why it's 500ms (empirically enough for typical histories). If you see duplicated *assistant text* (not tool calls) after resuming a very long Hermes session, the fix is the drain window / a buffer guard — **not** a new rekey scheme. Before "improving" the id scheme to match Codex's, note that Hermes' single-file rewrite-on-save persistence makes a per-turn-index canonical id (Codex's trick) impossible: there are no turn boundaries or per-event ids in the Hermes session JSON.

## If you add a new persisted `session/update` kind

Mirror it in **both** `handleNotification` (live) **and** `parseHermesSession` (disk), and make sure whatever stable id Hermes persists is what you de-dupe on. If the new kind has no stable cross-path id, it needs a drain-window-style guard, not id matching.
