# Auth, environment, MCP servers, web search

## Auth resolution

The codex binary (which the SDK spawns) resolves credentials in this order:

1. `CODEX_API_KEY` env var on the spawned process. The SDK injects this from `CodexOptions.apiKey` if you pass it (`dist/index.js`):

   ```js
   if (args.apiKey) env.CODEX_API_KEY = args.apiKey;
   ```

   This injection happens **after** any `env: {...}` you pass to `CodexOptions`, so SDK-managed keys win over caller-passed env.

2. `~/.codex/auth.json` — populated by `codex login` (browser ChatGPT auth flow). The SDK never reads or writes this; the binary does.

3. Failure — the spawn errors with an auth-required message.

The SDK does not surface a typed "not authenticated" error. You'll see it as the spawn rejecting with the codex CLI's stderr. MultiTable bubbles this up as a generic `session:turn-error` toast. If you need to detect "no auth" specifically, grep the error message for `auth` / `login`; there's no structured signal.

### Known auth bug

[GitHub issue #7144](https://github.com/openai/codex/issues/7144) (closed not-planned) — enterprise users reported 401s on v0.55.0 even with both `CodexOptions.apiKey` set and `CODEX_API_KEY` exported. Cause never documented. If we see it again, work around by setting both *and* `OPENAI_API_KEY` (some codex paths fall back to it).

## The `env` option footgun

```ts
type CodexOptions = { env?: Record<string, string>; ... };
```

When you pass `env`, the SDK **replaces** `process.env` entirely:

```js
const env = {};
if (this.envOverride) Object.assign(env, this.envOverride);   // explicit env REPLACES
else for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
if (!env[INTERNAL_ORIGINATOR_ENV]) env[INTERNAL_ORIGINATOR_ENV] = "codex_sdk_ts";
if (args.apiKey) env.CODEX_API_KEY = args.apiKey;
```

Implications:

- Passing `env: { PATH: '/usr/local/bin' }` wipes out **every other variable** including `HOME`, `USER`, `LANG`, etc. The codex binary's own subprocess spawns (shells it runs for `command_execution` items) can break — e.g. `git` fails because `HOME` is missing.
- The SDK *always* re-injects `CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "codex_sdk_ts"` (telemetry attribution). Don't try to override it.
- `CODEX_API_KEY` is re-injected last, so it always wins over any value you pass in `env`.

**Practical advice:** prefer not setting `env` at all. If you must — for sandboxed Electron-style hosts — copy `process.env` into your override and add what you need:

```ts
new Codex({ env: { ...process.env, MY_CUSTOM_VAR: 'x' } as Record<string, string> });
```

## `baseUrl`

`CodexOptions.baseUrl` becomes `--config openai_base_url="<url>"`. Useful for proxies, Azure-hosted OpenAI-compat endpoints, or self-hosted gateways. Same flag you'd write yourself in `~/.codex/config.toml`; passing it via SDK is just per-instance.

## `config` — the catch-all override

```ts
new Codex({
  config: {
    show_raw_agent_reasoning: true,
    sandbox_workspace_write: { network_access: true },
    mcp_servers: { my_server: { command: 'node', args: ['./mcp.js'] } },
  },
});
```

The SDK flattens this object to dotted paths and emits repeated `--config dotted.path=value` flags. Values are serialized as TOML literals (booleans, integers, strings).

Precedence reminder: these `--config` flags emit **before** the option-derived flags, so `ThreadOptions` wins for any overlapping setting.

## MCP server configuration (config-only)

The SDK exposes no typed `mcpServers` field. To register an MCP server:

```ts
new Codex({
  config: {
    mcp_servers: {
      my_server: {
        command: 'node',
        args: ['./mcp-server.js'],
        cwd: '/path/to/server',
        env: { TOKEN: 'x' },
        enabled_tools: ['search', 'fetch'],   // allow-list
        disabled_tools: ['dangerous_op'],     // applied AFTER enabled_tools
        startup_timeout_sec: 10,              // default
        tool_timeout_sec: 60,                 // default
        required: true,                       // fail thread spawn if init fails
      },
      // HTTP variant:
      remote: {
        url: 'https://example.com/mcp',
        http_headers: { 'X-Custom': 'v' },
        bearer_token_env_var: 'MY_BEARER',
      },
    },
  },
});
```

When an MCP tool runs you'll see `mcp_tool_call` items in the event stream with:

```ts
{ id, type: "mcp_tool_call", server, tool, arguments,
  result?: { content: ContentBlock[]; structured_content: unknown },
  error?:  { message: string },
  status: "in_progress" | "completed" | "failed" }
```

## Web search

```ts
type WebSearchMode = "disabled" | "cached" | "live";

ThreadOptions.webSearchMode: WebSearchMode
ThreadOptions.webSearchEnabled: boolean   // legacy: true → "live", false → "disabled"
```

Default per config-basic: `"cached"`. When invoked, the agent emits a `WebSearchItem { id, type: "web_search", query }` — there is **no result payload** on the event itself; the search results land in subsequent `agent_message` text.

There is no per-query host hook, no allow-list of domains, and no result transformer.

## Config file layering (important to understand auth/MCP behavior)

Per the codex config-basic docs, precedence (highest wins):

1. CLI flags / `--config` overrides (what the SDK emits)
2. Profile (selected via `--profile <name>` or `[profile.<name>]` in config)
3. Project `.codex/config.toml` (closest to cwd)
4. User `~/.codex/config.toml`
5. System `/etc/codex/config.toml`
6. Built-in defaults

So a setting in `~/.codex/config.toml` is overridden by anything we pass via `CodexOptions.config` or `ThreadOptions`. Useful when debugging "why doesn't my MCP server load" — it might be set at user level but disabled by an SDK flag we forgot to remove.

## What MultiTable does today

- We do **not** set `apiKey` from the daemon — we let the codex binary read `~/.codex/auth.json` (populated by `codex login`) so the user's existing setup works.
- We do **not** set `env` — we inherit `process.env` for the daemon's children.
- We do **not** set `baseUrl` — production OpenAI is the default.
- We do **not** configure MCP servers from the SDK side — the user's `~/.codex/config.toml` controls that.
- We **do** set `workingDirectory`, `sandboxMode: 'workspace-write'`, `approvalPolicy: 'never'`, `skipGitRepoCheck: true`, optionally `model`.

Adding any of the un-set knobs above is a spec change worth its own review — not something to drop into the existing options bag.
