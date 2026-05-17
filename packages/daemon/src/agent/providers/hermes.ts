import type { AgentSession } from '../types.js';
import type { Message } from '../../transcripts/parser.js';
import type { ProviderAdapter, ProviderCapabilities, AdapterCallbacks } from './types.js';
import type { PermissionManager } from '../../hooks/permissionManager.js';
import { HermesAcpClient } from './hermes-acp/index.js';
import type {
  RpcNotification,
  HermesAuthState,
  AcpPermissionRequest,
  AcpPermissionOutcome,
} from './hermes-acp/index.js';

// HermesAdapter — driven by `hermes acp`, Hermes Agent's stdio JSON-RPC server
// implementing the Agent Client Protocol (acp_adapter/ in NousResearch/hermes-agent).
//
// Targeted use case: drive xAI Grok 4.3 through Hermes' OAuth-authenticated
// xAI integration (per https://x.ai/news/grok-hermes, May 15 2026). The user
// runs `hermes model` once → picks "xAI Grok OAuth (SuperGrok Subscription)"
// → tokens land in ~/.hermes/auth.json. From then on, MultiTable spawns
// `hermes acp` with HERMES_INFERENCE_PROVIDER=xai-oauth pinned so the user's
// shell defaults can't accidentally route turns elsewhere.
//
// Per turn:
//  1. ensureSessionId() — `session/new` for a fresh session, or `session/load`
//     to re-attach to an existing one. Hermes ACP sessions persist under
//     ~/.hermes/state.db; the session id is the canonical identifier.
//  2. subscribe(hermesSessionId, listener) on the client singleton — every
//     ACP session/update notification carries `sessionId` so multiplexing is
//     just routing.
//  3. session/prompt with [{type: 'text', text}]; drain session/update
//     notifications until the prompt response returns with a stopReason.
//  4. Emit the canonical assistant message from the accumulated chunks.
//
// Streaming model:
//  - `agent_message_chunk` deltas are ADDITIVE per the ACP spec — each chunk
//    is a fresh piece of text to append. We accumulate and emit cumulative
//    text via emitAssistantDelta so the StreamBuffer reducer (which expects
//    cumulative semantics on its emit boundary) gets the right shape.
//  - `agent_thought_chunk` follows the same additive pattern → emitReasoningDelta.
//  - `tool_call` / `tool_call_update` carry per-call lifecycle. A
//    `tool_call_update` with status `completed` or `failed` is the canonical
//    tool_result.
//
// Mode mapping:
//  Hermes' ACP today doesn't expose a per-thread sandbox enum the way Codex
//  does — its "command approval" flows through session/request_permission,
//  which the adapter forwards to PermissionManager so the UI prompts the user.
//  Mode is essentially advisory and we keep the same session id across mode
//  flips. This may change once ACP grows per-session modes; the cache is keyed
//  by {sessionId, mode} precisely so the flip-recreates-session path works the
//  day it does.

interface SessionCacheEntry {
  hermesSessionId: string;
  mode: string;
}

interface ToolCallMeta {
  toolName: string;
  input: Record<string, unknown>;
}

interface TurnBuffers {
  // Accumulated assistant text — emitted as cumulative deltas, finalized as
  // the canonical assistant Message on prompt-response.
  assistantText: string;
  // Accumulated reasoning text — same pattern.
  reasoningText: string;
  // Per-tool-call meta so we can synthesize tool_use → tool_result pairs.
  toolCalls: Map<string, ToolCallMeta>;
}

function makeBuffers(): TurnBuffers {
  return {
    assistantText: '',
    reasoningText: '',
    toolCalls: new Map(),
  };
}

// Extract plain text from an ACP content block. ACP content blocks come in a
// few shapes; we only need text out of them for the chat surface. Image /
// audio / resource blocks are passed through as a stringified placeholder so
// the user at least sees that *something* came through.
function extractText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as Record<string, unknown>;
  if (typeof c.text === 'string') return c.text;
  if (c.type === 'text' && typeof c.text === 'string') return c.text;
  return '';
}

// Render a tool_call_update's content + rawOutput into a single human-readable
// string for the tool_result message body. ACP's update.content is an array of
// ToolContent items; each item has a nested content block.
function renderToolOutput(update: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = update.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const inner = (item as Record<string, unknown>).content;
      const text = extractText(inner);
      if (text) parts.push(text);
    }
  }
  if (parts.length === 0 && update.rawOutput != null) {
    try {
      parts.push(
        typeof update.rawOutput === 'string'
          ? update.rawOutput
          : JSON.stringify(update.rawOutput),
      );
    } catch {
      parts.push(String(update.rawOutput));
    }
  }
  return parts.join('\n');
}

