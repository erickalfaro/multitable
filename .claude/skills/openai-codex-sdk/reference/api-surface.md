# API surface — `Codex`, `Thread`, options

All signatures are quoted verbatim from `node_modules/@openai/codex-sdk/dist/index.d.ts` (v0.128.0). Cross-check the file when types look outdated.

## `Codex` class

```ts
declare class Codex {
  constructor(options?: CodexOptions);
  startThread(options?: ThreadOptions): Thread;
  resumeThread(id: string, options?: ThreadOptions): Thread;
}
```

`new Codex()` does not spawn anything. It just stashes the global options for use on subsequent `startThread` / `resumeThread` calls.

`startThread()` returns a fresh `Thread` whose `id` is `null` until the first `runStreamed()` produces a `thread.started` event.

`resumeThread(id, options?)` returns a `Thread` whose `id` is pre-populated. Subsequent runs spawn `codex exec ... resume <id>`.

### `CodexOptions`

```ts
type CodexOptions = {
  codexPathOverride?: string;     // absolute path to a custom codex binary
  baseUrl?: string;               // emitted as --config openai_base_url="<value>"
  apiKey?: string;                // injected as env CODEX_API_KEY (per spawn)
  config?: CodexConfigObject;     // flattened to repeated --config dotted=value flags
  env?: Record<string, string>;   // REPLACES process.env entirely (footgun, see auth-config-mcp.md)
};
```

## `Thread` class

```ts
declare class Thread {
  /** Returns the ID of the thread. Populated after the first turn starts. */
  get id(): string | null;
  runStreamed(input: Input, turnOptions?: TurnOptions): Promise<StreamedTurn>;
  run(input: Input, turnOptions?: TurnOptions): Promise<Turn>;
}
```

`StreamedTurn` is `{ events: AsyncGenerator<ThreadEvent> }`.

`Turn` (from `run()`) is `{ items: ThreadItem[]; finalResponse: string; usage: Usage | null }` — `run()` simply consumes `runStreamed()` internally and discards every event except `item.completed` and `turn.completed` / `turn.failed`. **`run()` discards `item.updated` entirely.** If you need streaming partials, you must use `runStreamed()`.

### `ThreadOptions`

```ts
type ApprovalMode    = "never" | "on-request" | "on-failure" | "untrusted";
type SandboxMode     = "read-only" | "workspace-write" | "danger-full-access";
type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
type WebSearchMode   = "disabled" | "cached" | "live";

type ThreadOptions = {
  model?: string;                       // → --model <name>
  sandboxMode?: SandboxMode;            // → --sandbox <value>
  workingDirectory?: string;            // → --cd <path>
  skipGitRepoCheck?: boolean;           // → --skip-git-repo-check
  modelReasoningEffort?: ModelReasoningEffort;   // → --config model_reasoning_effort="<v>"
  networkAccessEnabled?: boolean;       // → --config sandbox_workspace_write.network_access=<bool>
  webSearchMode?: WebSearchMode;        // → --config web_search="<v>"
  webSearchEnabled?: boolean;           // legacy: true → "live", false → "disabled"
  approvalPolicy?: ApprovalMode;        // → --config approval_policy="<v>"  (MUST be 'never' from SDK)
  additionalDirectories?: string[];     // → repeated --add-dir <path>
};
```

### `TurnOptions`

```ts
type TurnOptions = {
  outputSchema?: unknown;     // plain JSON object schema; see structured-output.md
  signal?: AbortSignal;       // forwarded to child_process.spawn(...)
};
```

### `Input`

```ts
type UserInput =
  | { type: "text";        text: string }
  | { type: "local_image"; path: string };

type Input = string | UserInput[];
```

`normalizeInput()` concatenates text entries with `"\n\n"` and passes each `local_image` as a repeated `--image <path>` flag. There is **no remote URL image type**, **no base64 inline image**, and **no audio/file/video** input types.

## How options translate to CLI flags

This is the actual code in `dist/index.js` (truncated for clarity):

```js
const commandArgs = ["exec", "--experimental-json"];
if (this.configOverrides) { /* repeated --config flat.path=value */ }
if (args.baseUrl)              commandArgs.push("--config", `openai_base_url="${baseUrl}"`);
if (args.model)                commandArgs.push("--model", args.model);
if (args.sandboxMode)          commandArgs.push("--sandbox", args.sandboxMode);
if (args.workingDirectory)     commandArgs.push("--cd", args.workingDirectory);
if (args.additionalDirectories?.length) for (...) commandArgs.push("--add-dir", dir);
if (args.skipGitRepoCheck)     commandArgs.push("--skip-git-repo-check");
if (args.outputSchemaFile)     commandArgs.push("--output-schema", args.outputSchemaFile);
if (args.modelReasoningEffort) commandArgs.push("--config", `model_reasoning_effort="${v}"`);
if (args.networkAccessEnabled !== undefined)
  commandArgs.push("--config", `sandbox_workspace_write.network_access=${bool}`);
if (args.webSearchMode)        commandArgs.push("--config", `web_search="${v}"`);
else if (args.webSearchEnabled === true)  commandArgs.push("--config", `web_search="live"`);
else if (args.webSearchEnabled === false) commandArgs.push("--config", `web_search="disabled"`);
if (args.approvalPolicy)       commandArgs.push("--config", `approval_policy="${v}"`);
if (args.threadId)             commandArgs.push("resume", args.threadId);   // appended LAST as positional
if (args.images?.length)       for (...) commandArgs.push("--image", image);
```

Three things to internalize:

1. **`config` (from `CodexOptions`) emits BEFORE all option-derived flags.** ThreadOptions therefore take precedence over global `config` for any overlapping key.
2. **`resume <id>` is a positional, not a flag.** It is appended after all options.
3. **`--add-dir` grants WRITE access** in workspace-write mode, not read-only mounts. Don't confuse the two.

## Minimum viable configuration for MultiTable

This is what [`packages/daemon/src/agent/providers/codex.ts`](../../../../packages/daemon/src/agent/providers/codex.ts) constructs in `getThread()`:

```ts
const opts: Record<string, unknown> = {
  workingDirectory: s.workingDir,
  sandboxMode: 'workspace-write' as const,
  approvalPolicy: 'never' as const,        // load-bearing — see SKILL.md
  skipGitRepoCheck: true,
};
if (s.model) opts.model = s.model;
const thread = s.agentSessionId
  ? codex.resumeThread(s.agentSessionId, opts)
  : codex.startThread(opts);
```

Adding a new option (e.g. `networkAccessEnabled`, `webSearchMode`) means adding it here. Don't add `approvalPolicy` toggles — that hardcoding is intentional.
