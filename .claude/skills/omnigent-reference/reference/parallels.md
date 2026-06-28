# MultiTable ↔ omnigent parallels

Side-by-side map of every major MultiTable subsystem and the closest omnigent counterpart. Use this when the user asks "how does omnigent do X" — find the row, then jump to the omnigent file via [`sources.md`](sources.md).

When a column says **(no analogue)** that is itself information: a feature gap in one direction or the other.

## Agent runtime

> **Two-layer reminder** (see [`repo-map.md`](repo-map.md) "Two provider layers"): every vendor has both an `inner/<vendor>_harness.py` headless harness *and* a `<vendor>_native.py` terminal bridge. The *true* analogue to a MultiTable adapter is the **headless inner harness**, not the native bridge.

| MultiTable | Omnigent | Notes |
|---|---|---|
| `packages/daemon/src/agent/manager.ts` (`AgentSessionManager`) | `omnigent/runner/app.py` + `omnigent/runner/routing.py` | Both are provider-agnostic orchestrators. `app.py` (`_run_turn_bg` → `_stream_message_to_harness`) is the clearest turn-flow read; `routing.py` resolves runner affinity (server-bound) and the WS-tunnel httpx transport. |
| `packages/daemon/src/agent/providers/claude.ts` (SDK-direct via `@anthropic-ai/claude-agent-sdk`) | **`claude-sdk` → `omnigent/inner/claude_sdk_harness.py`** (Agent SDK, headless) — *true analogue*; **and** `omnigent/claude_native.py` + `inner/claude_native_harness.py` (spawns `claude` TUI in tmux, transcript-tail forwarder) | Not "CLI vs SDK" — omnigent has **both** paths. Their `claude-sdk` harness mirrors our approach; their `claude-native` is the TTY-bridge mode we retired (CLAUDE.md "Recently retired"). |
| `packages/daemon/src/agent/providers/codex.ts` (JSON-RPC to `codex app-server`) | `codex` → `inner/codex_harness.py` (headless); `codex-native` → `codex_native.py` (TUI + runner-provided app-server over UDS) | Their native path talks to a runner app-server over a Unix socket — same app-server idea, different host process. |
| `packages/daemon/src/agent/providers/cursor.ts` (`cursor-agent --print --output-format stream-json`) | `cursor` → `inner/cursor_harness.py`; `cursor-native` → `cursor_native.py` | Both wrap the same Cursor CLI. Omnigent's `kimi` harness (`kimi --print --output-format`) is the closest match to *our* stream-json wrapping style. |
| `packages/daemon/src/agent/providers/grok.ts` (`grok agent stdio`) and `hermes.ts` (`hermes acp`) | `hermes` → `inner/hermes_harness.py` + `hermes_native.py`; ACP also drives `goose` (`goose acp`) and `qwen` (`qwen --acp`) | Omnigent **does** use ACP — for Goose/Qwen (and has its own Hermes). So our ACP approach is not unique to us; it's one of their headless styles. |
| `packages/daemon/src/agent/providers/types.ts` (`ProviderAdapter` contract — a typed TS interface) | `_HARNESS_MODULES` registry (`omnigent/runtime/harnesses/__init__.py`, name → module) + the server-harness REST/ASGI contract over a WS tunnel | Omnigent's seam is **protocol-level, by name** (each harness = a spawned `create_app()`-style subprocess addressed over HTTP/UDS/WS), not a typed `ProviderAdapter`. No abstract base class; capabilities advertised via `HelloFrame.harnesses` + runtime checks (`harness_supports_model_override`, `is_native_harness`). |
| `packages/daemon/src/agent/streamBuffer.ts` (additive-delta reducer) | `omnigent/runner/transports/ws_tunnel/` (`frames.py`, `transport.py`) | Chunked `response.body` frames (additive, not snapshots) with smart per-chunk encoding (`utf-8` for text/SSE, `base64` for binary); per-request reassembly state (`head_future` / `body_queue` / `end_event`). Siblings `tcp.py`, `uds.py` for non-tunneled transports. |

## Permissions + elicitation

| MultiTable | Omnigent |
|---|---|
| `packages/daemon/src/hooks/permissionManager.ts` (in-process, awaited per call) | `omnigent/runner/pending_approvals.py` + `omnigent/server/permissions.py` — a global `asyncio.Future` registry (`_pending: dict[id, Future[bool]]`) + per-session counter; the runner parks `wait_for_user_approval(...)` (default timeout ~86400s → auto-deny), a server elicitation event calls `resolve(id, approved)`, `has_pending()` blocks mid-turn injection |
| `packages/daemon/src/hooks/elicitationManager.ts` | `omnigent/server/_elicitation_registry.py` + `omnigent/tools/_elicitation_schema.py` |
| `PermissionManager.requestFromSdk` bridge (Claude/Hermes route through it) | **native path:** the vendor's own `PreToolUse` **command hooks** (`omnigent/claude_native_hook.py`, per-vendor `_permissions.py`) injected via `--settings`, which POST an `EvaluationRequest` to the central **policy server** (`/v1/sessions/{id}/policies/evaluate`) and return `permissionDecision` — there is no MCP-based tool gating |
| (no analogue — single biggest **feature gap** in our codebase) | `omnigent/policies/` (`base.py`, `registry.py`, `schema.py`, `builtins/`) + `omnigent/runner/policy.py` + `omnigent/native_policy_hook.py` — declarative governance the per-call hooks resolve against |

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
