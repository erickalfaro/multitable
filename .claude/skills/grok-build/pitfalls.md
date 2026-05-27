# Top pitfalls — read before writing/changing Grok Build code

Condensed checklist of traps, most pulled from real-world Grok-Build ACP integrations (CodexBar, OpenACP/cmux) and xAI docs. Everything tagged **`VERIFY`** must be re-confirmed against a running `grok agent stdio` before the adapter relies on it. If a PR touches `grok.ts`, `grok-acp/*`, or `grokParser.ts`, scan this first.

## 1. Grok's ACP parser does not unescape `\/` in method names — the #1 "it just hangs" bug

Grok's JSON-RPC method matcher compares the **raw** `method` string. A serializer that escapes forward slashes (`JSON.stringify` can emit `"session\/prompt"` in some code paths, and many ACP libraries pre-escape `/`) sends a method Grok reads literally as `session\/prompt`. It matches nothing, never replies, and the request **times out (~12 s)** with no error. The transport **must** post-process every outbound frame so the `method` field uses bare `/`:

```ts
// after JSON.stringify, before write:
line = line.replace(/("method"\s*:\s*")([^"]*)(")/, (_, a, m, z) => a + m.replace(/\\\//g, '/') + z);
```

Symptom to recognize: `initialize` works (if your serializer didn't escape it) but `session/new` / `session/prompt` silently hang. This trap does **not** exist for Hermes — do not assume the Hermes transport's frame writer is safe to clone verbatim; add the shim.

## 2. ACP deltas are ADDITIVE — append, then emit the running total

`agent_message_chunk` / `agent_thought_chunk` carry a *piece*, not a cumulative snapshot. `buffers.assistantText += text; cb.emitAssistantDelta(buffers.assistantText)`. This is the **opposite** of Codex's "replace, don't append." Do not copy Codex's delta handler. `capabilities.streamingDeltaSemantics: 'additive'` describes the wire, not the emit boundary. **VERIFY** the exact chunk field names against a live binary — ACP kinds are stable but Grok may add provider-specific update kinds.

## 3. `x.ai/billing` is TUI-only over agent-stdio in grok 0.1.x — `-32601` Method not found

The `x.ai/billing` ACP extension method (no params; returns billing-cycle + monthly-limit + usage) is **only wired into the interactive TUI**. Calling it over the `grok agent stdio` surface returns JSON-RPC `-32601 Method not found` (observed in grok 0.1.210). So:

- `capabilities.costUsd = false` for v1; `applyUsage({ …, costUsd: 0 })`, `emitTurnResult({ totalCostUsd: 0, … })`.
- Don't probe `x.ai/billing` on every turn — it just errors. If you probe at all, do it once with an **8 s init / 12 s billing timeout** and kill the child on timeout to avoid leaks (the CodexBar pattern), and treat `-32601` as "not available, never retry this session."
- Don't derive USD from `grok-build-0.1` published pricing — token→USD math is brittle and not our job. Revisit `costUsd` only when a future Grok wires billing into agent-stdio.

## 4. The permission outcome shape is a NESTED literal

Return `{ outcome: { outcome: 'selected', optionId } }` or `{ outcome: { outcome: 'cancelled' } }`. The **inner** `outcome` (`'selected'`/`'cancelled'`) is the ACP discriminator — not `'allowed'`/`'denied'`, not a flat object. Wrong shape can silently coerce every approval to a **deny** (this exact class of bug bit the Hermes adapter as #20). Use an `AcpPermissionOutcome` union type and don't hand-roll the object. See [`multitable/permission-wiring.md`](multitable/permission-wiring.md).

## 5. One child per FULL config (cwd + mode + effort + model) — a singleton is impossible

**RESOLVED (0.2.2): you cannot use a single daemon-wide child.** Grok's mode/effort/model are **spawn-time flags** on the `grok agent` child (`session/new` ignores those params), so each child is bound to one config for life. The pool is keyed by `JSON.stringify([cwd, agentArgs])` — a mode/effort/model flip routes the next turn to a different child (re-keyed like Codex's immutable-options thread). cwd is part of the key, so a child's process cwd is always the project root (can't misread `AGENTS.md`; workspace-trust is per-directory, see §9).

## 6. Grok self-gates approvals — and `auto` mode runs every tool with NO prompt

