# Permission wiring for Grok Build

Grok asks for tool approval via the ACP **server-request** `session/request_permission`. MultiTable brokers it through the same `PermissionManager` Claude (and the other ACP agent) use, so the user sees the familiar prompt card. Two things matter most: the **nested outcome shape** and the **scope** of what Grok actually asks about.

## ⚠️ Scope: this only fires for calls Grok itself flags

Grok decides which tool calls emit `session/request_permission`. In `code` mode it reads/edits/runs commands automatically, prompting only for calls it deems sensitive; in `plan` mode it shows diffs and asks before writing; in `ask` mode it doesn't write at all. **There is no host-side lever to force-prompt every tool call** over ACP — no `canUseTool`, no host hook (Grok's hooks run Grok-side). If a user reports "Grok did X without asking," that's Grok's gating granularity, not a MultiTable bug, and `handleAcpPermission` was never called (no server-request was sent). The honest options: use `ask`/`plan` mode, or accept Grok's model. See [`../pitfalls.md`](../pitfalls.md) §6. This differs fundamentally from Claude's `canUseTool` — don't reach for it.

## The flow

```
Grok child  ──"session/request_permission" (JSON-RPC server-request, has id+method)──▶
  transport.handleServerRequest
    └─ client.ts onRequest('session/request_permission')
         └─ GrokAdapter.handleAcpPermission(req)
              ├─ acpToMt.get(req.sessionId) → mtSessionId   (unknown → CANCELLED)
              ├─ derive toolName / toolInput / firstLoc from req.toolCall
              ├─ permManager.requestFromSdk(mtSessionId, '', toolName, toolInput, signal,
              │     { title, displayName, blockedPath })
              ├─ result.behavior !== 'allow'  → CANCELLED
              └─ pick an allow optionId → SELECTED { optionId }
  ◀── response: { outcome: { outcome: 'selected', optionId } | { outcome: 'cancelled' } }
```

`req.sessionId` is the **Grok** session id; resolve it to the MultiTable id via the `acpToMt` reverse map (populated in `ensureSessionId`). Unknown id → `CANCELLED` (don't crash; the turn may have been torn down).

## ⚠️ The outcome shape is a NESTED literal

The ACP `RequestPermissionResponse` discriminator is the **inner** `outcome` string, values `'selected'` / `'cancelled'` — **not** `'allowed'`/`'denied'`, **not** a flat object. Make it impossible to get wrong with a union type:

```ts
export type AcpPermissionOutcome =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } };
```

**Returning the wrong shape does not error — it can silently coerce every approval to a deny** (this exact class of bug bit the other ACP adapter as #20: user clicks Allow, nothing happens, agent says it couldn't do the thing). Always return one of the two variants verbatim. **VERIFY** Grok's agent-side parser uses these same literals (the ACP spec does; confirm Grok follows it).

## Mapping the host decision → an ACP optionId

`PermissionManager.requestFromSdk` resolves `{ behavior: 'allow' | 'deny', … }`. On `allow`, pick one of the agent-offered `req.options[]` (each `{ optionId, name?, kind? }`), most-restrictive first:

```
kind === 'allow_once'                        → prefer (most restrictive)
optionId === 'allow_once' (or Grok's id)     → next
first option whose kind is neither reject_once nor reject_always
none → CANCELLED
```

**Always aim for `allow_once`, never `allow_always`/`allow_session`.** Session allowlisting is owned by `PermissionManager` (its `sessionAllowList`): once the user picks "Always Allow," subsequent `requestFromSdk` calls short-circuit to `allow` without re-prompting, and we still answer Grok with `allow_once`. Letting Grok own the "always" state would double-book the allowlist. **VERIFY** Grok's actual `optionId`/`kind` values from a real `session/request_permission` payload and adjust the matcher.

## What we extract from `req.toolCall` (for the prompt card)

| UI field (`PermissionPrompt`) | Source (`VERIFY` field names) | Fallback |
|---|---|---|
| tool name (routing) | `toolCall.kind` → `toolCall.title` | `'grok_tool'` |
| `title` | `toolCall.title` (if string) | `undefined` |
| `displayName` | `toolCall.kind` (if string) | `undefined` |
| `blockedPath` | `toolCall.locations[0].path` | `undefined` |
| tool input | `toolCall.rawInput` (if object) | `{}` |

These feed `ToolInputPreview` in the permission bar — the same component Claude uses.

## The abort caveat (likely v1 limitation)

If ACP doesn't surface an abort signal on `session/request_permission`, `handleAcpPermission` passes a fresh never-aborted controller. Cancelling a turn while a prompt is open leaves it open; a late answer returns a stale `optionId` Grok ignores (the turn already resolved `cancelled`). Accepted for v1 — don't fake an abort (it'd become a deny). If Grok's ACP grows a cancel signal on permission requests, thread `ctrl.signal` through.

## fs / terminal server-requests are rejected by design

Because we advertise `clientCapabilities: { fs:{readTextFile:false,writeTextFile:false}, terminal:false }`, Grok shouldn't send `fs/*`/`terminal/*`. If it does, the handlers **throw** → `-32000`. Don't implement them "to be helpful" — Grok runs file/terminal work under its own workspace-trust/sandbox; brokering them punches a hole in `hardSandbox`. **VERIFY** Grok respects the advertised `false`; if it *requires* host fs, that's a deliberate capability decision to revisit, not a silent implementation.

## `exit_plan_mode` — the plan→execute gate (reuses the permission UI)

A `plan`-mode session (spawned with the full-capability MT plan profile, `permission_mode: plan`) plans first, then calls `exit_plan_mode`, which Grok delegates to the client as the **`_x.ai/exit_plan_mode`** server-request `{ sessionId, toolCallId, planContent }` and **blocks on**. `GrokAdapter.handleExitPlanMode` routes it through `PermissionManager.requestFromSdk(…, 'ExitPlanMode', { plan })` — the same approval UI — so the user reviews the plan:

```
allow → return { outcome: 'approved' } → Grok flips to default and EXECUTES the plan (same session)
deny  → abort the in-flight turn (activeTurnCtrls.get(grokSessionId).abort()), return { outcome: 'rejected' }
auto-mode session → return 'approved' immediately (no prompt)
```

⚠️ **Verified (0.2.2): the `outcome` value does not itself stop Grok** — on *any* reply it proceeds to execute. So the real gate is (a) holding the request until the user decides and (b) **cancelling the turn on deny**. Don't rely on `{outcome:'rejected'}` alone to prevent execution. An unhandled `_x.ai/exit_plan_mode` returns `-32601` and breaks the transition, so the client must register the handler.

## Workspace-trust (VERIFY)

If Grok sends a trust request over ACP for an untrusted directory, route it like a permission/elicitation prompt (surface to the user, return their choice). If instead it silently refuses tools until trust is set, the adapter may need to pre-seed `~/.grok/workspace-trust.json` or pass a trust flag at spawn. Confirm the behavior before wiring — see [`../pitfalls.md`](../pitfalls.md) §9.