export class HermesAdapter implements ProviderAdapter {
  readonly name = 'hermes' as const;

  readonly capabilities: ProviderCapabilities = {
    // Hermes doesn't surface a per-turn USD cost — the UI hides the dollar row.
    costUsd: false,
    // No native plan-mode in ACP today; Hermes' /steer + /queue are out of
    // scope for v1. Mark as simulated so the UI's plan-mode toggle is hidden
    // (or stubbed) for Hermes sessions.
    planMode: 'simulated',
    // ACP session/request_permission is forwarded to PermissionManager, so
    // every dangerous tool call surfaces a host approval prompt in the UI
    // (same flow as Claude's canUseTool).
    perCallApproval: 'callback',
    userQuestion: 'unsupported',
    elicitation: false,
    subagents: 'none',
    midTurnInput: false,
    // OAuth + per-machine ~/.hermes/auth.json — no per-session BYOK today.
    byok: false,
    hardSandbox: true,
    hooks: 'none',
    // ACP agent_message_chunk semantics are additive (each chunk is a piece).
    streamingDeltaSemantics: 'additive',
    modelSwitchScope: 'per-session',
    // Hermes doesn't model modes the same way Claude/Codex do. We expose a
    // small advisory set so the UI's ModeBadge has something coherent to show.
    // These are passed through verbatim; the adapter doesn't translate them.
    modes: [
      {
        value: 'default',
        label: 'Default',
        description: 'Standard Hermes behavior; dangerous tool calls prompt the host for approval.',
      },
      {
        value: 'plan',
        label: 'Plan',
        description: 'Advisory plan mode — Hermes ACP has no native plan-mode RPC today.',
      },
      {
        value: 'read-only',
        label: 'Read-only',
        description: 'Advisory read-only — relies on the user keeping Hermes from writing files.',
      },
    ],
    // Hermes honors `/reasoning <level>` slash-commands on the live ACP session,
    // so we plumb effort natively (prepended to each prompt body when it
    // changes; cached per session to avoid transcript noise).
    thinkingEffort: 'native',
  };

  private permManager: PermissionManager;
  private client: HermesAcpClient;
  private sessions = new Map<string, SessionCacheEntry>();
  // Reverse map (Hermes ACP session id → MultiTable session id) so the
  // permission handler — which only knows the ACP id — can resolve back to
  // the host session for prompt routing.
  private acpToMt = new Map<string, string>();
  // Per-session cache of the last reasoning effort we sent. Used so that the
  // `/reasoning <level>` prefix is only emitted when the effort actually
  // changes (Hermes persists the level on the ACP session after it's set).
  private lastSentEffort = new Map<string, string | null>();

  constructor(permManager: PermissionManager, client?: HermesAcpClient) {
    this.permManager = permManager;
    this.client =
      client ??
      new HermesAcpClient({
        // Pin xAI Grok OAuth at the Hermes runtime layer so the user's shell
        // default (`hermes config set model.provider …`) can't override us.
        envOverlay: { HERMES_INFERENCE_PROVIDER: 'xai-oauth' },
        permissionHandler: (req) => this.handleAcpPermission(req),
      });
  }

  reset(s: AgentSession): void {
    const existing = this.sessions.get(s.id);
    if (existing) this.acpToMt.delete(existing.hermesSessionId);
    this.sessions.delete(s.id);
    this.lastSentEffort.delete(s.id);
  }

  /** Daemon shutdown hook. Closes the underlying acp child. */
  shutdown(): void {
    this.client.close();
  }

