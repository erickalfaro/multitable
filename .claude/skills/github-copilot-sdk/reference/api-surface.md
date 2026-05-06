# API surface — `CopilotClient`, `CopilotSession`, options

All signatures here come from the upstream `nodejs/src/*` source on `github/copilot-sdk` `main`. Once the SDK is installed locally, cross-check against `node_modules/@github/copilot-sdk/dist/index.d.ts`. The Copilot SDK is in **public preview** — minor versions may shift type shapes.

## Top-level exports (`nodejs/src/index.ts`)

```ts
export {
  CopilotClient,
  CopilotSession,
  approveAll,                  // PermissionHandler that returns { kind: 'approved' }
  defineTool,                  // typed custom-tool helper
  convertMcpCallToolResult,    // MCP-result shape adapter
  SYSTEM_PROMPT_SECTIONS,      // const enum-ish list of section ids
};
export type {
  CopilotClientOptions,
  SessionConfig, ResumeSessionConfig,
  MessageOptions,
  SessionEvent, SessionEventType, TypedSessionEventHandler, SessionEventHandler,
  PermissionRequest, PermissionRequestResult, PermissionHandler,
  UserInputRequest, UserInputResponse, UserInputHandler,
  ElicitationContext, ElicitationParams, ElicitationResult, ElicitationSchema, ElicitationHandler,
  Tool, ToolHandler, ToolInvocation, ToolResult, ToolResultObject, ToolResultType,
  HookConfig, /* PreToolUse / PostToolUse / SessionStart / SessionEnd / UserPromptSubmitted / ErrorOccurred */
  SystemMessageConfig, SystemPromptSection,
  MCPServerConfig, MCPStdioServerConfig, MCPHTTPServerConfig,
  CustomAgentConfig,
  CommandDefinition,
  ModelInfo, ModelCapabilities, ModelBilling, ModelPolicy,
  TelemetryConfig, TraceContextProvider, TraceContext,
  AssistantMessageEvent, /* + the ~60 typed event variants */
};
```

## `CopilotClient`

Single, long-lived RPC client. One `start()` spawns the bundled Copilot CLI (or connects to a remote one); the same client handles many sessions.

```ts
declare class CopilotClient {
  constructor(options?: CopilotClientOptions);

  // Lifecycle
  start(): Promise<void>;
  stop(): Promise<Error[]>;        // resolves with per-session shutdown errors
  forceStop(): Promise<void>;
  getState(): ConnectionState;     // 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' (inferred names)

  // Sessions
  createSession(config: SessionConfig): Promise<CopilotSession>;
  resumeSession(sessionId: string, config: ResumeSessionConfig): Promise<CopilotSession>;
  listSessions(filter?: SessionListFilter): Promise<SessionSummary[]>;
  deleteSession(sessionId: string): Promise<void>;

  // Foreground / focus (TUI concept; rarely needed in headless)
  getForegroundSessionId(): Promise<string | undefined>;
  setForegroundSessionId(sessionId: string): Promise<void>;

  // Models
  listModels(): Promise<ModelInfo[]>;     // overridable via onListModels option

  // Misc
  ping(message?: string): Promise<unknown>;
  on(eventType: SessionLifecycleEventType, handler: (e: any) => void): () => void;

  // Escape hatch — vscode-jsonrpc MessageConnection
  get rpc(): MessageConnection;
}
```

### `CopilotClientOptions`

