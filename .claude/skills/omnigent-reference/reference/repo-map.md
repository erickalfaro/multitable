# omnigent repo map

Annotated structure of `omnigent-ai/omnigent` on `main` (verified during this skill's creation; re-verify with `gh api repos/omnigent-ai/omnigent/contents/<path>` if a file appears to have moved).

Stack: Python 3.12 + `uv` + SQLAlchemy + Alembic + Rich + prompt_toolkit (~83% Python, ~16% TypeScript, license Apache-2.0).

## Top-level layout

| Path | Purpose |
|---|---|
| `omnigent/` | Core framework package |
| `sdks/` | Headless Python client + Rich TUI |
| `examples/` | Sample agents (Polly orchestrator, Debby dual-agent) |
| `docs/` | Documentation |
| `deploy/` | Deployment configs — **cloud sandbox backends (Modal/Daytona/Islo) live here**, not under `omnigent/sandbox/` |
| `tests/` | Test suite |
| `scripts/` | Utility + installation scripts |
| `pyproject.toml`, `uv.toml`, `setup.py` | Python packaging |
| `railway.toml`, `render.yaml` | PaaS deploy configs |
| `openapi.json` | REST API schema |
| `LICENSE` | Apache-2.0 |

## `omnigent/` core package

### Per-vendor CLI bridges (key divergence from MultiTable)

These files **spawn each vendor's CLI as a subprocess** and proxy its TTY over a WebSocket attach loop. This is the *opposite* of MultiTable's SDK/JSON-RPC-direct approach. Treat them as the architectural counterpoint to our `packages/daemon/src/agent/providers/` adapters.

- `claude_native.py` — spawns the `claude` CLI; uses `PreparedClaudeTerminal`, `ClaudeNativeUcodeConfig`. Reads native auth (`~/.claude/auth.json`) or Databricks ucode config.
- `codex_native.py` — spawns the Codex CLI.
- `cursor_native.py` — spawns the Cursor CLI.
- `pi_native.py` — spawns the Pi CLI.
- `claude_native_state.py`, `codex_native_state.py`, `pi_native_state.py` — per-vendor state persistence.
- `native_policy_hook.py` — policy interception applied to the native-bridge flow.

### `omnigent/runner/` — turn orchestration

- `_entry.py` — runner process entry point.
- `app.py` — main runner logic.
- `routing.py` — multi-provider dispatch (closest analogue to our `AgentSessionManager.sendTurn`).
- `tool_dispatch.py` — tool-call execution dispatch.
- `pending_approvals.py` — per-call approval queue (analogue of `hooks/permissionManager.ts`).
- `policy.py` — policy enforcement at turn time.
- `mcp_manager.py`, `proxy_mcp_manager.py` — MCP servers.
- `cost_advisor.py`, `cost_judge.py` — advisory cost layer above raw token totals.
- `resource_registry.py`, `environment_filesystem.py`, `identity.py`, `uc_function.py`
- `transports/` — streaming transport implementations.

### `omnigent/server/` — HTTP/WS server

- `app.py` — main server entry.
- `server_config.py` — server config.
- `auth.py`, `oidc.py`, `oidc_access.py`, `passwords.py` — auth (full OIDC flow — they run a real central server, unlike our localhost daemon).
- `accounts_bootstrap.py`, `accounts_config.py`, `accounts_secret.py`, `accounts_store.py`, `admin_list.py`, `identity_migration.py` — multi-account plumbing.
- `_runner_transport.py`, `_runner_ws_tunnel.py` — runner ↔ server transport (WS tunnel).
- `ws_origin.py` — WS origin validation.
- `routes/` — REST endpoints.
- `API.md`, `DBSPEC.md` — in-tree spec docs.
- `host_registry.py`, `managed_hosts.py` — host registration (multi-device).
- `presence.py` — online presence (powers co-drive / attach).
- `permissions.py` — server-side permission/authorization logic.
- `mcp_pool.py` — pooled MCP connections.
- `_elicitation_registry.py` — schema-prompt registry.
- `bundles.py` — agent bundle handling.
- `paas_env.py` — PaaS env config.
- `performance_metrics.py`, `schemas.py`.

### `omnigent/policies/` — governance engine

The single biggest **feature gap** vs MultiTable. No analogue in our codebase today.

- `base.py` — base policy classes.
- `function.py` — function-based policy definitions.
- `registry.py` — policy registration + lookup.
- `schema.py` — policy schema.
- `types.py` — primitive types.
- `builtins/` — built-in policies (loaded at import).

### `omnigent/db/` — persistence

SQLAlchemy + Alembic. Our equivalent is `better-sqlite3` + a hand-managed `schema.sql`.

- `db_models.py` — SQLAlchemy models.
- `alembic.ini` + `migrations/` — Alembic migration framework.
- `converters.py`, `utils.py`.

### `omnigent/llms/` — model-provider abstraction

Distinct from per-vendor CLI bridges — this is the *LLM API* layer (think OpenAI/Anthropic HTTP, not `claude` the CLI).

- `adapters/` — per-provider adapters.
- `client.py`, `routing.py`.
- `context_window.py`, `summarize.py`, `_responses_to_chat.py`, `_usage_observer.py`, `errors.py`, `types.py`.
- `LLMCLIENT.md`.

### `omnigent/tools/` — tool registry

- `base.py`, `manager.py` — tool registration.
- `mcp.py` — MCP tool wrapping.
- `local.py`, `local_callable.py` — local-callable tools.
- `_elicitation_schema.py` — schema for elicit-input prompts.
- `_pep723.py`, `_runner.py`, `_srt.py`.
- `builtins/`, `client_specified/`.

Sibling: `omnigent/client_tools/` — tools surfaced on the client side.

### `omnigent/sandbox/` — OS-level sandboxing

Only **local OS** sandboxing here. Cloud sandbox backends are in `deploy/`.

- `bwrap.py` — Linux bubblewrap.
- `seatbelt.py` — macOS Seatbelt.

### Other `omnigent/` modules

- `host/`, `runtime/`, `terminals/`, `stores/`, `resources/` — infrastructure layers.
- `cli.py`, `cli_auth.py`, `cli_diagnostics.py`, `cli_sandbox.py` — CLI entrypoints (`omnigent` / `omni`).
- `chat.py` — chat interface.
- `conversation_browser.py` — historical conversation browser.
- `session_lifecycle.py` — open/closed session state machine (label-based persistence).
- `model_catalog.py`, `model_override.py` — model discovery + per-session override.

## `sdks/`

- `python-client/` — pure HTTP/SSE client (no Rich, no prompt_toolkit). For headless integration / web frontends.
- `ui/` — Rich + prompt_toolkit terminal UI (`omnigent-ui-sdk`). Used by the `omnigent` CLI for streaming output.
- *(no TypeScript/React web UI in this repo — the entire `packages/web/` analogue is absent)*

## `examples/`

- Polly — orchestrator example.
- Debby — dual-agent example.

## `deploy/`

Hosts the **cloud sandbox** backends (Modal, Daytona, Islo) referenced in the README's pitch, plus Railway / Render deployment templates. If a question is about cloud sandboxes, look here, not in `omnigent/sandbox/`.
