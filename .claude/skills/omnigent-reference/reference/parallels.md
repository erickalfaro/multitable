# MultiTable ↔ omnigent parallels

Side-by-side map of every major MultiTable subsystem and the closest omnigent counterpart. Use this when the user asks "how does omnigent do X" — find the row, then jump to the omnigent file via [`sources.md`](sources.md).

When a column says **(no analogue)** that is itself information: a feature gap in one direction or the other.

## Agent runtime

| MultiTable | Omnigent | Notes |
|---|---|---|
| `packages/daemon/src/agent/manager.ts` (`AgentSessionManager`) | `omnigent/runner/app.py` + `omnigent/runner/routing.py` | Both are provider-agnostic orchestrators. Omnigent's `routing.py` is the cleanest single file to read for their dispatch model. |
| `packages/daemon/src/agent/providers/claude.ts` (SDK-direct via `@anthropic-ai/claude-agent-sdk`) | `omnigent/claude_native.py` (spawns `claude` CLI + TTY-over-WS bridge) | **Fundamentally different strategy.** They wrap the CLI subprocess; we use the SDK. We retired CLI-bridging — see CLAUDE.md "Recently retired". |
| `packages/daemon/src/agent/providers/codex.ts` (JSON-RPC to `codex app-server`) | `omnigent/codex_native.py` (CLI subprocess) | Same observation as Claude. |
| `packages/daemon/src/agent/providers/cursor.ts` (`cursor-agent --print --output-format stream-json`) | `omnigent/cursor_native.py` (CLI subprocess) | Both wrap the same Cursor CLI; their wrapping is TTY-attach, ours is stream-json NDJSON. |
| `packages/daemon/src/agent/providers/grok.ts` (`grok agent stdio`) and `hermes.ts` (`hermes acp`) | (no analogue — they have `pi_native.py` instead) | Omnigent's "Pi" is a different vendor; not Grok/Hermes. |
| `packages/daemon/src/agent/providers/types.ts` (`ProviderAdapter` contract) | implicit in `omnigent/runner/routing.py` + per-vendor `*_native.py` | Omnigent doesn't appear to expose a single TS-style contract type; the seam is the runner's dispatch + each native bridge's shape. |
| `packages/daemon/src/agent/streamBuffer.ts` (additive-delta reducer) | `omnigent/runner/transports/` (streaming transports) | Their transports also normalize streaming; depth not surveyed. |

## Permissions + elicitation

| MultiTable | Omnigent |
|---|---|
| `packages/daemon/src/hooks/permissionManager.ts` | `omnigent/runner/pending_approvals.py` + `omnigent/server/permissions.py` |
| `packages/daemon/src/hooks/elicitationManager.ts` | `omnigent/server/_elicitation_registry.py` + `omnigent/tools/_elicitation_schema.py` |
| (no analogue — single biggest **feature gap** in our codebase) | `omnigent/policies/` (`base.py`, `registry.py`, `schema.py`, `builtins/`) + `omnigent/runner/policy.py` + `omnigent/native_policy_hook.py` |

The policy engine is the most distinctive omnigent thing. There is **no MultiTable analogue today** — our governance ends at per-call approval prompts.

## Cost + observability

| MultiTable | Omnigent |
|---|---|
| `packages/daemon/src/tracker/index.ts` (raw cost records) | `omnigent/runner/cost_advisor.py` + `omnigent/runner/cost_judge.py` (advisory layer atop raw cost) |
| `packages/daemon/src/devLog.ts` | `omnigent/server/performance_metrics.py` (different focus — server perf, not in-app debug log) |

## Persistence

| MultiTable | Omnigent |
|---|---|
| `packages/daemon/src/db/store.ts` + `packages/daemon/src/db/schema.sql` (better-sqlite3, sync, hand-managed schema) | `omnigent/db/db_models.py` + `omnigent/db/migrations/` + `alembic.ini` (SQLAlchemy + Alembic) |
| `packages/daemon/src/transcripts/` (Claude JSONL / Codex rollout / Hermes parser) | `omnigent/conversation_browser.py` + `omnigent/session_lifecycle.py` (closed/open state, label-based persistence) |