```ts
type CopilotClientOptions = {
  // CLI process / transport
  cliPath?: string;                     // override bundled CLI; falls back to COPILOT_CLI_PATH env
  cliUrl?: string;                      // remote CLI server, e.g. "localhost:4321"; mutually exclusive with cliPath/useStdio/auth
  cliArgs?: string[];                   // extra args injected before SDK-managed flags
  useStdio?: boolean;                   // default true; false → TCP transport
  port?: number;                        // for TCP transport; default 0 (random)
  tcpConnectionToken?: string;          // for TCP auth (use randomUUID())
  isChildProcess?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;              // forwarded to CLI child; if you pass this, spread process.env yourself
  logLevel?: string;                    // default "info"
  autoStart?: boolean;                  // default true
  copilotHome?: string;                 // sets COPILOT_HOME env for child; base dir for ~/.copilot/

  // Auth (mutually exclusive with cliUrl)
  gitHubToken?: string;
  useLoggedInUser?: boolean;            // default true; auto-becomes false when gitHubToken set

  // Telemetry / tracing
  telemetry?: TelemetryConfig;          // OTLP endpoint / file exporter / content capture
  onGetTraceContext?: TraceContextProvider;  // returns W3C { traceparent, tracestate }

  // Models
  onListModels?: () => Promise<ModelInfo[]> | ModelInfo[];   // override client.listModels()

  // Session FS adapter (for custom storage backends)
  sessionFs?: SessionFsConfig;

  // Misc
  sessionIdleTimeoutSeconds?: number;
};
```

`new CopilotClient()` does NOT spawn anything when `autoStart: false`. Call `start()` explicitly. With `autoStart: true` (default), the first `createSession()` will start the client implicitly.

## `CopilotSession`

```ts
declare class CopilotSession {
  readonly sessionId: string;
  readonly workspacePath?: string;
  readonly ui: SessionUiApi;            // host → agent UI requests (see prompts-and-interception.md)

  // Send / cancel
  send(options: MessageOptions): Promise<string>;   // returns messageId immediately
  sendAndWait(options: MessageOptions, timeoutMs?: number): Promise<AssistantMessageEvent | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;          // RPC session.destroy; session is dead after this

  // Subscribe to events
  on<K extends SessionEventType>(eventType: K, handler: TypedSessionEventHandler<K>): () => void;
  on(handler: SessionEventHandler): () => void;     // wildcard form

  // (No off(); the unsubscriber returned by on() is the only way to remove a handler.)
}
```

`MessageOptions`:
```ts
type MessageOptions = {
  prompt: string;
  attachments?: Attachment[];           // [{ type: 'file', path }] | [{ type: 'blob', data, mimeType }]
  mode?: 'enqueue' | 'immediate';       // default 'enqueue'; 'immediate' = steering (mid-turn)
  requestHeaders?: Record<string, string>;
};
```

`SessionUiApi` (host → agent direction; see `prompts-and-interception.md`):
```ts
interface SessionUiApi {
  confirm(message: string): Promise<boolean>;
  select(message: string, choices: string[]): Promise<number>;
  input(message: string): Promise<string>;
  elicitation(params: ElicitationParams): Promise<ElicitationResult>;
}
```

## `SessionConfig`

The big one. Passed to `createSession`. (Re-verify field set against locally installed types — the upstream `types.ts` file is >1800 lines; this is reconstructed from README + feature docs + exported subtypes.)

```ts
type SessionConfig = {
  // Required: the only mandatory field is onPermissionRequest. Without it,
  // the agent crashes the first time it wants to use a tool.
  onPermissionRequest: PermissionHandler;

  // Identification / persistence
  sessionId?: string;                   // SUPPLY THIS — required for resumeSession()
  workspacePath?: string;
  infiniteSessions?: boolean;           // default true; auto-compaction
  streaming?: boolean;                  // default false; enable assistant.message_delta etc.

  // Model selection
  model?: string;                       // 'gpt-5', 'claude-sonnet-4.5', 'gpt-4.1', etc.
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';

  // BYOK
  provider?: CustomProviderConfig;      // { type: 'openai'|'azure'|'anthropic', baseUrl, apiKey|bearerToken, ... }

  // System prompt
  systemMessage?: SystemMessageConfig;  // 'append' | 'replace' | 'customize' (per-section)

  // Other prompt-interception channels (NOT mandatory at construction
  // but the agent HANGS forever if it tries to use one and there's no handler)
  onUserInputRequest?: UserInputHandler;
  onElicitationRequest?: ElicitationHandler;

  // Tools / extensions
  tools?: Tool[];                       // from defineTool()
  mcpServers?: Record<string, MCPServerConfig>;
  customAgents?: CustomAgentConfig[];
  commands?: CommandDefinition[];       // slash commands (TUI integration)

  // Lifecycle hooks (all optional, all async)
  hooks?: {
    onSessionStart?:        (input) => Promise<{ additionalContext?, modifiedConfig? }>;
    onUserPromptSubmitted?: (input) => Promise<{ modifiedPrompt?, additionalContext?, suppressOutput? }>;
    onPreToolUse?:          (input) => Promise<{ permissionDecision: 'allow'|'deny'|'ask',
                                                 permissionDecisionReason?, modifiedArgs?, additionalContext?,
                                                 suppressOutput? }>;
    onPostToolUse?:         (input) => Promise<{ modifiedResult?, additionalContext?, suppressOutput? }>;
    onSessionEnd?:          (input) => Promise<{ suppressOutput?, cleanupActions?, sessionSummary? }>;
    onErrorOccurred?:       (input) => Promise<{ errorHandling: 'retry'|'skip'|'abort', retryCount?, userNotification? }>;
  };
};
```