Like every ACP agent, **Grok decides which tool calls emit `session/request_permission`.** In `default` mode it reads/edits/runs commands automatically; only calls Grok itself deems sensitive surface a prompt. In `auto` mode (spawned `--always-approve`) **nothing** prompts. There is **no host-side "ask me about everything" lever** over ACP (no `canUseTool`, no host hook — Grok's hooks run Grok-side). If a user reports "Grok edited a file without asking," that's Grok's gating granularity, not a MultiTable bug, and not fixable in `handleAcpPermission` (no server-request was sent). The honest mitigations are: run in `plan` mode (read-only, spawned `--agent-profile <plan.md>`), or accept Grok's model. Do **not** fake interception in the adapter — there's no tool call to intercept. (This mirrors the Hermes §10b reality; the *cause* — agent-side gating — is identical across ACP agents, but document it from Grok's own default/auto/plan model, not Hermes' `DANGEROUS_PATTERNS`.)

## 7. Auth errors arrive as JSON-RPC errors, not a clean capability flag

An unauthenticated child surfaces failures as JSON-RPC errors carrying messages like *"Authentication required to fetch billing data. Run grok login to authenticate."* (and analogous strings on `session/prompt`). The adapter must detect the auth-failure class and raise a **typed `auth` alert** + throw in `runTurn` **before** persisting a session id — don't mint/persist a session id for an unauthenticated turn. See [`reference/xai-auth.md`](reference/xai-auth.md). **VERIFY** the exact error code/message for a prompt-time (not billing-time) auth failure.

## 8. Two auth sources, precedence matters

Grok reads `~/.grok/auth.json` (OAuth, written by `grok auth login`, requires a SuperGrok/SuperHeavy subscription) **and** the env var `GROK_CODE_XAI_API_KEY` (or `XAI_API_KEY`). Decide and document the precedence MultiTable relies on (likely: inherit `process.env`, so an exported API key wins; else the on-disk OAuth token). Don't assume only one exists. The child inherits `process.env` like the Codex app-server does. See [`reference/xai-auth.md`](reference/xai-auth.md).

## 9. Workspace-trust prompt on a fresh directory

On the first interactive run in a new directory Grok records a trust choice in `~/.grok/workspace-trust.json`. Over agent-stdio this may manifest as a trust gate before tools run. **VERIFY** whether `grok agent stdio` (a) auto-trusts, (b) sends a server-request to ask, or (c) refuses tools until trust is set out-of-band. If it asks, route it like a permission prompt; if it blocks, the adapter may need to pre-seed trust (analogous to how the Hermes adapter resolves cwd defensively). Don't let a silent trust gate look like a hung turn.

## 10. stdout is JSON-RPC only; stderr is logs

Non-JSON stdout lines must be dropped with a warning (`[grok-acp] non-JSON stdout line dropped`). Grok routes diagnostics to stderr — surface as `console.warn('[grok-acp]', line)`, operator-debug only, never load-bearing. Don't parse stderr for state; don't write non-JSON to the child's stdin.

## 11. `cancel` is a notification — no response, no await

`session/cancel` is fire-and-forget; the in-flight `session/prompt` resolves with `stopReason: 'cancelled'`. If the transport is dead, `cancel` is a silent no-op. Don't `await client.cancel(...)`.

## 12. The canonical assistant message comes from the buffer, not the prompt response

ACP `session/prompt`'s response carries `stopReason` (+ maybe `usage`), not the assistant text. The assistant text is whatever accumulated in `buffers.assistantText`. Pure-tool turns (no assistant text) emit no assistant `Message` — intentional, not a dropped message.

## 13. Don't advertise fs/terminal — and reject them

Advertise `clientCapabilities: { fs:{readTextFile:false,writeTextFile:false}, terminal:false }` and make `fs/*` / `terminal/*` server-request handlers **throw** by design. Grok runs file/terminal work under its own workspace-trust/sandbox. Implementing them "to help" punches a hole in `hardSandbox`. **VERIFY** that Grok respects the advertised `false` and doesn't hard-require host fs — if it *does* require it, that's a capability decision to make deliberately, not by accident.

## 14. `mcpServers` ownership — decide once

Grok loads MCP servers from project `.grok/settings.json` (`mcpServers`). Decide whether MultiTable passes `mcpServers` on `session/new` or leaves it `[]` and lets Grok read its own config (the Hermes choice). Default to `[]` + Grok-side config unless there's a reason to inject. Don't double-configure.

## 15. The no-progress watchdog vs long non-streaming tools

The manager's no-progress watchdog (`NO_PROGRESS_MS`) aborts a turn if no adapter callback fires for the window. If Grok's command/terminal tools emit one `tool_call` (start) then nothing until completion, a legit >window build/test will look like a hang. The manager already re-arms the watchdog while a tool is in flight (bounded by `TOOL_GRACE_MS`), **but only if** `setCurrentTool(name)` is called on `tool_call` and `setCurrentTool(null)` on the terminal `tool_call_update`. Wire both in `handleNotification` or long commands die mid-run. (This lives in the provider-agnostic manager — don't special-case Grok in the watchdog.) See [`../hermes-grok/pitfalls.md`](../hermes-grok/pitfalls.md) §21 for the original diagnosis of the *generic* failure mode (the mechanism is shared; the fix is not Grok-specific).

## 16. Early-beta version churn — pin observations to a version

Grok Build is in early beta; the CLI changes weekly. Every wire fact in this skill should be stamped with the `grok --version` it was observed on (see [`multitable/known-bugs.md`](multitable/known-bugs.md)). The `\/` parser bug, billing `-32601`, and trust behavior are all version-specific and may be fixed upstream. Re-run `grok inspect` + a scripted `grok agent stdio` handshake after any Grok upgrade.

## 17. Usage limits come OUT-OF-BAND, not from the agent-stdio wire

Don't compute "% used" from the `session/prompt` `_meta` tokens ([`grok.ts:389-390`](../../../packages/daemon/src/agent/providers/grok.ts)) — those are **cost**, not a subscription window. agent-stdio has no limit feed (`x.ai/billing` is `-32601` there). Limits are fetched out-of-band in [`grok-usage.ts`](../../../packages/daemon/src/agent/providers/grok-usage.ts): read `~/.grok/auth.json` (the OIDC entry's `key` — NOT `GROK_CODE_XAI_API_KEY`) and POST the empty gRPC-web frame to `grok.com/.../GetGrokCreditsConfig`. Gotchas: it's **gRPC-web protobuf**, not REST/JSON — you must send the 5-byte frame and brute-force-scan the framed response (no generated proto); fail safe to `null` on any miss; gRPC status 16 / HTTP 401-403 → `grok login`. See [`reference/usage-limits.md`](reference/usage-limits.md) + [`docs/reference/USAGE_LIMITS.md`](../../../docs/reference/USAGE_LIMITS.md).
