# Auth, environment, and client configuration

## Auth resolution order

From `docs/auth/index.md`. The first source that yields a usable token wins. **Classic GitHub PATs (`ghp_`) are NOT supported** — only `gho_`, `ghu_`, `github_pat_`.

1. **Explicit `gitHubToken`** on `CopilotClientOptions`.
2. **HMAC keys** — `CAPI_HMAC_KEY` or `COPILOT_HMAC_KEY` env vars (advanced/internal).
3. **Direct API token** — `GITHUB_COPILOT_API_TOKEN` env (with `COPILOT_API_URL`).
4. **Env tokens**, in this priority:
   1. `COPILOT_GITHUB_TOKEN`
   2. `GH_TOKEN`
   3. `GITHUB_TOKEN`
5. **Stored OAuth credentials** from a previous interactive `copilot` CLI login.
6. **`gh auth` GitHub CLI credentials** — i.e. `gh auth login` works automatically.

Disable auto-detection (e.g. when forcing BYOK):

```ts
const client = new CopilotClient({ useLoggedInUser: false });
```

(`useLoggedInUser` defaults to `true`, becomes `false` automatically when you pass `gitHubToken`.)

## BYOK — bring your own key

Bypasses GitHub auth entirely. Configure on **`SessionConfig.provider`** (per-session, not per-client):

```ts
const session = await client.createSession({
  sessionId,
  model: 'gpt-4o',                        // REQUIRED with BYOK
  provider: {
    type: 'openai',                       // 'openai' | 'azure' | 'anthropic'
    baseUrl: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    // OR for OAuth-style:
    // bearerToken: process.env.SOME_BEARER,
    wireApi: 'completions',               // 'completions' | 'responses' (default differs by provider)
    // azure: { apiVersion: '2024-10-21' }, // when type === 'azure'
  },
  onPermissionRequest: approveAll,
});
```

Notes:
- `apiKey` and `bearerToken` are mutually exclusive paths.
- **`bearerToken` does NOT auto-refresh.** If you proxy short-lived OIDC tokens, intercept and recreate the session before expiry.
- **BYOK keys are NEVER persisted to disk.** On `client.resumeSession(id, config)` you must re-supply the full `provider` block.
- BYOK uses **key-based auth only** — no Entra ID, no managed identity, no OIDC token exchange.

## All env vars the SDK respects

| Var | Meaning | Default |
|---|---|---|
| `COPILOT_GITHUB_TOKEN` | Preferred GitHub token (highest priority of the three env tokens) | unset |
| `GH_TOKEN` | GitHub CLI compatible token (2nd priority) | unset |
| `GITHUB_TOKEN` | GitHub Actions compatible token (3rd priority) | unset |
| `GITHUB_COPILOT_API_TOKEN` | Direct API token (used with `COPILOT_API_URL`) | unset |
| `COPILOT_API_URL` | Direct API URL (paired with `GITHUB_COPILOT_API_TOKEN`) | unset |
| `CAPI_HMAC_KEY`, `COPILOT_HMAC_KEY` | HMAC auth (internal/advanced) | unset |
| `COPILOT_CLI_PATH` | Fallback CLI binary path when `cliPath` not provided | unset (uses bundled `@github/copilot`) |
| `COPILOT_HOME` | Base data dir for sessions, plan files, etc. | `~/.copilot` |

