# MultiTable integration plan for GitHub Copilot

Status: **GitHub Copilot is currently `comingSoon: true` in the AddAgentModal** ([`packages/web/src/components/modals/AddAgentModal.tsx:24`](../../../../packages/web/src/components/modals/AddAgentModal.tsx#L24)). No daemon-side integration exists. This file is the step-by-step for wiring it up. Read [`adapter-architecture.md`](adapter-architecture.md) first for the structural picture.

## Goal: parity with Codex provider

The success criteria — every one of these must work, mirroring Codex:

- ✅ Create a new Copilot session (no existing thread).
- ✅ Resume a Copilot session by id (across daemon restarts).
- ✅ Send a turn, see streaming text appear live in the chat.
- ✅ Render tool calls (built-in CLI tools, MCP, custom) as they happen.
- ✅ See "agent thinking" / reasoning preview if streaming reasoning is enabled.
- ✅ Stop a turn mid-stream via the existing UI stop button.
- ✅ `session.idle` correctly drives the state machine back to `stopped`.
- ✅ Three "ask" channels wired through `PermissionManager` and `ElicitationManager`.
- ✅ Cost / token row populated.
- ✅ Past sessions listed in AddAgentModal "Or resume a Copilot session" panel (analog of the Codex section).

## Phase 0: install + smoke test

```bash
npm install @github/copilot-sdk -w @multitable/daemon
```

This pulls in `@github/copilot` (the CLI binary) transitively. Confirm:

```bash
node -e "const sdk = require('@github/copilot-sdk'); console.log(Object.keys(sdk));"
```

Should list: `CopilotClient, CopilotSession, approveAll, defineTool, convertMcpCallToolResult, SYSTEM_PROMPT_SECTIONS, ...`.

The package may be ESM-only (verify via its `package.json` `type` field). If so, mirror the dynamic-import pattern from [`packages/daemon/src/agent/providers/codex.ts:241-256`](../../../../packages/daemon/src/agent/providers/codex.ts#L241-L256):

```ts
const mod = (await new Function('s', 'return import(s)')('@github/copilot-sdk')) as typeof import('@github/copilot-sdk');
this.copilot = new mod.CopilotClient({...});
```

## Phase 1: type + DB updates

1. Extend `AgentSession.provider` in `packages/daemon/src/agent/types.ts`:
   ```ts
   export interface AgentSession {
     provider: 'claude' | 'codex' | 'copilot';
     // ...
   }
   ```
2. Extend `ProviderAdapter.name` in `packages/daemon/src/agent/providers/types.ts`:
   ```ts
   readonly name: 'claude' | 'codex' | 'copilot';
   ```
3. Extend the AddAgentModal radio in [`packages/web/src/components/modals/AddAgentModal.tsx:24`](../../../../packages/web/src/components/modals/AddAgentModal.tsx#L24):
   ```ts
   { name: 'GitHub Copilot', command: 'copilot' /* drop comingSoon */ }
   ```
4. Schema: no migration needed — `provider` is a TEXT column. Just verify the existing CHECK constraint (if any) accepts the new value.

## Phase 2: the adapter (`providers/copilot.ts`)

Create `packages/daemon/src/agent/providers/copilot.ts`. Skeleton:

```ts
import type { AgentSession } from '../types.js';
import type { Message } from '../../transcripts/parser.js';
import type { ProviderAdapter, AdapterCallbacks } from './types.js';

// Ground rule: ONE CopilotClient per daemon process. NOT per session.
// (Different from Codex, which spawns a fresh subprocess per turn.)
//
// Key constraints:
// - onPermissionRequest is MANDATORY. Wire it through PermissionManager.
// - onUserInputRequest and onElicitationRequest are not mandatory at construction
//   but the agent hangs if it tries to use them and there's no handler.
//   Wire all three.
// - Streaming deltas are ADDITIVE (NOT cumulative like Codex). Append, don't replace.
// - Always replace your live preview with assistant.message.content on completion.
// - session.idle is the universal "loop done" signal. Use it for cleanup.
// - Abort via session.abort() — there is no AbortSignal on send().

export class CopilotAdapter implements ProviderAdapter {
  readonly name = 'copilot' as const;

  // Lazy-loaded so daemon boot doesn't fail if @github/copilot-sdk isn't installed.
  private client: import('@github/copilot-sdk').CopilotClient | null = null;
  private clientLoad: Promise<void> | null = null;
  // Per-multitable-session-id → CopilotSession
  private sessions = new Map<string, import('@github/copilot-sdk').CopilotSession>();

  reset(s: AgentSession): void {
    const sess = this.sessions.get(s.id);
    if (sess) sess.disconnect().catch(() => {});
    this.sessions.delete(s.id);
  }

  async runTurn(s, text, ctrl, cb): Promise<void> { /* see below */ }

  async shutdown(): Promise<void> {
    if (this.client) await this.client.stop().catch(() => {});
    this.client = null;
  }
}
```

### Wiring `runTurn`

```ts
async runTurn(s: AgentSession, text: string, ctrl: AbortController, cb: AdapterCallbacks): Promise<void> {
  if (s.userMessages.length === 1) cb.maybeRenameFromFirstPrompt(text);

  const session = await this.getSession(s, cb);

  // Hook ctrl.abort() into session.abort() so the existing
  // /api/sessions/:id/stop endpoint works unchanged.
  const abortHandler = () => { session.abort().catch(() => {}); };
  ctrl.signal.addEventListener('abort', abortHandler);

  // Subscribe BEFORE sending — there's a documented race otherwise.
  let liveText = '';
  let liveReasoning = '';
  let turnCost = 0;
  let turnTokensIn = 0, turnTokensOut = 0, turnCacheRead = 0, turnCacheCreate = 0;
  const offs: Array<() => void> = [];

  offs.push(session.on('assistant.message_delta', (e) => {
    liveText += e.data.deltaContent;             // ADDITIVE!
    cb.emitAssistantDelta(liveText);
    cb.bumpActivity();
  }));

  offs.push(session.on('assistant.reasoning_delta', (e) => {
    liveReasoning += e.data.deltaContent;
    cb.emitReasoningDelta(liveReasoning);
    cb.bumpActivity();
  }));

  offs.push(session.on('assistant.message', (e) => {
    // CANONICAL message. Replace live preview.
    const msg: Message = {
      id: `copilot:${session.sessionId}:msg:${e.id}`,
      ts: Date.now(),
      kind: 'assistant',
      text: e.data.content,
      model: 'copilot',
    };
    cb.pushMessages([msg]);
    cb.emitAssistantMessage([msg]);
    cb.emitAssistantDelta('');
    liveText = '';
  }));

  offs.push(session.on('tool.execution_start', (e) => {
    cb.setCurrentTool(e.data.toolName);
    cb.bumpActivity();
  }));

  offs.push(session.on('tool.execution_partial_result', (e) => {
    cb.emitToolDelta({
      toolName: 'tool',                          // map e.data appropriately
      input: {},
      output: e.data.partialOutput,
      isError: false,
    });
    cb.bumpActivity();
  }));

  offs.push(session.on('tool.execution_complete', (e) => {
    cb.emitToolDelta(null);
    // Build canonical tool_use + tool_result Messages and push.
    // ...
  }));

  offs.push(session.on('assistant.usage', (e) => {
    turnCost += e.data.cost ?? 0;
    turnTokensIn += e.data.inputTokens ?? 0;
    turnTokensOut += e.data.outputTokens ?? 0;
    turnCacheRead += e.data.cacheReadTokens ?? 0;
    turnCacheCreate += e.data.cacheWriteTokens ?? 0;
    cb.emitStateSnapshot();
  }));

  offs.push(session.on('session.error', (e) => {
    console.error('[copilot] session.error', e.data);
    // Don't throw here; let the for-loop end via session.idle, then surface.
  }));

  offs.push(session.on('agent.abort', (e) => {
    console.info('[copilot] agent.abort', e.data.reason);
  }));

  // Wait for the loop to fully end:
  await new Promise<void>((resolve, reject) => {
    const offIdle = session.on('session.idle', () => {
      offIdle();
      cb.applyUsage({
        tokensIn: turnTokensIn,
        tokensOut: turnTokensOut,
        cacheCreationTokens: turnCacheCreate,
        cacheReadTokens: turnCacheRead,
        costUsd: turnCost,
      });
      cb.emitTurnResult({
        subtype: 'success',
        totalCostUsd: turnCost,
        usage: {
          inputTokens: turnTokensIn,
          outputTokens: turnTokensOut,
          cacheCreationInputTokens: turnCacheCreate,
          cacheReadInputTokens: turnCacheRead,
        },
        text: null,
      });
      cb.bumpActivity();
      cb.emitStateSnapshot();
      resolve();
    });
    session.send({ prompt: text }).catch(reject);
  }).finally(() => {
    ctrl.signal.removeEventListener('abort', abortHandler);
    offs.forEach((off) => off());
    cb.emitToolDelta(null);
    cb.emitReasoningDelta('');
    // Optional: schedule a reconcile-from-disk pass (mirrors codex pattern).
  });
}
```

### Wiring the three prompt channels through `PermissionManager` / `ElicitationManager`

Inside `getSession(s, cb)`, when calling `client.createSession` or `client.resumeSession`:

```ts
const session = await this.client!.createSession({
  sessionId: s.id,
  model: s.model || undefined,
  workspacePath: s.workingDir,
  streaming: true,
  infiniteSessions: true,

  // Mandatory
  onPermissionRequest: async (req) => {
    const result = await permissionManager.requestFromSdk(
      s.id,
      `copilot/${req.kind}`,                 // tool-name proxy for the UI
      describeKind(req),                     // human-readable
      ctrl.signal,
      { kind: req.kind, toolCallId: req.toolCallId },
    );
    return result.allowed
      ? { kind: 'approved' }
      : { kind: 'denied-interactively-by-user' };
  },

  // Hangs forever without these
  onUserInputRequest: async (req) => {
    const ans = await permissionManager.askQuestion(s.id, {
      question: req.question,
      choices: req.choices,
      allowFreeform: req.allowFreeform,
    });
    return { answer: ans.text, wasFreeform: ans.wasFreeform };
  },

  onElicitationRequest: async (ctx) => {
    const result = await elicitationManager.elicit(s.id, {
      message: ctx.message,
      schema: ctx.requestedSchema,
      mode: ctx.mode,
      url: ctx.url,
    });
    return result;                             // ElicitationResult shape matches
  },

  // Lifecycle hooks (start narrow; expand as needed)
  hooks: {
    onPreToolUse: async ({ toolName, toolArgs }) => {
      if (s.mode === 'plan' && isWriteTool(toolName)) {
        return { permissionDecision: 'deny', permissionDecisionReason: 'plan mode' };
      }
      return { permissionDecision: 'ask' };    // route through PermissionManager
    },
  },
});
```

Two new methods you'll likely need on `PermissionManager`:

- `askQuestion(sessionId, { question, choices, allowFreeform }) → { text, wasFreeform }`
- (optional) `permissionManager.requestFromSdk(...)` already exists — just be careful with the tool-name labeling since Copilot uses `kind` instead of `toolName`.

## Phase 3: dispatcher in `manager.ts`

In `AgentSessionManager.sendTurn`, add a `'copilot'` branch that mirrors the existing `'codex'` branch:

```ts
if (s.provider === 'codex') return this.codexAdapter.runTurn(s, text, ctrl, cb);
if (s.provider === 'copilot') return this.copilotAdapter.runTurn(s, text, ctrl, cb);
// else: claude (inline)
```

Same pattern for `reset()` (called by `/api/sessions/:id/reset`).

## Phase 4: transcript parser

Create `packages/daemon/src/transcripts/copilotParser.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { Message } from './parser.js';

export function parseCopilotSession(sessionId: string): Message[] {
  const root = process.env.COPILOT_HOME ?? path.join(process.env.HOME!, '.copilot');
  const dir = path.join(root, 'session-state', sessionId, 'checkpoints');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b));
  if (files.length === 0) return [];
  const latest = files[files.length - 1];
  const checkpoint = JSON.parse(fs.readFileSync(path.join(dir, latest), 'utf8'));
  return mapCheckpointToMessages(checkpoint);
}

export function listCopilotSessions(): Array<{ sessionId: string; lastModified: number }> {
  const root = process.env.COPILOT_HOME ?? path.join(process.env.HOME!, '.copilot');
  const dir = path.join(root, 'session-state');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((sessionId) => {
    const stat = fs.statSync(path.join(dir, sessionId));
    return { sessionId, lastModified: stat.mtimeMs };
  });
}

function mapCheckpointToMessages(cp: any): Message[] {
  // SDK-version-specific. Write defensively. Cross-check against actual
  // checkpoint files generated during smoke tests.
  return [];
}
```

The exact checkpoint schema is **not formally documented as stable** — generate a few real sessions and reverse-engineer the shape during integration. Pin via the SDK version in `package.json` and re-verify after upgrades.

## Phase 5: REST endpoints

Add to the projects router (mirrors how Codex is wired):

- `GET /api/transcripts/copilot` → list past Copilot sessions across all projects.
- `POST /api/transcripts/copilot/:sessionId/resume` → wire into `AddAgentModal` so users can resume.

Plus AddAgentModal UI: a new "Or resume a Copilot session" section under the existing Codex one.

## Phase 6: client lifecycle

`CopilotClient` is a long-lived child process. Wire its lifecycle into the daemon:

1. **Lazy start**: don't `client.start()` on daemon boot. Start on first Copilot session creation.
2. **Shutdown**: hook into the daemon's existing SIGTERM handler in `index.ts`:
   ```ts
   process.on('SIGTERM', async () => {
     await copilotAdapter.shutdown();   // calls client.stop()
     // ... rest of shutdown
   });
   ```
3. **Crash recovery**: track the CLI child PID via `pids.ts` so orphaned `copilot` processes are cleaned up on next boot (mirrors how PTY children are tracked).

## Phase 7: mode toggle (optional, MVP+1)

The MultiTable UI exposes "plan / chat / auto" mode pickers per session. Map them to the recipes in [`reference/modes-and-permissions.md`](../reference/modes-and-permissions.md). Mode switch = recreate the session (cheap; client is already up).

Add `AgentSession.mode: 'plan' | 'chat' | 'auto' | 'ask'` if not already present (other providers may want this too).

## Smoke tests once integrated

Manual checklist for the first PR:

- [ ] Create a new Copilot session, send "what's in this dir?", see streaming text appear, see the `view` tool call render, see canonical message land at end.
- [ ] Mid-stream, hit Stop. Confirm `agent.abort` lands and `session.idle` follows. Composer unlocks.
- [ ] Send another turn on the same session. Confirm history is preserved.
- [ ] Restart the daemon. Open the session. Send a turn. Confirm `resumeSession` works and history hydrates from disk.
- [ ] Trigger a permission prompt (e.g. ask the agent to write a file outside cwd). Confirm `PermissionManager` UI shows up. Approve. Confirm tool runs.
- [ ] Force `onUserInputRequest` (e.g. ask the agent to ask the user a question). Confirm UI shows up.
- [ ] Trigger an MCP server with `onElicitationRequest`. Confirm `ElicitationManager` UI shows up.
- [ ] Ask the agent something easy in plan mode. Confirm no tools execute, only a plan appears.
- [ ] Confirm cost row is populated (or hidden if cost units are still uncertain).

## What NOT to do

- **Don't** spawn a fresh `CopilotClient` per session. One per daemon.
- **Don't** copy the streaming-delta handler from `codex.ts` verbatim — Copilot is additive, Codex is cumulative.
- **Don't** rely on `assistant.turn_end` for "loop done" — use `session.idle`.
- **Don't** try to thread an `AbortSignal` through `MessageOptions` — use `session.abort()`.
- **Don't** skip wiring `onUserInputRequest` or `onElicitationRequest` — the agent will hang.
- **Don't** introduce Claude or Codex names into the Copilot adapter (`canUseTool`, `Thread`, `runStreamed`, `permissionMode`, `sandboxMode`, etc.).