## Server / transport

| MultiTable | Omnigent |
|---|---|
| `packages/daemon/src/server.ts` (Express + `/ws`, localhost only) | `omnigent/server/app.py` + `omnigent/server/_runner_ws_tunnel.py` + `omnigent/server/_runner_transport.py` + `omnigent/server/routes/` |
| (none — localhost daemon, no auth) | `omnigent/server/auth.py` + `oidc.py` + `oidc_access.py` + `accounts_*.py` (full OIDC + multi-account) |
| (none) | `omnigent/server/host_registry.py` + `omnigent/server/managed_hosts.py` (multi-host registration) |
| (none) | `omnigent/server/presence.py` (online presence → powers attach / co-drive) |
| Telegram bridge (`packages/daemon/src/notifications/telegram*.ts` + `~/.multitable/secrets.yml`) | (none — phone story is real server + OIDC instead) |

## Tool registry

| MultiTable | Omnigent |
|---|---|
| MCP servers configured ad-hoc via SDK options | `omnigent/tools/` (`base.py`, `manager.py`, `mcp.py`, `local.py`, `local_callable.py`, `builtins/`, `client_specified/`) + sibling `omnigent/client_tools/` |

Omnigent has a much more explicit tool-registration layer.

## Model catalog

| MultiTable | Omnigent |
|---|---|
| `packages/daemon/src/providers/catalog.ts` + `discovery.ts` + `baselines.ts` (in-memory cache layered over discovery; emits `providers:catalog-updated`) | `omnigent/model_catalog.py` + `omnigent/model_override.py` |

Conceptually closest pair — both surface a discovered list and a per-session override.

## LLM HTTP layer (distinct from CLI bridges)

| MultiTable | Omnigent |
|---|---|
| (mostly inside the official SDKs we use) | `omnigent/llms/` — `adapters/`, `client.py`, `routing.py`, `context_window.py`, `summarize.py`, `_usage_observer.py`, `_responses_to_chat.py` |

Their `llms/` is the *direct LLM API* layer (HTTP to Anthropic/OpenAI/etc.), entirely separate from `<vendor>_native.py` (CLI bridges). Don't conflate the two — see [`../pitfalls.md`](../pitfalls.md).

## PTY / terminals

| MultiTable | Omnigent |
|---|---|
| `packages/daemon/src/pty/manager.ts` + `ringBuffer.ts` + `stream.ts` (commands and terminals only — sessions never use PTY) | `omnigent/terminals/` |

Both wrap a PTY. Multitable strictly separates PTY (commands/terminals) from agent sessions; omnigent runs *agents themselves* through a TTY bridge.

## CLI entrypoint

| MultiTable | Omnigent |
|---|---|
| `packages/cli/` (`mt start`, `mt open`) | `omnigent/cli.py` + `cli_auth.py` + `cli_diagnostics.py` + `cli_sandbox.py` + `chat.py` — surface includes `omnigent setup / login / attach / host / server / claude / codex / run / upgrade` |

Their CLI surface is much broader because they run a real server and support multi-device attach.

## Sandbox

| MultiTable | Omnigent |
|---|---|
| (none) | `omnigent/sandbox/bwrap.py` (Linux) + `seatbelt.py` (macOS) — **OS-level only** |
| (none) | Cloud sandbox backends (Modal / Daytona / Islo) live in **`deploy/`**, not `omnigent/sandbox/` |

## Frontend

| MultiTable | Omnigent |
|---|---|
| `packages/web/` — React + Vite + xterm.js + CodeMirror 6 + Streamdown + Zustand + Tailwind | `sdks/ui/` — Rich + prompt_toolkit terminal UI; `sdks/python-client/` for headless |

No TypeScript/React web UI in omnigent's repo at all. The closest pair is our `packages/web/` ↔ their `sdks/ui/`, and the architectures don't map cleanly.

## Examples / sample agents

| MultiTable | Omnigent |
|---|---|
| (none in-repo) | `examples/Polly` (orchestrator), `examples/Debby` (dual-agent) |
