# omnigent repo map

Annotated structure of `omnigent-ai/omnigent` on `main` (verified during this skill's creation; re-verify with `gh api repos/omnigent-ai/omnigent/contents/<path>` if a file appears to have moved).

Stack: Python 3.12 + `uv` + SQLAlchemy + Alembic + Rich + prompt_toolkit (~83% Python, ~16% TypeScript, license Apache-2.0).

## Two provider layers (read this first)

Omnigent does **not** wrap every vendor the same way. Each provider is registered **by name** in `_HARNESS_MODULES` (`omnigent/runtime/harnesses/__init__.py`, a `dict[str, str]` mapping harness id → module path), and there are two execution styles:

1. **Inner harnesses** (`omnigent/inner/<vendor>_harness.py`) — **headless** execution via the vendor's SDK, ACP, or `--print`/stream-json mode. Examples from the live registry:
   - `claude-sdk` / `claude` → `inner/claude_sdk_harness.py` (Anthropic Agent SDK — the true analogue to MultiTable's `claude.ts`)
   - `codex` → `inner/codex_harness.py`
   - `goose` → `inner/goose_harness.py` (drives `goose acp` — ACP, like our Hermes/Grok)
   - `qwen` → `inner/qwen_harness.py` (drives `qwen --acp`)
   - `kimi` / `kimi-code` → `inner/kimi_harness.py` (headless `kimi --print --output-format ...` — stream-json, like our Cursor)
   - `openai-agents` → `inner/openai_agents_sdk_harness.py`
   - `antigravity` → `inner/antigravity_harness.py` (in-process Google `antigravity` / Gemini SDK; spawns no CLI)
   - `copilot` → `inner/copilot_harness.py`, plus `hermes`
   Each inner harness has a paired `inner/<vendor>_executor.py`.

2. **Native bridges** (`omnigent/<vendor>_native.py` + `inner/<vendor>_native_harness.py`) — **terminal-first**: spawn the vendor's real TUI inside a runner-owned **tmux** terminal and inject each web-UI turn into its pane (tmux paste), mirroring the transcript back. The canonical native ids live in `NATIVE_HARNESSES` (`omnigent/harness_aliases.py`): `claude-native`, `codex-native`, `cursor-native`, `pi-native`, `kiro-native`, `goose-native`, `qwen-native`, `kimi-native`, `hermes-native`, `opencode-native`, `antigravity-native` (+ reversed `native-<vendor>` aliases). `is_native_harness()` / `canonicalize_harness()` / `is_claude_sdk_harness_name()` are the routing predicates.

Note the **per-vendor pairing**: many vendors expose *both* a chat-first headless harness (bare name) and a terminal-first native harness (`-native` suffix) — e.g. `goose` (ACP) vs `goose-native` (TUI), `qwen` (ACP) vs `qwen-native` (TUI), `kimi` (headless `--print`) vs `kimi-native` (TUI). So "how does omnigent run `<vendor>`?" usually has two answers.

The runner ↔ harness wire is a **WebSocket tunnel** (`omnigent/runner/transports/ws_tunnel/` — `frames.py`, `registry.py`, `serve.py`, `transport.py`, `limits.py`; siblings `tcp.py`, `uds.py`). A runner advertises which harnesses it can spawn via a `HelloFrame.harnesses` list at registration. `omnigent/native_server_harness.py` + `native_server_transport.py` + `native_coding_agents.py` glue the native bridges into this contract.

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

### Per-vendor CLI bridges — the *native* layer (one of two; see "Two provider layers" above)

These files **spawn each vendor's real TUI** inside a runner-owned tmux terminal, inject web-UI turns into the pane, and mirror the transcript back. This is the architectural counterpoint to MultiTable's SDK/JSON-RPC-direct adapters — but it is **not** omnigent's only provider path (the `inner/<vendor>_harness.py` headless layer runs alongside it).

The native bridges now span ~11 vendors, each following the same file pattern `<vendor>_native.py` + `<vendor>_native_bridge.py` (+ usually `_forwarder.py`, and `_hook.py` / `_permissions.py`, `_state.py`):

- `claude_native.py` — spawns the `claude` TUI; uses `PreparedClaudeTerminal`, `ClaudeNativeUcodeConfig`. Auth: native `~/.claude/auth.json`, Databricks "ucode" profile, or Bedrock/gateway/key — injected via Claude's `--settings` `apiKeyHelper`. Output is captured by **tailing the JSONL transcript** (`claude_native_forwarder.py` → `supervise_forwarder`) plus a hook-written `message_deltas.jsonl` (`claude_native_message_display_hook.py`) — *not* terminal-scraping.
- `codex_native.py` (+ `codex_native_app_server.py`, `_elicitation.py`) — Codex TUI; harness talks to a runner-provided app-server over a UDS.
- `cursor_native.py` (+ `cursor_native_permissions.py`) — Cursor TUI.
- `pi_native.py` (+ `pi_native_credentials.py`) — Pi TUI; uses a JS extension + filesystem inbox for web-UI message injection.
- `goose_native.py`, `qwen_native.py`, `kimi_native.py`, `hermes_native.py`, `opencode_native.py` (+ `_app_server.py`, `_client.py`, `_provider.py`), `kiro_native.py`, `antigravity_native.py` (+ `_rpc.py`, `_reader.py`, `_launch.py`, `_steps.py`).
- `<vendor>_native_state.py` (e.g. `claude_native_state.py`) — per-vendor state persistence. `claude_native_state.py` deliberately persists **only the launch cwd**, client-side at `~/.omnigent/claude-native/<digest>/launch.json` (atomic write, no fsync), so a resume the next day can re-chdir.
- `native_terminal.py` — **shared** helper functions (`url_component()`, `terminal_attach_url()`, `bind_session_runner()`) that all native bridges call. The wrapping is **compositional (no base class)** — each `<vendor>_native.py` independently runs the same create-or-resume → session-create → runner-bind → terminal-ready-poll → attach state machine.
- `native_policy_hook.py` — policy interception applied to the native-bridge flow; the per-vendor `_hook.py` / `_permissions.py` files POST tool-use decisions to the central policy server.

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

### `omnigent/inner/` — per-vendor harness implementations

Paired `<vendor>_executor.py` + `<vendor>_harness.py` for each provider, in both headless (`claude_sdk_harness.py`, `codex_harness.py`, `goose_harness.py`, `qwen_harness.py`, `kimi_harness.py`, `openai_agents_sdk_harness.py`, `antigravity_harness.py`, `copilot_harness.py`, `hermes_harness.py`) and native (`claude_native_harness.py`, `codex_native_harness.py`, `cursor_native_harness.py`, `pi_native_harness.py`, `goose_native_harness.py`, `qwen_native_harness.py`, `kimi_native_harness.py`, `opencode_native_harness.py`, `kiro_native_harness.py`, `antigravity_native_harness.py`) flavors. Also here: `executor.py`, `loader.py`, `policies.py`, `tools.py`, `credential_proxy.py`, and the OS-sandbox shims `bwrap_sandbox.py` + `seatbelt_sandbox.py` (distinct from top-level `omnigent/sandbox/`).

### `omnigent/runtime/harnesses/` — harness registry + lifecycle

- `__init__.py` — the `_HARNESS_MODULES` registry (name → `inner/` module path).
- `_runner.py`, `process_manager.py` — spawn/manage harness subprocesses; `workflow.py`.
- Sibling `omnigent/harness_aliases.py` — `NATIVE_HARNESSES`, `canonicalize_harness()`, `is_native_harness()`, `is_claude_sdk_harness_name()`.

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