BYOK provider env vars (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AZURE_OPENAI_KEY`) are **read by your application code**, not by the SDK — your code is responsible for plumbing them into `provider.apiKey` / `provider.bearerToken`.

## Where stuff lives on disk

| Thing | Default path | Override |
|---|---|---|
| Session checkpoints / plan / files | `~/.copilot/session-state/<sessionId>/` | `copilotHome` option (sets `COPILOT_HOME`) or `sessionFs` adapter |
| GitHub OAuth credentials | "system keychain" (per docs; exact path not surfaced) | n/a |
| Bundled CLI binary | `node_modules/@github/copilot/...` | `cliPath` option / `COPILOT_CLI_PATH` env |
| Logs | not documented | `logLevel` controls verbosity only |

## Full `CopilotClientOptions` reference

```ts
type CopilotClientOptions = {
  // CLI process / transport
  cliPath?: string;
  cliUrl?: string;                  // remote CLI server, e.g. "localhost:4321"; mutually exclusive with cliPath/useStdio/auth options
  cliArgs?: string[];
  useStdio?: boolean;               // default true; otherwise TCP
  port?: number;                    // for TCP transport; default 0
  tcpConnectionToken?: string;      // for TCP auth — randomUUID() recommended
  isChildProcess?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;          // forwarded to CLI child; if you set this, spread process.env yourself
  logLevel?: string;                // default "info"
  autoStart?: boolean;              // default true
  copilotHome?: string;             // sets COPILOT_HOME

  // Auth
  gitHubToken?: string;             // mutually exclusive with cliUrl
  useLoggedInUser?: boolean;        // default true; auto-false when gitHubToken set

  // Telemetry
  telemetry?: TelemetryConfig;      // OTLP / file exporter / content capture
  onGetTraceContext?: TraceContextProvider;

  // Model listing override
  onListModels?: () => Promise<ModelInfo[]> | ModelInfo[];

  // Custom session storage adapter
  sessionFs?: SessionFsConfig;

  // Misc
  sessionIdleTimeoutSeconds?: number;
};
```

## Transports

### Stdio (default)

Spawns the bundled `@github/copilot` binary as a child, communicates over stdin/stdout via JSON-RPC.

```ts
const client = new CopilotClient({});  // useStdio: true is the default
await client.start();
```

### TCP

Connect to a separately running `copilot --headless --port <N> --connection-token <UUID>` server. Useful for sandboxes or shared CLI hosts.

```ts
import { randomUUID } from 'node:crypto';
const token = randomUUID();
// in another process:
//   $ copilot --headless --port 4321 --connection-token <token>
const client = new CopilotClient({
  useStdio: false,
  port: 4321,
  tcpConnectionToken: token,
});
await client.start();
```

**Warning** (from docs): exposing `--headless` on a non-loopback address makes the agent reachable by anyone who can route to that address. Bind to `127.0.0.1` only.

### Remote / external

Connect to an existing CLI server URL without spawning anything:

```ts
const client = new CopilotClient({
  cliUrl: 'http://127.0.0.1:9000',
  // gitHubToken NOT supported with cliUrl; auth is whatever the remote server has
});
```

## Telemetry / OpenTelemetry

The SDK does **not** depend on any OTEL packages. You provide:

```ts
const client = new CopilotClient({
  telemetry: {
    // OTLP endpoint, file export, exporter type, content-capture toggle
    // (exact field names vary; see TelemetryConfig in dist/index.d.ts when installed)
  },
  onGetTraceContext: () => ({
    traceparent: makeTraceparent(),
    tracestate: 'congo=t61rcWkgMzE',
  }),
});
```

The trace context is propagated into RPC calls and tool invocations (`ToolInvocation.traceContext`). Spans are emitted by the **CLI server**, not the SDK — the SDK only forwards the trace context. There is no documented list of span names; instrument your handler boundaries yourself if you want app-level spans.

## Multi-tenant considerations for MultiTable

- One `CopilotClient` per daemon process is correct — the CLI server can host many sessions concurrently.
- Auth is per-client (the `gitHubToken` is set at construction). To support multiple GitHub accounts in one MultiTable, you'd need multiple `CopilotClient` instances. Don't do this until needed.
- BYOK provider keys are per-session, so a single client can have some sessions on GitHub auth and others on BYOK.
- The `copilotHome` option points the CLI's session storage somewhere — set it to a project-scoped path if you want clean separation, but the default `~/.copilot/session-state/<sessionId>/` is already sufficient because session ids are MultiTable-controlled UUIDs.

## Quick startup snippet

```ts
import { CopilotClient } from '@github/copilot-sdk';

const client = new CopilotClient({
  // Auth: prefer env, fall back to logged-in CLI user
  gitHubToken: process.env.COPILOT_GITHUB_TOKEN,
  useLoggedInUser: !process.env.COPILOT_GITHUB_TOKEN,

  // Logging
  logLevel: process.env.COPILOT_LOG_LEVEL ?? 'info',

  // Storage
  copilotHome: process.env.COPILOT_HOME,    // typically left default

  // Don't auto-start; we control lifecycle
  autoStart: false,
});

await client.start();
// ... create sessions ...
process.on('SIGTERM', async () => {
  await client.stop();
  process.exit(0);
});
```
