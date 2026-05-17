# Permission wiring — and the bug that silently denied everything

Hermes asks for tool approval via the ACP **server-request** `session/request_permission`. MultiTable brokers it through the same `PermissionManager` Claude uses, so the user sees the familiar prompt card. This path has bitten us once badly (#20) — read the outcome-shape section before touching anything here.

## ⚠️ Scope: this only fires for commands Hermes itself flags

Before reading the flow: the wiring below is **only invoked when Hermes decides a command is dangerous**. Hermes' `tools/approval.py` runs `detect_dangerous_command` against a hardcoded `DANGEROUS_PATTERNS`/`HARDLINE_PATTERNS` list; anything not matched runs with no `session/request_permission` at all — the host never sees it and cannot gate it. `rm -r`/`rm /` are flagged; `rm -f foo.py`, `mv`, `>file`, `git reset` are not. With `approvals.mode: smart` even flagged commands may be auxiliary-LLM-auto-approved before reaching us. There is **no** host-side way to force-prompt every tool call (no hooks, no `canUseTool`, no sandbox enum, `approvals.mode` is config-file-only). This differs fundamentally from Claude's `canUseTool`. Full detail + the user-facing options in [`../pitfalls.md`](../pitfalls.md) §10b — read it before "fixing" a "Hermes didn't ask" report.

## The flow

```
Hermes child  ──"session/request_permission" (JSON-RPC server-request, has id+method)──▶
  transport.handleServerRequest
    └─ client.ts onRequest('session/request_permission')
         ├─ permissionHandler wired? (always, in MultiTable)
         │    └─ HermesAdapter.handleAcpPermission(req)
         │         ├─ acpToMt.get(req.sessionId) → mtSessionId   (unknown → CANCELLED)
         │         ├─ derive toolName / toolInput / firstLoc from req.toolCall
         │         ├─ permManager.requestFromSdk(mtSessionId, '', toolName,
         │         │     toolInput, signal, { title, displayName, blockedPath })
         │         ├─ result.behavior !== 'allow'  → CANCELLED
         │         └─ pick an allow optionId → SELECTED { optionId }
         └─ no handler (standalone/tests) → pickPermissionOption(options, policy)
  ◀── response: { outcome: { outcome: 'selected', optionId } | { outcome: 'cancelled' } }
```

`req.sessionId` is the **Hermes** session id; `handleAcpPermission` resolves it to the MultiTable session id via the `acpToMt` reverse map (populated in `ensureSessionId`). An unknown id → `CANCELLED` (don't crash; the turn may have been torn down).

## ⚠️ The outcome shape is a NESTED literal (the #20 bug)

The ACP `RequestPermissionResponse` discriminator is the **inner** `outcome` string, and the values are `'selected'` / `'cancelled'` — **not** `'allowed'`/`'denied'`, **not** a flat object. Our type makes it impossible to get wrong if you use it:

```ts
export type AcpPermissionOutcome =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } };
```

The agent side is a Pydantic union (`AllowedOutcome` vs `DeniedOutcome`) keyed on that inner literal. **Returning the wrong shape does not error — it silently coerces every approval to a deny.** Bug #20 ("approvals were silently denied") was exactly this: the user clicked Allow, we returned a malformed/flat outcome, Hermes parsed it as the deny branch, and the tool never ran. Symptom to recognize: user approves, nothing happens, agent says it couldn't do the thing. Always return one of the two variants above verbatim.

## Mapping the host decision → an ACP optionId

`PermissionManager.requestFromSdk` resolves with `{ behavior: 'allow' | 'deny', … }`. On `allow`, the adapter must pick one of the agent-offered `req.options[]` (each `{ optionId, name?, kind? }`). Option ids are agent-defined and may vary, so the adapter matches defensively, most-restrictive first:

```
kind === 'allow_once'        →  prefer (most restrictive)
kind === 'allow_always'
optionId === 'allow_once'    →  Hermes' canonical id names
optionId === 'allow_session'    (acp_adapter/permissions.py)
optionId === 'allow_always'
first option whose kind is neither 'reject_once' nor 'reject_always'
none → CANCELLED
```

**We always aim for `allow_once`, never `allow_always`/`allow_session`.** "Always Allow" / session allowlisting is owned by `PermissionManager` (its `sessionAllowList`): once the user picks Always Allow, subsequent `requestFromSdk` calls short-circuit to `allow` *without re-prompting*, and we still answer Hermes with `allow_once`. Letting Hermes own the "always" state would double-book the allowlist and the two could disagree. Keep allowlist logic in `PermissionManager`, not in the ACP option choice.

## The abort caveat (known v1 limitation)

ACP does **not** surface an abort signal on `session/request_permission`. `handleAcpPermission` passes a **fresh, never-aborted** `AbortController().signal` to `requestFromSdk`. Consequence: if the user cancels the turn while a permission prompt is open, the prompt stays open; answering it later returns a stale `optionId` that Hermes ignores (the turn already resolved `cancelled`). This is accepted for v1 — don't "fix" it by faking an abort that `requestFromSdk` would treat as a deny. If ACP grows a cancel signal on permission requests, thread `ctrl.signal` through instead.

## What we extract from `req.toolCall`

| UI field (`PermissionPrompt`) | Source | Fallback |
|---|---|---|
| tool name (routing) | `toolCall.kind` → `toolCall.title` | `'hermes_tool'` |
| `title` | `toolCall.title` (if string) | `undefined` |
| `displayName` | `toolCall.kind` (if string) | `undefined` |
| `blockedPath` | `toolCall.locations[0].path` | `undefined` |
| tool input | `toolCall.rawInput` (if object) | `{}` |

These feed `ToolInputPreview` in the permission bar — same component Claude uses.

## The standalone / test fallback (no handler)

If no `permissionHandler` is supplied (a bare `HermesAcpClient` in tests, or a non-MultiTable embedding), `client.ts` auto-answers via `pickPermissionOption(options, this.permissionPolicy)` where `permissionPolicy` defaults to `'allow_session'`:

```ts
PREFERRED_OPTION_BY_POLICY = {
  allow_session: ['allow_session', 'allow_once', 'allow_always'],
  allow_once:    ['allow_once', 'allow_session'],
  deny:          ['deny'],
};
// fallthrough: first non-'deny' option, else null → CANCELLED
```

This path is **never** taken in the running daemon (the adapter always wires a handler). It exists so `HermesAcpClient` is usable in isolation without hanging mid-turn. Don't rely on it for product behavior; if you're testing the *prompt* flow, inject a client and assert on `handleAcpPermission`.

## fs / terminal server-requests are rejected by design

Because we advertise `clientCapabilities: { fs: { readTextFile:false, writeTextFile:false }, terminal:false }`, Hermes shouldn't send `fs/*` or `terminal/*`. If it does, the handlers **throw** (`multitable did not advertise … capability`) → `-32000` back to Hermes. Don't implement these to "be helpful" — Hermes runs file/terminal work in its own sandbox; brokering them would punch a hole in `hardSandbox`.