  async runTurn(
    s: AgentSession,
    text: string,
    ctrl: AbortController,
    cb: AdapterCallbacks,
  ): Promise<void> {
    if (s.userMessages.length === 1) cb.maybeRenameFromFirstPrompt(text);

    // 1. Make sure the long-lived child is up and authenticated.
    let authState: HermesAuthState;
    try {
      authState = await this.client.ensureReady();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cb.emitAlert({
        category: 'auth',
        severity: 'error',
        title: 'Could not start hermes acp',
        body:
          `Failed to spawn or initialise \`hermes acp\`. Is hermes-agent installed and on PATH? ` +
          `Install: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash` +
          `\n\nUnderlying error: ${message}`,
        persistent: true,
      });
      throw err;
    }

    if (authState.kind === 'needsSetup') {
      const setupHint = authState.methodIds.includes('hermes-setup')
        ? 'Run `hermes model` and pick "xAI Grok OAuth (SuperGrok Subscription)" to sign in.'
        : 'No usable auth method advertised by hermes acp — run `hermes doctor` to diagnose.';
      cb.emitAlert({
        category: 'auth',
        severity: 'error',
        title: 'Sign in to xAI Grok',
        body: setupHint,
        persistent: true,
      });
      throw new Error('hermes acp: no provider credentials configured');
    }

    // 2. Mint or load the ACP session id.
    const hermesSessionId = await this.ensureSessionId(s, cb);

    // 3. Wire streaming. Subscribe BEFORE prompt so we can't miss early chunks.
    const buffers = makeBuffers();
    const off = this.client.subscribe(hermesSessionId, (n) => {
      try {
        this.handleNotification(s, n, cb, buffers);
      } catch (err) {
        console.error('[hermes] notification handler threw', {
          sessionId: s.id,
          hermesSessionId,
          method: n.method,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    const onAbort = () => this.client.cancel(hermesSessionId);
    ctrl.signal.addEventListener('abort', onAbort, { once: true });

    // Reasoning-effort prefix. Hermes' ACP session honors a `/reasoning <level>`
    // slash-command that persists on the session, so we only emit the prefix
    // when the effort changes (cached on this.lastSentEffort). 'max' is a
    // Claude-only tier; Hermes docs list none/minimal/low/medium/high/xhigh.
    const effort = s.thinkingEffort ?? null;
    const hermesEffort = effort === 'max' ? null : effort;
    let body = text;
    if (hermesEffort && this.lastSentEffort.get(s.id) !== hermesEffort) {
      body = `/reasoning ${hermesEffort}\n\n${text}`;
      this.lastSentEffort.set(s.id, hermesEffort);
    } else if (!hermesEffort) {
      this.lastSentEffort.delete(s.id);
    }

    console.info('[hermes] starting turn', {
      sessionId: s.id,
      hermesSessionId,
      promptLength: body.length,
      reasoningPrefixed: body !== text,
    });

    try {
      const result = await this.client.prompt({ sessionId: hermesSessionId, text: body });

      console.info('[hermes] turn completed', {
        sessionId: s.id,
        hermesSessionId,
        stopReason: result.stopReason,
      });

      // Emit the canonical assistant message from the accumulated text. If the
      // turn produced no assistant text (e.g. stopReason: 'cancelled' before any
      // chunks landed, or pure-tool-only turn), skip — the user will see the
      // tool_result messages already pushed during streaming.
      if (buffers.assistantText.trim().length > 0) {
        const id = `hermes:${hermesSessionId}:assistant:${Date.now()}`;
        const finalMsg: Message = {
          id,
          ts: Date.now(),
          kind: 'assistant',
          text: buffers.assistantText,
          model: s.model ?? 'grok-4.3',
        };
        cb.pushMessages([finalMsg]);
        cb.emitAssistantMessage([finalMsg]);
        // Clear the live preview now that the canonical message has landed.
        cb.emitAssistantDelta('');
      }

      if (buffers.reasoningText.trim().length > 0) {
        // Reasoning isn't pushed into messages by the manager (no equivalent
        // path in the current code), but we still clear the live preview so
        // the UI doesn't hold stale italic text.
        cb.emitReasoningDelta('');
      }

      // Apply usage (Hermes returns it in the prompt response when available).
      const usage = result.usage ?? {};
      const tokensIn = numberOr(usage.inputTokens, 0);
      const tokensOut = numberOr(usage.outputTokens, 0);
      const cacheCreationTokens = numberOr(usage.cacheCreationInputTokens, 0);
      const cacheReadTokens = numberOr(usage.cacheReadInputTokens, 0);

      cb.applyUsage({
        tokensIn,
        tokensOut,
        cacheCreationTokens,
        cacheReadTokens,
        costUsd: 0,
      });

      cb.emitTurnResult({
        subtype: result.stopReason ?? 'end_turn',
        totalCostUsd: 0,
        usage: {
          inputTokens: tokensIn,
          outputTokens: tokensOut,
          cacheCreationInputTokens: cacheCreationTokens,
          cacheReadInputTokens: cacheReadTokens,
        },
        text: buffers.assistantText || null,
      });
      cb.emitStateSnapshot();
    } catch (err) {
      console.error('[hermes] turn failed', {
        sessionId: s.id,
        hermesSessionId,
        error: err instanceof Error ? err.stack ?? err.message : String(err),
      });
      // Drop the cached session so the next turn re-loads from disk. The ACP
      // session persists in Hermes's state.db regardless.
      this.sessions.delete(s.id);
      this.lastSentEffort.delete(s.id);
      throw err;
    } finally {
      ctrl.signal.removeEventListener('abort', onAbort);
      off();
    }
  }

  private async ensureSessionId(s: AgentSession, cb: AdapterCallbacks): Promise<string> {
    const existing = this.sessions.get(s.id);
    if (existing && existing.mode === s.mode) return existing.hermesSessionId;

    let hermesSessionId: string;
    let loaded = false;
    if (s.agentSessionId) {
      try {
        hermesSessionId = await this.client.loadSession(s.agentSessionId, s.workingDir);
        loaded = true;
      } catch (err) {
        console.warn('[hermes] session/load failed, creating fresh', {
          sessionId: s.id,
          hermesSessionId: s.agentSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        hermesSessionId = await this.client.newSession({ cwd: s.workingDir });
      }
    } else {
      hermesSessionId = await this.client.newSession({ cwd: s.workingDir });
    }

    // Hermes schedules _replay_session_history (acp_adapter/server.py) AFTER
    // session/load returns — it floods session/update notifications for every
    // persisted user/assistant/tool message so Zed-style UIs can rebuild
    // history. MultiTable already has these from parseHermesSession on
    // register, so the replay produces duplicate UI noise. Wait briefly
    // before the caller subscribes so most replay notifications land before
    // there's a listener (and get dropped silently). Tool-id dedup in
    // handleNotification catches the tail if replay is large.
    if (loaded) await new Promise<void>((r) => setTimeout(r, 500));

    if (hermesSessionId !== s.agentSessionId) {
      const previous = s.agentSessionId;
      const nextHistory =
        previous && !s.agentSessionIdHistory.includes(previous)
          ? [...s.agentSessionIdHistory, previous]
          : s.agentSessionIdHistory;
      cb.onSessionIdAssigned(hermesSessionId, nextHistory);
      cb.emitStateSnapshot();
    }

    this.sessions.set(s.id, { hermesSessionId, mode: s.mode });
    this.acpToMt.set(hermesSessionId, s.id);
    return hermesSessionId;
  }

  // ACP session/request_permission → PermissionManager. The host UI renders
  // the same prompt card it shows for Claude tool calls; the user's Allow /
  // Deny answer becomes the optionId we return to Hermes. "Always Allow" is
  // handled inside PermissionManager (sessionAllowList), so we always return
  // `allow_once` to Hermes — subsequent calls short-circuit allow without
  // re-prompting the user.
  private async handleAcpPermission(req: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    const mtSessionId = this.acpToMt.get(req.sessionId);
    if (!mtSessionId) {
      console.warn('[hermes] permission request for unknown acp session', req.sessionId);
      return { outcome: { outcome: 'cancelled' } };
    }

    const tc = req.toolCall ?? {};
    const toolName =
      (typeof tc.kind === 'string' && tc.kind) ||
      (typeof tc.title === 'string' && tc.title) ||
      'hermes_tool';
    const toolInput =
      tc.rawInput && typeof tc.rawInput === 'object'
        ? (tc.rawInput as Record<string, unknown>)
        : {};
    const firstLoc =
      Array.isArray(tc.locations) && tc.locations[0]?.path
        ? String(tc.locations[0].path)
        : undefined;

    // ACP doesn't surface an abort signal on permission requests. Use a fresh
    // never-aborted controller — if the user cancels the turn while a prompt
    // is open, answering it later just delivers a stale optionId that Hermes
    // will ignore. Acceptable for v1.
    const controller = new AbortController();
    const result = await this.permManager.requestFromSdk(
      mtSessionId,
      '',
      toolName,
      toolInput as Record<string, any>,
      controller.signal,
      {
        title: typeof tc.title === 'string' ? tc.title : undefined,
        displayName: typeof tc.kind === 'string' ? tc.kind : undefined,
        blockedPath: firstLoc,
      },
    );

    if (result.behavior !== 'allow') {
      return { outcome: { outcome: 'cancelled' } };
    }

    // Pick the most-restrictive "allow" option offered; PermissionManager
    // owns longer-lived allowlist logic so per-call is fine. Prefer matching
    // by `kind` because option ids are agent-defined and may vary; fall back
    // to Hermes' canonical id names (allow_once / allow_session / allow_always)
    // and finally to the first non-deny option.
    const allowOption =
      req.options.find((o) => o.kind === 'allow_once') ??
      req.options.find((o) => o.kind === 'allow_always') ??
      req.options.find((o) => o.optionId === 'allow_once') ??
      req.options.find((o) => o.optionId === 'allow_session') ??
      req.options.find((o) => o.optionId === 'allow_always') ??
      req.options.find((o) => o.kind !== 'reject_once' && o.kind !== 'reject_always');
    if (!allowOption?.optionId) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
  }

  private handleNotification(
    s: AgentSession,
    n: RpcNotification,
    cb: AdapterCallbacks,
    buffers: TurnBuffers,
  ): void {
    // Hermes pushes everything through `session/update`. Other notification
    // methods (none surface to us today) are ignored.
    if (n.method !== 'session/update') return;
    const params = n.params as { sessionId?: string; update?: Record<string, unknown> } | null;
    const update = params?.update;
    if (!update || typeof update !== 'object') return;

    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
    switch (kind) {
      case 'agent_message_chunk': {
        const text = extractText(update.content);
        if (!text) return;
        buffers.assistantText += text;
        cb.emitAssistantDelta(buffers.assistantText);
        cb.bumpActivity();
        return;
      }

      case 'agent_thought_chunk': {
        const text = extractText(update.content);
        if (!text) return;
        buffers.reasoningText += text;
        cb.emitReasoningDelta(buffers.reasoningText);
        cb.bumpActivity();
        return;
      }

      case 'user_message_chunk': {
        // Fired during `session/load` history replay. Manager already has
        // these messages from prior turns / hydration — skip.
        return;
      }

      case 'tool_call': {
        const toolUseId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
        if (!toolUseId) return;
        // Tool-id dedup against hydrated history. Hermes' history replay
        // resends the same toolCallIds it persisted; if we already have one
        // in s.messages, this notification is replay — drop it.
        if (isHistoricalToolId(s, toolUseId)) return;
        const toolName =
          (typeof update.title === 'string' && update.title) ||
          (typeof update.kind === 'string' && update.kind) ||
          'tool';
        const input =
          update.rawInput && typeof update.rawInput === 'object'
            ? (update.rawInput as Record<string, unknown>)
            : {};
        buffers.toolCalls.set(toolUseId, { toolName, input });
        const msg: Message = {
          id: `hermes:${s.agentSessionId ?? 'pending'}:tool_use:${toolUseId}`,
          ts: Date.now(),
          kind: 'tool_use',
          parentId: `hermes:${s.agentSessionId ?? 'pending'}:assistant:pending`,
          toolUseId,
          toolName,
          input,
        };
        cb.pushMessages([msg]);
        cb.emitToolEvent([msg]);
        cb.setCurrentTool(toolName);
        cb.bumpActivity();
        return;
      }

      case 'tool_call_update': {
        const toolUseId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
        if (!toolUseId) return;
        // Tool-id dedup: same rationale as tool_call above.
        if (isHistoricalToolId(s, toolUseId)) return;
        const meta = buffers.toolCalls.get(toolUseId);
        const status = typeof update.status === 'string' ? update.status : '';
        const finished = status === 'completed' || status === 'failed';
        if (finished) {
          const output = renderToolOutput(update);
          const msg: Message = {
            id: `hermes:${s.agentSessionId ?? 'pending'}:tool_result:${toolUseId}`,
            ts: Date.now(),
            kind: 'tool_result',
            toolUseId,
            output,
            isError: status === 'failed',
          };
          cb.pushMessages([msg]);
          cb.emitToolEvent([msg]);
          cb.incrementToolCount();
          cb.setCurrentTool(null);
          cb.emitToolDelta(null);
          buffers.toolCalls.delete(toolUseId);
        } else if (meta) {
          // Mid-execution preview.
          const output = renderToolOutput(update);
          cb.emitToolDelta({
            toolName: meta.toolName,
            input: meta.input,
            output,
            isError: false,
          });
        }
        cb.bumpActivity();
        return;
      }

      // ACP also defines:
      //   - plan: Hermes maps todo tool results here (Zed renders as task panel)
      //   - available_commands_update / config_option_update / current_mode_update
      //   - usage_update: per-turn usage refresh
      // None of these block the v1 chat surface; surface later as needed.
      case 'plan':
      case 'available_commands_update':
      case 'config_option_update':
      case 'current_mode_update':
      case 'usage_update':
      default:
        return;
    }
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// True if the toolCallId already exists as a tool_use Message in the session's
// hydrated history. Used to drop replay notifications that arrive after the
// session/load drain window. Linear scan is fine — histories are bounded by
// ACP context window and we only call this on tool_call/tool_call_update.
function isHistoricalToolId(s: AgentSession, toolUseId: string): boolean {
  if (!toolUseId) return false;
  for (const m of s.messages) {
    if (m.kind === 'tool_use' && m.toolUseId === toolUseId) return true;
  }
  return false;
}
