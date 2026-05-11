# Structured output (`outputSchema`)

```ts
const schema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    status:  { type: 'string', enum: ['ok', 'action_required'] },
  },
  required: ['summary', 'status'],
  additionalProperties: false,
} as const;

const turn = await thread.run("Summarize repository status", { outputSchema: schema });
console.log(turn.finalResponse);   // a JSON string conforming to the schema
```

Or with Zod:

```ts
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const schema = z.object({
  summary: z.string(),
  status: z.enum(['ok', 'action_required']),
});
const turn = await thread.run("Summarize", {
  outputSchema: zodToJsonSchema(schema, { target: 'openAi' }),
});
```

**Note the case** of `target`: `"openAi"` (lowercase A, capital I). [GitHub issue #18672](https://github.com/openai/codex/issues/18672) flagged the README having had it wrong at some point; the local README in v0.128.0 has the correct case.

## How it actually works under the hood

`thread.run()` writes the schema to a tempfile and passes its path as `--output-schema <path>` to the codex binary. From `dist/index.js`:

```js
const schemaDir  = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-output-schema-'));
const schemaPath = path.join(schemaDir, 'schema.json');
await fs.writeFile(schemaPath, JSON.stringify(schema), 'utf8');
// after the turn:
await fs.rm(schemaDir, { recursive: true, force: true });
```

The tempfile is cleaned up after the turn completes (success or failure). Tempfile leak in case of process crash is bounded by `os.tmpdir()` cleanup policies.

## Constraints

- **Must be a plain JSON object.** Arrays, primitives, and `null` throw at runtime: `"outputSchema must be a plain JSON object"`. The .d.ts types it as `unknown` which is misleading.
- **`agent_message.text` becomes the JSON string** when the schema is honored. Per the .d.ts JSDoc on `AgentMessageItem.text`: "Either natural-language text or JSON when structured output is requested."
- **No partial-streaming guarantees.** `item.updated` for the agent_message will still fire with cumulative text, but the partial may not be valid JSON until completion. Don't `JSON.parse` until you receive `item.completed`.
- **No host-side validation.** The SDK doesn't validate the response against the schema before returning it. The codex agent is *asked* to comply but may still emit invalid JSON.

## Known bug

[GitHub issue #10393](https://github.com/openai/codex/issues/10393) (open as of this writing) — `outputSchema` is sometimes ignored and the agent returns plain natural-language text instead of structured JSON. Reported on v0.93.0; we're on the codex-sdk side at 0.128.0 but the behavior depends on the spawned codex binary version, not the SDK.

**Mitigations:**

1. **Re-state the schema in your prompt.** "Respond strictly with a JSON object matching: `{summary: string, status: 'ok' | 'action_required'}`." Include the example shape inline.
2. **Validate the response yourself** with the same JSON schema (e.g. `ajv`, or Zod's `.safeParse`).
3. **Manual retry loop.** There is no `error_max_structured_output_retries` exposed by this SDK. If validation fails, start a new turn with a clarifying prompt.

## Streaming + structured output

Use `runStreamed()` if you also need event-level visibility. The agent_message item still arrives — just expect its `text` to be JSON on completion:

```ts
const { events } = await thread.runStreamed(prompt, { outputSchema, signal });
for await (const ev of events) {
  if (ev.type === 'item.completed' && ev.item.type === 'agent_message') {
    const parsed = JSON.parse(ev.item.text);   // wrap in try/catch
    // …
  }
}
```

## When NOT to use this

- When you also need `command_execution` / `file_change` work to happen in the same turn. Structured output makes the most sense for "summarize" / "classify" / "extract" tasks where the agent does no edits.
- When the schema would be huge (10+ deeply nested objects). The agent quality drops.
- When you need partial-result streaming for UX. The structured response is essentially atomic; you can't render half-parsed JSON sensibly.

## What MultiTable does today

We don't use `outputSchema` anywhere in the daemon today. If you add it, it should be on a per-turn opt-in basis, not a session-wide setting. Surface validation errors via `session:turn-error` so the user understands the response was structurally invalid (vs. the agent simply refusing the task).