`ResumeSessionConfig` is documented as a strict subset (model, provider, hooks, the three on*Request callbacks, etc.). BYOK keys must be re-supplied.

## `SystemMessageConfig`

```ts
type SystemMessageConfig =
  | { mode?: 'append';  content?: string }
  | { mode: 'replace';  content: string }
  | { mode: 'customize'; content?: string;
      sections?: Partial<Record<SystemPromptSection,
        { action: 'replace'|'remove'|'append'|'prepend'; content?: string } |
        ((current: string) => string)
      >>;
    };

type SystemPromptSection =
  | 'identity' | 'tone' | 'tool_efficiency' | 'environment_context'
  | 'code_change_rules' | 'guidelines' | 'safety' | 'tool_instructions'
  | 'custom_instructions' | 'last_instructions';
```

`SYSTEM_PROMPT_SECTIONS` exports an array of `{ id, description }` for these. There is **no per-turn system prompt override** — set on session creation only.

## Models

```ts
const models = await client.listModels();
// → ModelInfo[] = [{ id, displayName, capabilities, billing, policy }, ...]
```

Per-session selection: `SessionConfig.model` is a plain string id. With BYOK, `model` is **required**. There is no per-turn model switch — `MessageOptions` has no `model` field.

## Custom tools (`defineTool`)

```ts
import { defineTool } from '@github/copilot-sdk';
import { z } from 'zod';

const lookupUser = defineTool('lookup_user', {
  description: 'Fetch a user by id from our internal API',
  parameters: z.object({ userId: z.string().uuid() }),
  handler: async ({ userId }, ctx) => {
    const u = await api.get(`/users/${userId}`);
    return { content: [{ type: 'text', text: JSON.stringify(u) }] };
  },
  skipPermission: false,         // if true, bypasses BOTH onPermissionRequest AND onPreToolUse
  overridesBuiltInTool: false,
});
```

`ToolResult` shape mirrors MCP's content blocks (`{ content: [{ type: 'text'|'image'|'resource', ... }], isError? }`). The status side of `ToolResultType` lives on the wrapping `ToolResultObject`: `'success' | 'failure' | 'rejected' | 'denied' | 'timeout'`.

## What's NOT in the API

- **No `mode: 'plan'|'chat'|'auto'`** on `SessionConfig`. The TUI Plan Mode and Autopilot are CLI features. See [`modes-and-permissions.md`](modes-and-permissions.md) for approximations.
- **No `AbortSignal`** on `MessageOptions`. Use `await session.abort()` instead.
- **No per-turn system prompt or model override.** Set on session creation; rebuild the session to change.
- **No in-process MCP server registration** analogous to Claude SDK's `createSdkMcpServer`. Use `defineTool` for in-process custom tools, or run a real MCP server as a subprocess via `mcpServers`.
- **No `off()` method.** Only the unsubscriber returned from `on()`.
