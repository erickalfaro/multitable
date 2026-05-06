# Session persistence and MCP

## On-disk session state

Default location:

```
~/.copilot/session-state/<sessionId>/
├── checkpoints/
│   ├── 001.json     ← full snapshot of conversation history
│   ├── 002.json     ← later snapshot (read the highest-numbered one)
│   └── ...
├── plan.md          ← agent's plan file (also surfaced as session.plan_changed events)
└── files/           ← session artifacts (agent-generated files etc.)
```

Override the base via `CopilotClientOptions.copilotHome` (sets `COPILOT_HOME` env for the CLI child) or by providing a `sessionFs: SessionFsConfig` adapter.

### Format: numbered JSON checkpoints, NOT JSONL

Unlike Codex (`~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl` — append-only JSONL) or Claude (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`), Copilot writes **full JSON snapshots** under `checkpoints/`. To read the canonical conversation, **read the highest-numbered checkpoint** — earlier checkpoints are older snapshots.

The schema is **not formally documented as stable** as of this writing. Treat it as version-pinned, write a defensive parser, and re-verify after SDK upgrades. For MultiTable's `transcripts/copilotParser.ts` (when we build it):

```ts
import fs from 'node:fs';
import path from 'node:path';

export function parseCopilotCheckpoints(sessionId: string): Message[] {
  const root = process.env.COPILOT_HOME ?? path.join(process.env.HOME!, '.copilot');
  const dir = path.join(root, 'session-state', sessionId, 'checkpoints');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b));
  if (files.length === 0) return [];
  const latest = files[files.length - 1];
  const raw = JSON.parse(fs.readFileSync(path.join(dir, latest), 'utf8'));
  return mapToMultitableMessages(raw);   // SDK-version-specific shape mapping
}
```

### What is and isn't persisted

| Persisted | Not persisted |
|---|---|
| Conversation history (in checkpoints) | API keys (BYOK `apiKey` / `bearerToken`) |
| Plan file | In-memory state from custom `defineTool` handlers |
| Workspace artifacts (`files/`) | Active subscriptions (`session.on` listeners) |
| Persisted events (most domain events) | Ephemeral events (`session.idle`, `session.title_changed`, `assistant.message_delta`, `assistant.streaming_delta`, `assistant.reasoning_delta`, `tool.execution_partial_result`, `session.snapshot_rewind`) |

**Practical implication**: if your daemon crashes mid-turn and restarts, you can `resumeSession()` and the history will be intact, but you cannot replay `session.idle` (the "loop done" signal) — figure out where you left off by inspecting the checkpoint contents.

## Listing and deleting sessions

```ts
const summaries = await client.listSessions({
  workingDirectory: '/path/to/project',  // optional filter
});
// summaries: SessionSummary[] = [{ sessionId, title, createdAt, ... }, ...]

await client.deleteSession(sessionId);    // removes ~/.copilot/session-state/<id>/
```

For the AddAgentModal's "resume past Copilot session" UI (analog of the existing Codex thread list at `GET /api/transcripts/codex`), wire `client.listSessions()` behind a new `GET /api/transcripts/copilot` endpoint.

## Custom storage backend (`sessionFs`)

```ts
import { createSessionFsAdapter, type SessionFsProvider } from '@github/copilot-sdk';

const myFs: SessionFsProvider = {
  async read(path) { /* ... */ },
  async write(path, data) { /* ... */ },
  async list(prefix) { /* ... */ },
  // (verify exact methods against installed types)
};

