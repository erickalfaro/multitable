# Custom tools and MCP servers

Anthropic docs: https://docs.claude.com/en/api/agent-sdk/custom-tools • https://docs.claude.com/en/api/agent-sdk/mcp

## In-process tools via `tool()` + `createSdkMcpServer()`

Use this when you want to expose a function to Claude without spawning an external process. The function runs inside the daemon.

```ts
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const lookupCustomer = tool(
  'lookup_customer',
  'Look up a customer by id from the internal database',
  {
    customerId: z.string().describe('UUID of the customer'),
  },
  async (args) => {
    const row = await db.customers.find(args.customerId);
    return {
      content: [{ type: 'text', text: JSON.stringify(row) }],
    };
  },
  {
    annotations: {
      readOnlyHint: true,    // can run in parallel with other read-only tools
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }
);

const myServer = createSdkMcpServer({
  name: 'multitable-internal',
  version: '1.0.0',
  tools: [lookupCustomer],
});
```

Wire it in:

```ts
const it = query({
  prompt: text,
  options: {
    mcpServers: { 'multitable-internal': myServer },
    allowedTools: ['mcp__multitable-internal__lookup_customer'],
    // ... rest of options
  },
});
```

## External MCP servers (stdio / http / sse)

For tools that live in a separate process or service:

```ts
mcpServers: {
  github: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
  },
  remote: {
    type: 'sse',
    url: 'https://api.example.com/mcp/sse',
    headers: { Authorization: `Bearer ${token}` },
  },
  http: {
    type: 'http',
    url: 'https://api.example.com/mcp',
  },
}
```

For project-scoped MCP servers, the SDK can also load `<cwd>/.mcp.json`:

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
  }
}
```

## Tool naming convention

MCP tools are exposed with the pattern `mcp__<server-name>__<tool-name>`. So:

- Server `github`, tool `create_issue` → tool name `mcp__github__create_issue`.
- Allowlist all tools from a server: `allowedTools: ['mcp__github__*']`.
- Built-in tools (`Read`, `Write`, `Bash`, ...) are not prefixed.

## Tool return shape

```ts
{
  content: (
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }   // base64
    | { type: 'resource'; resource: { uri; text?; mimeType? } }
  )[],
  isError?: boolean,    // true → Claude sees the result as an error and may retry
  structuredContent?: any,
}
```

`isError: true` is the right way to signal a recoverable failure — the agent loop continues. Throwing an uncaught exception inside the handler **kills the whole `query()` iteration**.

## Auto tool-search

When you register many tools, the SDK auto-enables tool search to keep the system prompt small. Tools are loaded on-demand based on the model's intent. You don't need to do anything special — just be aware that listing 50 tools doesn't blow the context.

## How MultiTable uses custom tools today

We currently don't define any. All tools come from the bundled Claude Code preset (`Read`, `Edit`, `Write`, `Bash`, `Grep`, `Glob`, `LS`, `TodoWrite`, `WebSearch`, `WebFetch`, `Agent`, `AskUserQuestion`, etc.) plus whatever MCP servers the user has configured at the user/project level (which we load via `settingSources: ['project', 'user']`).

If we ever add a daemon-internal tool — e.g., `mt__open_terminal`, `mt__run_command`, `mt__diff_session` — the right place is a new module under `packages/daemon/src/agent/tools/` that exports an MCP server, registered in `Options.mcpServers` inside `agent/manager.ts:sendTurn`.

## Common mistakes

- **Forgetting to add the tool to `allowedTools`.** If you register an MCP server but don't allow its tools, every call lands in `canUseTool` (annoying for the user) or gets denied (silently broken).
- **Returning a giant text block from a tool handler.** That goes straight into the model's context. Truncate / summarize when handlers fetch large datasets.
- **Throwing in the handler.** Use `isError: true` instead so the agent can recover.
- **Marking write-tools `readOnlyHint: true`.** The SDK uses this to parallelize calls. Wrong hints → race conditions.
