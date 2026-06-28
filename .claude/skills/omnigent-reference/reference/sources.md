# Canonical omnigent URLs

All URLs verified during this skill's creation against the `main` branch of `omnigent-ai/omnigent`. If a file 404s, re-list the parent directory with `gh api repos/omnigent-ai/omnigent/contents/<parent>` before assuming a rename.

## Browsing

- Repo root: <https://github.com/omnigent-ai/omnigent>
- License (Apache-2.0): <https://github.com/omnigent-ai/omnigent/blob/main/LICENSE>
- OpenAPI: <https://github.com/omnigent-ai/omnigent/blob/main/openapi.json>

## Top-level

| Path | URL |
|---|---|
| `omnigent/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent> |
| `sdks/` | <https://github.com/omnigent-ai/omnigent/tree/main/sdks> |
| `examples/` | <https://github.com/omnigent-ai/omnigent/tree/main/examples> |
| `docs/` | <https://github.com/omnigent-ai/omnigent/tree/main/docs> |
| `deploy/` | <https://github.com/omnigent-ai/omnigent/tree/main/deploy> |
| `tests/` | <https://github.com/omnigent-ai/omnigent/tree/main/tests> |
| `scripts/` | <https://github.com/omnigent-ai/omnigent/tree/main/scripts> |

## Core subsystems

| Subsystem | URL |
|---|---|
| `omnigent/inner/` (per-vendor harnesses + executors) | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/inner> |
| `omnigent/runtime/harnesses/` (`_HARNESS_MODULES` registry) | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/runtime/harnesses> |
| `omnigent/runner/transports/ws_tunnel/` (frame protocol) | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/runner/transports/ws_tunnel> |
| `omnigent/runner/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/runner> |
| `omnigent/server/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/server> |
| `omnigent/server/routes/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/server/routes> |
| `omnigent/policies/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/policies> |
| `omnigent/policies/builtins/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/policies/builtins> |
| `omnigent/db/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/db> |
| `omnigent/llms/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/llms> |
| `omnigent/llms/adapters/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/llms/adapters> |
| `omnigent/tools/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/tools> |
| `omnigent/client_tools/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/client_tools> |
| `omnigent/sandbox/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/sandbox> |
| `omnigent/host/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/host> |
| `omnigent/runtime/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/runtime> |
| `omnigent/terminals/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/terminals> |
| `omnigent/stores/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/stores> |
| `omnigent/resources/` | <https://github.com/omnigent-ai/omnigent/tree/main/omnigent/resources> |

## Harness registry + routing (the two-layer seam)

| File | URL |
|---|---|
| `omnigent/runtime/harnesses/__init__.py` (`_HARNESS_MODULES`) | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/runtime/harnesses/__init__.py> |
| `omnigent/harness_aliases.py` (`NATIVE_HARNESSES`, `is_native_harness`) | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/harness_aliases.py> |
| `omnigent/inner/claude_sdk_harness.py` (true analogue of our `claude.ts`) | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/inner/claude_sdk_harness.py> |
| `omnigent/inner/claude_native_harness.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/inner/claude_native_harness.py> |
| `omnigent/runner/transports/ws_tunnel/frames.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/runner/transports/ws_tunnel/frames.py> |
| `omnigent/runner/transports/ws_tunnel/transport.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/runner/transports/ws_tunnel/transport.py> |

## Per-vendor CLI bridges (the *native* layer only — see registry above for headless harnesses)

| File | URL |
|---|---|
| `omnigent/claude_native.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/claude_native.py> |
| `omnigent/claude_native_bridge.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/claude_native_bridge.py> |
| `omnigent/claude_native_forwarder.py` (transcript tail) | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/claude_native_forwarder.py> |
| `omnigent/claude_native_state.py` (launch-cwd persistence) | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/claude_native_state.py> |
| `omnigent/native_terminal.py` (shared bridge helpers) | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/native_terminal.py> |
| `omnigent/codex_native.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/codex_native.py> |
| `omnigent/cursor_native.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/cursor_native.py> |
| `omnigent/pi_native.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/pi_native.py> |
| `omnigent/native_policy_hook.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/native_policy_hook.py> |
| `omnigent/claude_native_hook.py` (PreToolUse → policy server) | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/claude_native_hook.py> |

## High-value individual files

| File | URL |
|---|---|
| `omnigent/runner/routing.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/runner/routing.py> |
| `omnigent/runner/tool_dispatch.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/runner/tool_dispatch.py> |
| `omnigent/runner/pending_approvals.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/runner/pending_approvals.py> |
| `omnigent/runner/policy.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/runner/policy.py> |
| `omnigent/runner/cost_advisor.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/runner/cost_advisor.py> |
| `omnigent/runner/cost_judge.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/runner/cost_judge.py> |
| `omnigent/server/_runner_ws_tunnel.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/server/_runner_ws_tunnel.py> |
| `omnigent/server/host_registry.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/server/host_registry.py> |
| `omnigent/server/presence.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/server/presence.py> |
| `omnigent/server/permissions.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/server/permissions.py> |
| `omnigent/server/_elicitation_registry.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/server/_elicitation_registry.py> |
| `omnigent/server/API.md` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/server/API.md> |
| `omnigent/server/DBSPEC.md` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/server/DBSPEC.md> |
| `omnigent/policies/base.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/policies/base.py> |
| `omnigent/policies/registry.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/policies/registry.py> |
| `omnigent/policies/schema.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/policies/schema.py> |
| `omnigent/db/db_models.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/db/db_models.py> |
| `omnigent/model_catalog.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/model_catalog.py> |
| `omnigent/model_override.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/model_override.py> |
| `omnigent/session_lifecycle.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/session_lifecycle.py> |
| `omnigent/conversation_browser.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/conversation_browser.py> |
| `omnigent/sandbox/bwrap.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/sandbox/bwrap.py> |
| `omnigent/sandbox/seatbelt.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/sandbox/seatbelt.py> |
| `omnigent/cli.py` | <https://github.com/omnigent-ai/omnigent/blob/main/omnigent/cli.py> |

## CLI for ad-hoc browsing

```bash
# List a directory
gh api repos/omnigent-ai/omnigent/contents/omnigent/policies | jq -r '.[].path'

# Fetch raw file content
gh api repos/omnigent-ai/omnigent/contents/omnigent/runner/routing.py --jq '.content' | base64 -d
```

Use `WebFetch` against a `blob/main/<path>` URL for an LLM-summarized read; use `gh api` for surgical paths/listings.
