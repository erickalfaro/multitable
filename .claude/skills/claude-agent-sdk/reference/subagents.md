# Subagents

Anthropic doc: https://docs.claude.com/en/api/agent-sdk/subagents

A subagent is a self-contained Claude turn invoked via the `Agent` (formerly `Task`) tool, with its own system prompt, its own tool subset, and a clean conversation context.

## Defining subagents

```ts
const options: Options = {
  allowedTools: ['Read', 'Grep', 'Glob', 'Agent'],   // include 'Agent' to enable subagents
  agents: {
    'code-reviewer': {
      description: 'Expert code review specialist. Use for quality and security reviews.',
      prompt: `You are a senior reviewer. ...`,
      tools: ['Read', 'Grep', 'Glob'],                // restrict subagent's tool set
      model: 'sonnet',                                 // override the model just for this subagent
    },
    'test-runner': {
      description: 'Runs and analyzes test suites',
      prompt: `You are a test runner. ...`,
      tools: ['Bash', 'Read', 'Grep'],
    },
  },
};
```

`AgentDefinition` shape (from [`sdk.d.ts:38`](../../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts)):

| Field | Purpose |
|---|---|
| `description` | Shown to the parent agent so it knows when to invoke this subagent |
| `prompt` | System instructions for the subagent |
| `tools` | Restrict to a subset (otherwise inherits parent's `allowedTools`) |
| `disallowedTools` | Hard-deny list within the subagent |
| `model` | Override (e.g., use Haiku for cheap subagents) |
| `effort` | Override thinking effort |
| `maxTurns` | Cap subagent turns independently |
| `permissionMode` | Run subagent in plan / acceptEdits / bypassPermissions |
| `background` | Run non-blocking |
| `skills` | Skills available to the subagent |
| `mcpServers` | Per-subagent MCP server allowlist |
| `memory` | `'user' \| 'project' \| 'local'` — which memory scope is loaded |

## Detecting subagent invocations

When the parent agent calls `Agent`, the SDK emits inner messages with `parent_tool_use_id` set to the parent's tool-use id. So:

```ts
for await (const msg of query({...})) {
  if (msg.type === 'assistant' && msg.parent_tool_use_id != null) {
    // this is the SUBAGENT's assistant message, not the parent's
  }
}
```

MultiTable's [`agent/sdkAdapter.ts`](../../../../packages/daemon/src/agent/sdkAdapter.ts) currently passes through subagent messages alongside parent messages. The `parent_tool_use_id` is preserved on `Message` objects (see [`agent/types.ts`](../../../../packages/daemon/src/agent/types.ts)) so the UI can group/indent them.

For lifecycle observability, hook into `SubagentStart` and `SubagentStop` ([`agent/manager.ts:1236-1254`](../../../../packages/daemon/src/agent/manager.ts)) — we increment / decrement `s.activeSubagents` for the live state snapshot.

## Context inheritance

What the subagent sees:
- ✅ Its own `prompt` (system).
- ✅ The `Agent` tool description from the parent.
- ✅ `CLAUDE.md` files if the parent's `settingSources` includes `'project'` or `'user'`.
- ✅ The tools listed in its own `tools` (intersected with the parent's `allowedTools`).
- ✅ Its `skills` (if any).

What it does NOT see:
- ❌ The parent's conversation history.
- ❌ The parent's transient permission allowlist (the user's "always allow" decisions don't carry through).
- ❌ The parent's currentTurn state.

This is by design — subagents are clean-room. If you need to share state, pass it explicitly via the prompt the parent sends to `Agent`.

## Resuming a subagent

Every subagent invocation produces an `agentId`. To re-enter the same subagent on a later turn:

```ts
// First turn: capture both ids
let parentSessionId: string;
let agentId: string;

for await (const msg of query({ prompt: 'Use code-reviewer to scan auth/', options })) {
  if (msg.type === 'result') parentSessionId = msg.session_id;
  // agentId comes from the Agent tool's tool_use input or from parent_tool_use_id
}

// Later turn: address the subagent
for await (const msg of query({
  prompt: `Continue with the code-reviewer agent ${agentId} and look at db/ next`,
  options: { resume: parentSessionId, agents: { /* same definitions */ } },
})) { /* ... */ }
```

We don't currently expose subagent resumption in the UI. Helpers `getSubagentMessages()` and friends are available in the SDK if needed.

## When to use subagents vs a fresh `query()`

| Use a subagent when | Use a separate `query()` when |
|---|---|
| The parent agent decides dynamically when to delegate | You always want the same fan-out |
| Subagent needs to feed results back into the parent's reasoning | Result is independent / written to disk |
| You want clean context isolation | You want to share full conversation history |
| Cost/effort should be lower than parent | Both should run at the same effort |

For MultiTable, our existing flows are single-agent — we haven't shipped subagent UX yet. The `Agent` tool is exposed by default in the Claude Code preset, so the model can spawn subagents on its own when it judges it useful. The hook events let us track when this happens; we just don't surface it as a separate UI lane.

## Common mistakes

- **Forgetting `'Agent'` in `allowedTools`.** Then the model can't invoke subagents at all.
- **Restricting `tools` so tightly the subagent can't do its job.** The subagent's tool list intersects the parent's `allowedTools`. Both have to allow.
- **Treating subagent messages as parent messages.** Always check `parent_tool_use_id` on `assistant`/`user` messages from the iterator.