const client = new CopilotClient({
  sessionFs: createSessionFsAdapter(myFs),
});
```

Useful for sandboxed environments (containers without `~/.copilot/`), or for routing storage to S3/SQLite/etc. Probably not needed for MultiTable v1.

## MCP servers

Configured **per session** on `SessionConfig.mcpServers` (no client-level registration). Two transports.

### Stdio MCP server

```ts
const session = await client.createSession({
  sessionId,
  onPermissionRequest: approveAll,
  mcpServers: {
    filesystem: {
      type: 'local',                                            // or 'stdio'
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { /* extra env */ },
      cwd: '/tmp',
      tools: ['*'],                                             // ['*'] all, [] none, ['read_file','list'] specific
      timeout: 30_000,
    },
  },
});
```

### HTTP / SSE MCP server

```ts
mcpServers: {
  github: {
    type: 'http',                                               // or 'sse'
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
    tools: ['*'],
    timeout: 30_000,
  },
}
```

### Runtime MCP CRUD via RPC

The generated RPC (`nodejs/src/generated/rpc.ts`) exposes runtime methods that bypass `mcpServers`:

- `McpConfigAddRequest`
- `McpConfigUpdateRequest`
- `McpConfigRemoveRequest`
- `McpConfigList`
- `McpDiscoverRequest`
- `McpOauthLoginRequest`

Drive these via `client.rpc.sendRequest('mcp.config.add', { ... })`. Useful if MultiTable wants to let users add/remove MCP servers without recreating the session. **No high-level helper exposed** — you'd be sending raw RPCs.

### MCP OAuth flow

For HTTP MCP servers requiring OAuth, the SDK fires `mcp_oauth.required` events; respond by driving `McpOauthLoginRequest` via `client.rpc`. The flow is interactive (user must visit a URL).

### What there ISN'T

- **No in-process MCP server registration** analogous to Claude SDK's `createSdkMcpServer`. To run an "in-process" tool, use `defineTool` instead.
- **No per-MCP-tool host hook** beyond the global `onPreToolUse` (which receives `toolName` like `mcp__filesystem__read_file`).

## Custom tools (`defineTool`)

In-process callable tools the agent can use, with full type safety:

```ts
import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';

const lookupUser = defineTool('lookup_user', {
  description: 'Fetch a user by id from our internal API',
  parameters: z.object({ userId: z.string().uuid() }),
  handler: async ({ userId }, ctx) => {
    const user = await api.getUser(userId);
    return { content: [{ type: 'text', text: JSON.stringify(user) }] };
  },
  skipPermission: false,         // true = bypass BOTH onPermissionRequest AND onPreToolUse
  overridesBuiltInTool: false,   // true = replace a built-in tool of the same name
});

const session = await client.createSession({
  sessionId,
  onPermissionRequest: approveAll,
  tools: [lookupUser],
});
```

The `ctx` passed to the handler includes `{ session, sessionId, traceContext, ... }`. Inside the handler you can use `ctx.session.ui.{confirm,select,input,elicitation}` to ask the user something mid-tool-execution (host → agent UI direction; see `prompts-and-interception.md`).

`ToolResult` shape:

```ts
type ToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource'; uri: string; ... }
  >;
  isError?: boolean;
};
```

The wrapping `ToolResultObject` carries the status: `'success' | 'failure' | 'rejected' | 'denied' | 'timeout'` (`ToolResultType`).

## Custom agents (sub-agents)

Independent of tools. The runtime auto-routes user requests to a sub-agent based on classification:

```ts
const session = await client.createSession({
  sessionId,
  onPermissionRequest: approveAll,
  customAgents: [
    {
      name: 'reviewer',
      prompt: 'You are a code reviewer. Read the diff and produce review comments.',
      description: 'Code review specialist',
      tools: ['view', 'grep'],          // limit tool surface for this agent
      mcpServers: {/* per-agent MCP */},
      infer: 'When the user asks for a code review.',
      skills: ['gh-pr-review'],         // skill ids to enable
    },
  ],
});
```

Lifecycle events to watch: `subagent.started`, `subagent.selected`, `subagent.completed`, `subagent.failed`, `subagent.deselected`, `custom_agents.updated`. Treat sub-agent runs as **separate UI rows** in MultiTable (mirror how we'd render Claude SDK subagents).

## Slash commands

```ts
commands: [
  {
    name: 'review',
    description: 'Run the code reviewer sub-agent',
    handler: async ({ args, session }) => {
      await session.send({ prompt: `Please review: ${args}` });
    },
  },
],
```

Mostly useful for the TUI integration. In MultiTable, custom slash commands flow through the existing `<project>/.claude/commands/*.md` infrastructure that the daemon already discovers — no need to mirror to `SessionConfig.commands` unless we want first-class CLI support too.

## Skills, hooks, and other extension surfaces

Briefly:
- **`hooks`** — see [`hooks.md`](hooks.md). 6 lifecycle callbacks.
- **Skills** — discoverable via `skills.loaded`, invoked via `skill.invoked`. Built-in extensions (e.g. `gh-pr-review`); we don't author these.
- **Extensions** — discovered via `extensions.loaded`. Higher-level integrations bundled with the CLI.
- **External tools** — `external_tool.requested`/`completed` is for host-defined tools dispatched via the agent; overlaps with `defineTool` and `customAgents` but is more general.
