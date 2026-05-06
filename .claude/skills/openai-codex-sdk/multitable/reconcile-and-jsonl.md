# Why MultiTable reconciles from disk after every Codex turn

## The problem

The Codex SDK's `runStreamed()` event stream is best-effort. We've seen cases where:

- An `item.completed` arrives with malformed payload that throws in our handler — we log and continue, but the message is now missing from `s.messages`.
- The async generator ends without `turn.completed` (subprocess crash, network glitch on Azure-hosted endpoints, signal received).
- A patch's `file_change` item never gets a final `item.completed` event but the patch *did* apply on disk (codex flushed the rollout but lost the live event).

In every case, the **on-disk JSONL** at `~/.codex/sessions/.../rollout-*.jsonl` is the codex CLI's own authoritative log — it shows what really happened. The live event stream is a convenience.

## The reconciliation contract

After every Codex turn (success, failure, or abort), we:

1. Wait 250ms for the codex CLI to flush its rollout.
2. Parse the rollout file via `parseCodexThread(threadId)`.
3. Diff against `s.messages` (in-memory).
4. Emit any missing items via the same WS channels as the live stream (`session:assistant-message`, `session:tool-event`, `session:user-message`).
5. Emit `session:reconciled` with the list of added message ids so the frontend can confirm the sync happened.

This is implemented at [`packages/daemon/src/agent/providers/codex.ts:150-239`](../../../../packages/daemon/src/agent/providers/codex.ts#L150-L239).

The 250ms delay is invisible behind the UI's "agent done" toast and gives the codex CLI time to flush. It's tunable via `RECONCILE_DELAY_MS` at the top of the file.

## Why id alignment is critical

If the live stream and the parser produce different ids for the same item, dedupe falls apart:

- The live stream pushed `codex:abc:t0:msg:0` into `s.messages`.
- The parser reads the JSONL and produces `codex:abc:t0:msg:0` (identical) → dedupe trivially skips it.

If they didn't match (e.g. parser used `item_3` from the JSONL while the live stream minted `codex:abc:t0:msg:0`), every turn would re-emit every assistant message a second time after reconciliation.

The id format `codex:{threadId}:t{turnIndex}:{kind}:{seq}` is shared by:

- [`packages/daemon/src/agent/providers/codex.ts`](../../../../packages/daemon/src/agent/providers/codex.ts) — `codexCanonicalId()` import + `nextSeq()` calls.
- [`packages/daemon/src/transcripts/codexParser.ts`](../../../../packages/daemon/src/transcripts/codexParser.ts) — `parseCodexThread()` mints the same ids from the JSONL.

If you change either, you must change both. There's no automated test guarding this; manual verification is "send a turn, kill the daemon mid-turn, restart, see no duplicates after reconcile."

## The optimistic-user-message rekey

The manager pushes the user's prompt as a `user`-kind message **before** the SDK runs, with id `turn-${ts}-${rand}`. The reconciliation pass finds the disk version (id `codex:{threadId}:t{turnIndex}:user:0`) and:

1. Matches on text content + position (only one user message per turn for codex).
2. Replaces the in-memory id with the canonical disk id.
3. Emits `session:message-rekeyed { oldId, newId }` so the frontend updates its store id in place.

After this, every layer (in-memory, disk, WS, REST) agrees on the same id. See [`packages/daemon/src/agent/providers/codex.ts:186-203`](../../../../packages/daemon/src/agent/providers/codex.ts#L186-L203).

If you add a new optimistic message, add a parallel rekey rule, or you'll get duplicates on every reconcile.

## Race: reconcile after session removal

⚠️ **Known race** — see [`known-bugs.md`](known-bugs.md) entry "Reconcile may emit messages for a deleted session."

The 250ms delay between stream-end and reconcile creates a window where:

1. Stream ends. `scheduleReconcile()` sets `state.reconcileTimer = setTimeout(reconcileTurn, 250)`.
2. User deletes the session at, say, 100ms in. `manager.remove()` calls `codexAdapter.reset(s)`, which clears the timer.

In *that* sequence, no problem. But:

3. If `reconcileTurn` is *already executing* at the moment of removal (e.g. it fired between step 1 timer arming and the user's delete click), `s` is captured in the closure and we'll emit messages for a session no longer in the manager.

Mitigation in our code today: the closure-captured `s` is still valid (it's the same object reference); the daemon will `cb.emitAssistantMessage(...)` for it; `server.ts` broadcasts the WS event; the frontend's store ignores it because there's no session with that id. So it's a wasted broadcast but not a correctness bug.

Hardening idea: in `reconcileTurn`, check if the manager still has `s` registered before emitting. Not yet implemented; add a single `if (!agentManager.get(sessionId)) return;` at the top if this becomes a problem.

## When NOT to reconcile

- Brand new session, first turn just succeeded with `thread.started` arriving and a single `agent_message` — reconcile finds the same item, no-op. Cost: one disk read + JSON parse. Cheap, but if you're chasing latency budgets in a future load-test, the no-op case is the place to optimize.
- Session was reset (`/clear`). The `agentSessionId` is `null` so `reconcileTurn` early-exits at line 174.
- Codex thread fails before `thread.started`. No `agentSessionId` to look up; same early-exit.

## What this is NOT

- It is **not** a substitute for handling live events correctly. If you start dropping `item.completed` events on the floor, "the reconcile will catch it" is a band-aid that hides real bugs.
- It is **not** a replay-from-disk on connection. That's `parseCodexThread()` called from `register()` (DB hydration) and `/api/sessions/:id/messages` (REST refresh). Different code path; same parser.
- It is **not** the source of truth for `Usage`. Token counts come from `turn.completed.usage`. The JSONL has token records but we don't currently parse them for cost — the live event is canonical for usage.
