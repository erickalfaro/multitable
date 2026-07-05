import { randomUUID } from 'crypto';
import { CopilotClient } from '@github/copilot-sdk';
import type {
  CopilotSession,
  SessionConfigBase,
  PermissionRequest,
  PermissionRequestResult,
  ElicitationContext,
  ElicitationResult,
  ExitPlanModeRequest,
  ExitPlanModeResult,
} from '@github/copilot-sdk';
import type { AgentSession, UsageLimitSnapshot } from '../types.js';
import type { Message } from '../../transcripts/parser.js';
import type { ProviderAdapter, ProviderCapabilities, AdapterCallbacks } from './types.js';
import type { PermissionManager } from '../../hooks/permissionManager.js';
import type { ElicitationManager } from '../../hooks/elicitationManager.js';

// CopilotAdapter — driven by `@github/copilot-sdk`, a JSON-RPC client that
// spawns ONE long-lived bundled `copilot` CLI child per daemon and multiplexes
// many CopilotSessions over it. Architecturally the opposite of Codex (fresh
// child per turn) and a sibling of Grok/Hermes (long-lived child) — except the
// child is daemon-wide, not per-cwd. See .claude/skills/github-copilot-sdk/.
//
// Auth: the SDK uses the `copilot` CLI's own GitHub OAuth login (~/.copilot/)
// via useLoggedInUser (default). Classic ghp_ PATs are rejected by the CLI.
//
// Per turn:
//  1. ensureClient() — lazy-start the shared CLI child on first Copilot turn.
//  2. getSession() — createSession with a fresh uuid we mint (stable id we
//     control → resumable), or resumeSession(s.agentSessionId) after a daemon
//     restart. Cache is keyed by {copilotSessionId, model, effort}; a
//     model/effort flip disconnects and re-resumes over the SAME copilot id so
//     history is preserved.
//  3. Subscribe event handlers BEFORE send() (documented race in the SDK).
//  4. send({ prompt, agentMode }) returns immediately; progress arrives as
//     push events. `agentMode` is Copilot's NATIVE per-send mode — plan /
//     autopilot / interactive need no session rebuild.
//  5. `session.idle` — and ONLY session.idle — ends the turn.
//     (`assistant.turn_end` fires per LLM call; the agent loop chains many.)
//
// Streaming model (verified @github/copilot-sdk 1.0.5):
//  - assistant.message_delta / assistant.reasoning_delta carry ADDITIVE
//    deltaContent chunks (append; opposite of Codex's cumulative bodies).
//  - assistant.message is the canonical per-LLM-call message and ALWAYS fires
//    (even with streaming on); it supersedes the accumulated deltas and
//    carries toolRequests for the tool calls the model just issued.
//  - tool.execution_partial_result streams additive tool output;
//    tool.execution_complete carries the canonical result.
//
// Abort: session.abort() (MessageOptions has no AbortSignal). session.idle
// still fires afterwards and the session stays reusable.
//
// The three agent→host ask channels are ALL wired (onPermissionRequest,
// onUserInputRequest, onElicitationRequest) — the agent hangs forever on any
// unwired one. Plus onExitPlanModeRequest for native plan mode.

// Not re-exported from the SDK index (defined in its types.d.ts); structural
// mirrors of ReasoningEffort / UserInputRequest / UserInputResponse.
type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
interface UserInputRequest {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
}
interface UserInputResponse {
  answer: string;
  wasFreeform: boolean;
}

interface SessionCacheEntry {
  session: CopilotSession;
  copilotSessionId: string;
  model: string | null;
  effort: ReasoningEffort | null;
}

// Copilot's native per-send agent modes (MessageOptions.agentMode). 'shell'
// exists in the enum but is a TUI passthrough mode, not useful here.
const AGENT_MODES = new Set(['interactive', 'plan', 'autopilot']);

// SessionConfigBase.reasoningEffort has no 'max' — clamp to the top tier.
function mapEffort(effort: string | null): ReasoningEffort | null {
  if (!effort) return null;
  return (effort === 'max' ? 'xhigh' : effort) as ReasoningEffort;
}

function isEffortUnsupported(err: unknown): boolean {
  return err instanceof Error && /does not support reasoning effort/i.test(err.message);
}

// Render a tool.execution_complete result (or any content-ish value) into a
// human-readable string for the tool_result message.
function renderToolResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const r = result as Record<string, unknown>;
  if (typeof r.content === 'string') return r.content;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// Map a Copilot PermissionRequest (a rich discriminated union — shell carries
// the full command text, write carries fileName+diff, mcp carries
// server/tool/args) onto the {toolName, toolInput, extras} triple
// PermissionManager renders. toolName doubles as the "Always allow" allowlist
// key, so it stays coarse per kind (allow-all-shell), matching the session
// approval granularity Copilot's own TUI offers.
function describePermission(req: PermissionRequest): {
  toolName: string;
  toolInput: Record<string, unknown>;
  extras: { title?: string; displayName?: string; blockedPath?: string };
} {
  const r = req as unknown as Record<string, unknown>;
  const kind = typeof r.kind === 'string' ? r.kind : 'unknown';
  const intention = typeof r.intention === 'string' ? r.intention : undefined;
  switch (kind) {
    case 'shell':
      return {
        toolName: 'shell',
        toolInput: { command: r.fullCommandText ?? '', intention },
        extras: { title: intention, displayName: 'shell' },
      };
    case 'write':
      return {
        toolName: 'write',
        toolInput: { path: r.fileName ?? '', diff: r.diff ?? '', intention },
        extras: {
          title: intention,
          displayName: 'write',
          blockedPath: typeof r.fileName === 'string' ? r.fileName : undefined,
        },
      };
    case 'read':
      return {
        toolName: 'read',
        toolInput: { path: r.path ?? '', intention },
        extras: {
          title: intention,
          displayName: 'read',
          blockedPath: typeof r.path === 'string' ? r.path : undefined,
        },
      };
    case 'mcp':
      return {
        toolName: `mcp__${String(r.serverName ?? 'server')}__${String(r.toolName ?? 'tool')}`,
        toolInput: (r.args as Record<string, unknown>) ?? {},
        extras: { title: typeof r.toolTitle === 'string' ? r.toolTitle : undefined, displayName: 'mcp' },
      };
    case 'url':
      return {
        toolName: 'fetch',
        toolInput: { url: r.url ?? '', intention },
        extras: { title: intention, displayName: 'url' },
      };
    default:
      return {
        toolName: `copilot_${kind}`,
        toolInput: {},
        extras: { displayName: kind },
      };
  }
}

export class CopilotAdapter implements ProviderAdapter {
  readonly name = 'copilot' as const;

  readonly capabilities: ProviderCapabilities = {
    // assistant.usage.cost is the premium-request billing MULTIPLIER, not USD
    // (AssistantUsageData JSDoc). Never write it to cost_records as dollars.
    costUsd: false,
    // Pull-only: client.rpc.account.getQuota() → premium-request quota. The
    // in-band assistant.usage event carries no quota snapshot in SDK 1.0.5.
    usageLimits: true,
    // agentMode:'plan' on send() is a first-class runtime mode, with the
    // exit-plan gate surfaced via onExitPlanModeRequest.
    planMode: 'native',
    // onPermissionRequest carries a kind-discriminated request (shell / write /
    // read / mcp / url / …) with per-kind detail fields.
    perCallApproval: 'callback+kind',
    // onUserInputRequest is a session-config callback, not a tool.
    userQuestion: 'callback',
    // onElicitationRequest maps 1:1 onto ElicitationManager (form + url modes).
    elicitation: true,
    // subagent.* lifecycle events exist but aren't wired to emitTaskEvent yet;
    // sub-agent events are filtered out of the transcript via agentId.
    subagents: 'none',
    // send({mode:'immediate'}) supports steering, but v1 uses the client-side
    // queue fallback. ponytail: implement enqueueMessage when asked.
    midTurnInput: false,
    // The SDK supports BYOK providers; no MultiTable surface for it yet.
    byok: false,
    hardSandbox: false,
    // The six SessionConfig.hooks (onSessionStart..onErrorOccurred) exist on
    // the SDK; MultiTable doesn't register any — the runtime's native
    // permission engine + agentMode cover the gating.
    hooks: 'six',
    // deltaContent chunks are ADDITIVE (opposite of Codex).
    streamingDeltaSemantics: 'additive',
    // Model/effort are creation-bound on the CopilotSession; a flip disconnects
    // and resumeSession()s over preserved history, landing on the NEXT turn.
    modelSwitchScope: 'per-turn',
    // agentMode is per-send — a mode flip simply rides the next send(), no
    // session rebuild at all.
    modeSwitchScope: 'per-turn',
    // Copilot's NATIVE agentMode values, passed verbatim on every send().
    modes: [
      {
        value: 'interactive',
        label: 'Ask first',
        description: 'Copilot asks before shell commands, file writes, and other side effects.',
        tone: 'standard',
      },
      {
        value: 'autopilot',
        label: 'Autopilot',
        description: 'Copilot runs every tool without asking (native autopilot mode).',
        tone: 'danger',
      },
      {
        value: 'plan',
        label: 'Plan',
        description: 'Plan first — Copilot proposes a plan and asks before executing it.',
        tone: 'safe',
      },
    ],
    // SessionConfigBase.reasoningEffort: low|medium|high|xhigh ('max' clamps).
    thinkingEffort: 'native',
  };

  private permManager: PermissionManager;
  private elicitManager: ElicitationManager;
  // One CLI child per daemon. Lazy — never spawned at boot (no warmup()).
  private client: CopilotClient | null = null;
  private clientStart: Promise<void> | null = null;
  private sessions = new Map<string, SessionCacheEntry>();
  // Latest AgentSession per MultiTable session id, so the agent→host callbacks
  // (bound once at session creation, fired mid-turn) see the CURRENT mode.
  private mtSessions = new Map<string, AgentSession>();
  // In-flight turn controllers so mid-turn prompts get a real abort signal
  // (an aborted turn deny-resolves its pending prompt cards).
  private activeTurnCtrls = new Map<string, AbortController>();
  private latestQuota: UsageLimitSnapshot | null = null;

  constructor(permManager: PermissionManager, elicitManager: ElicitationManager) {
    this.permManager = permManager;
    this.elicitManager = elicitManager;
  }

  private async ensureClient(): Promise<CopilotClient> {
    if (!this.client) {
      this.client = new CopilotClient({ logLevel: 'error' });
    }
    if (!this.clientStart) {
      this.clientStart = this.client.start().catch((err) => {
        // Failed spawn: reset so the next turn retries instead of reusing a
        // dead client.
        this.client = null;
        this.clientStart = null;
        throw err;
      });
    }
    await this.clientStart;
    return this.client;
  }

  reset(s: AgentSession): void {
    const cached = this.sessions.get(s.id);
    if (cached) void cached.session.disconnect().catch(() => {});
    this.sessions.delete(s.id);
    this.mtSessions.delete(s.id);
    // Do NOT client.deleteSession() — /clear never wipes provider-side state
    // (grok/codex precedent); the next turn mints a fresh copilot session id.
  }

  destroy(s: AgentSession): void {
    this.reset(s);
  }

  async shutdown(): Promise<void> {
    for (const entry of this.sessions.values()) {
      await entry.session.disconnect().catch(() => {});
    }
    this.sessions.clear();
    this.mtSessions.clear();
    if (this.client) await this.client.stop().catch(() => {});
    this.client = null;
    this.clientStart = null;
  }

  /**
   * Out-of-band usage-limits fetch (manager poll loop). Premium-request quota
   * via the account.getQuota RPC. Never spawns the CLI child just to poll —
   * returns the last-known snapshot until a turn has started the client.
   */
  async fetchUsageLimits(_s: AgentSession): Promise<UsageLimitSnapshot | null> {
    if (!this.client || !this.clientStart) return this.latestQuota;
    try {
      await this.clientStart;
      const result = await this.client.rpc.account.getQuota({});
      const snap = normalizeQuota(result?.quotaSnapshots);
      if (snap) this.latestQuota = snap;
      return snap ?? this.latestQuota;
    } catch {
      return this.latestQuota;
    }
  }

  async runTurn(
    s: AgentSession,
    text: string,
    ctrl: AbortController,
    cb: AdapterCallbacks,
  ): Promise<void> {
    if (s.userMessages.length === 1) cb.maybeRenameFromFirstPrompt(text);

    let session: CopilotSession;
    try {
      session = await this.getSession(s, cb);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cb.emitAlert({
        category: 'auth',
        severity: 'error',
        title: 'Could not start GitHub Copilot',
        body:
          'Failed to start the Copilot CLI runtime or open a session. Sign in with ' +
          '`copilot` (GitHub OAuth) or set a gho_/ghu_/github_pat_ token — classic ghp_ ' +
          `PATs are rejected.\n\nUnderlying error: ${message}`,
        persistent: true,
      });
      throw err;
    }
    const sid = session.sessionId;

    // Per-turn buffers. Deltas are ADDITIVE — append, then replace the live
    // preview with the canonical assistant.message when it lands.
    const buf = {
      assistantText: '',
      reasoningText: '',
      lastReasoning: '',
      toolInputs: new Map<string, { toolName: string; input: unknown }>(),
      toolOutputs: new Map<string, string>(),
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
      errorText: null as string | null,
    };

    this.activeTurnCtrls.set(s.id, ctrl);
    const offs: Array<() => void> = [];
    // session.idle is the ONLY loop-done signal. Subscribe before send().
    const idle = new Promise<void>((resolve) => {
      offs.push(session.on('session.idle', () => resolve()));
    });

    offs.push(
      session.on('assistant.message_delta', (e) => {
        if (e.agentId) return; // sub-agent internals
        buf.assistantText += e.data.deltaContent ?? '';
        cb.emitAssistantDelta(buf.assistantText);
        cb.bumpActivity();
      }),
    );

    offs.push(
      session.on('assistant.reasoning_delta', (e) => {
        if (e.agentId) return;
        buf.reasoningText += e.data.deltaContent ?? '';
        cb.emitReasoningDelta(buf.reasoningText);
        cb.bumpActivity();
      }),
    );

    offs.push(
      session.on('assistant.message', (e) => {
        if (e.agentId) return;
        const d = e.data;
        const now = Date.now();
        const msgs: Message[] = [];
        const assistantId = `copilot:${sid}:assistant:${d.messageId}`;
        // Reasoning first so it renders above the answer it produced. The
        // runtime repeats the same reasoningText on later assistant.message
        // events within a turn (verified live) — dedup against the last one
        // emitted or every tool round duplicates the reasoning card.
        const reasoning = d.reasoningText || buf.reasoningText;
        if (reasoning && reasoning.trim() && reasoning !== buf.lastReasoning) {
          buf.lastReasoning = reasoning;
          msgs.push({
            id: `copilot:${sid}:reasoning:${d.messageId}`,
            ts: now,
            kind: 'reasoning',
            text: reasoning,
          });
        }
        buf.reasoningText = '';
        cb.emitReasoningDelta('');
        if (typeof d.content === 'string' && d.content.trim()) {
          msgs.push({
            id: assistantId,
            ts: now + 1,
            kind: 'assistant',
            text: d.content,
            model: d.model ?? s.model ?? 'copilot',
          });
        }
        buf.assistantText = '';
        cb.emitAssistantDelta('');
        for (const tr of d.toolRequests ?? []) {
          buf.toolInputs.set(tr.toolCallId, { toolName: tr.name, input: tr.arguments ?? {} });
          msgs.push({
            id: `copilot:${sid}:tool_use:${tr.toolCallId}`,
            ts: now + 2,
            kind: 'tool_use',
            parentId: assistantId,
            toolUseId: tr.toolCallId,
            toolName: tr.name,
            input: tr.arguments ?? {},
          });
        }
        if (msgs.length > 0) {
          cb.pushMessages(msgs);
          cb.emitAssistantMessage(msgs);
        }
        cb.bumpActivity();
      }),
    );

    offs.push(
      session.on('tool.execution_start', (e) => {
        if (e.agentId) return;
        cb.setCurrentTool(e.data.toolName);
        // tool_use normally lands via assistant.message.toolRequests; keep a
        // fallback input record for partial-result rendering.
        if (!buf.toolInputs.has(e.data.toolCallId)) {
          buf.toolInputs.set(e.data.toolCallId, {
            toolName: e.data.toolName,
            input: e.data.arguments ?? {},
          });
        }
        cb.bumpActivity();
      }),
    );

    offs.push(
      session.on('tool.execution_partial_result', (e) => {
        if (e.agentId) return;
        const prev = buf.toolOutputs.get(e.data.toolCallId) ?? '';
        const next = prev + (e.data.partialOutput ?? '');
        buf.toolOutputs.set(e.data.toolCallId, next);
        const meta = buf.toolInputs.get(e.data.toolCallId);
        cb.emitToolDelta({
          toolName: meta?.toolName ?? 'tool',
          input: meta?.input ?? {},
          output: next,
          isError: false,
        });
        cb.bumpActivity();
      }),
    );

    offs.push(
      session.on('tool.execution_complete', (e) => {
        if (e.agentId) return;
        const msg: Message = {
          id: `copilot:${sid}:tool_result:${e.data.toolCallId}`,
          ts: Date.now(),
          kind: 'tool_result',
          toolUseId: e.data.toolCallId,
          output: renderToolResult(e.data.result),
          isError: e.data.success === false,
        };
        cb.pushMessages([msg]);
        cb.emitToolEvent([msg]);
        cb.incrementToolCount();
        cb.setCurrentTool(null);
        cb.emitToolDelta(null);
        buf.toolOutputs.delete(e.data.toolCallId);
        cb.bumpActivity();
      }),
    );

    offs.push(
      session.on('assistant.usage', (e) => {
        const u = e.data;
        buf.tokensIn += u.inputTokens ?? 0;
        buf.tokensOut += u.outputTokens ?? 0;
        buf.cacheRead += u.cacheReadTokens ?? 0;
        buf.cacheWrite += u.cacheWriteTokens ?? 0;
        cb.bumpActivity();
      }),
    );

    offs.push(
      session.on('session.error', (e) => {
        // session.error is an EVENT, not a throw — surface it and let the loop
        // end via session.idle.
        const message =
          (e.data && typeof e.data === 'object' && typeof (e.data as any).message === 'string'
            ? (e.data as any).message
            : null) ?? 'unknown session error';
        buf.errorText = message;
        const msg: Message = {
          id: `copilot:${sid}:error:${Date.now()}`,
          ts: Date.now(),
          kind: 'system',
          text: `Copilot error: ${message}`,
        };
        cb.pushMessages([msg]);
        cb.emitToolEvent([msg]);
        cb.emitAlert({
          category: 'turn',
          severity: 'error',
          title: 'Copilot session error',
          body: message,
        });
      }),
    );

    const onAbort = () => {
      void session.abort().catch(() => {}); // session.idle still fires after
    };
    ctrl.signal.addEventListener('abort', onAbort, { once: true });

    try {
      await session.send({
        prompt: text,
        ...(AGENT_MODES.has(s.mode) ? { agentMode: s.mode as 'interactive' | 'plan' | 'autopilot' } : {}),
      });
      await idle;

      // Defensive flush: assistant.message should have consumed these, but an
      // aborted/errored turn can leave streamed text behind — canonical
      // messages must replace the previews or the text vanishes on turn end.
      const now = Date.now();
      const leftovers: Message[] = [];
      if (buf.reasoningText.trim()) {
        leftovers.push({
          id: `copilot:${sid}:reasoning:${now}`,
          ts: now,
          kind: 'reasoning',
          text: buf.reasoningText,
        });
        cb.emitReasoningDelta('');
      }
      if (buf.assistantText.trim()) {
        leftovers.push({
          id: `copilot:${sid}:assistant:${now}`,
          ts: now + 1,
          kind: 'assistant',
          text: buf.assistantText,
          model: s.model ?? 'copilot',
        });
        cb.emitAssistantDelta('');
      }
      if (leftovers.length > 0) {
        cb.pushMessages(leftovers);
        cb.emitAssistantMessage(leftovers);
      }

      cb.applyUsage({
        tokensIn: buf.tokensIn,
        tokensOut: buf.tokensOut,
        cacheCreationTokens: buf.cacheWrite,
        cacheReadTokens: buf.cacheRead,
        costUsd: 0, // assistant.usage.cost is a billing multiplier, not USD
      });
      cb.emitTurnResult({
        subtype: ctrl.signal.aborted ? 'cancelled' : buf.errorText ? 'error' : 'success',
        totalCostUsd: 0,
        usage: {
          inputTokens: buf.tokensIn,
          outputTokens: buf.tokensOut,
          cacheCreationInputTokens: buf.cacheWrite,
          cacheReadInputTokens: buf.cacheRead,
        },
        text: null,
      });
      cb.emitStateSnapshot();
    } catch (err) {
      // Transport-level failure (RPC died / CLI child gone): drop the cached
      // session so the next turn re-resumes from disk, then rethrow for the
      // manager's turn-error surface.
      console.error('[copilot] turn failed', {
        sessionId: s.id,
        copilotSessionId: sid,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      const cached = this.sessions.get(s.id);
      if (cached) void cached.session.disconnect().catch(() => {});
      this.sessions.delete(s.id);
      throw err;
    } finally {
      ctrl.signal.removeEventListener('abort', onAbort);
      this.activeTurnCtrls.delete(s.id);
      for (const off of offs) off();
      cb.emitToolDelta(null);
      cb.setCurrentTool(null);
    }
  }

  private async getSession(s: AgentSession, cb: AdapterCallbacks): Promise<CopilotSession> {
    this.mtSessions.set(s.id, s);
    const effort = mapEffort(s.thinkingEffort);
    const model = s.model ?? null;
    const cached = this.sessions.get(s.id);
    if (
      cached &&
      cached.model === model &&
      cached.effort === effort &&
      cached.copilotSessionId === s.agentSessionId
    ) {
      return cached.session;
    }
    if (cached) await cached.session.disconnect().catch(() => {});
    this.sessions.delete(s.id);

    const client = await this.ensureClient();
    const config = this.buildSessionConfig(s);

    // The runtime HARD-FAILS session.create when reasoningEffort is set on a
    // model that doesn't support it (e.g. the session-wide effort seed landing
    // on claude-haiku). Detect that specific rejection and retry once without
    // the effort field — provider default kicks in, matching how the other
    // adapters degrade.
    const open = async (cfg: SessionConfigBase): Promise<CopilotSession> => {
      if (s.agentSessionId) {
        try {
          return await client.resumeSession(s.agentSessionId, cfg);
        } catch (err) {
          if (isEffortUnsupported(err)) throw err;
          console.warn('[copilot] resumeSession failed, creating fresh', {
            sessionId: s.id,
            copilotSessionId: s.agentSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Mint a fresh uuid we control — NOT s.id: /clear nulls agentSessionId
      // and must produce a brand-new provider conversation.
      return client.createSession({ ...cfg, sessionId: randomUUID() });
    };

    let session: CopilotSession;
    try {
      session = await open(config);
    } catch (err) {
      if (config.reasoningEffort && isEffortUnsupported(err)) {
        const { reasoningEffort: _drop, ...withoutEffort } = config;
        session = await open(withoutEffort);
      } else {
        throw err;
      }
    }

    if (session.sessionId !== s.agentSessionId) {
      const previous = s.agentSessionId;
      const nextHistory =
        previous && !s.agentSessionIdHistory.includes(previous)
          ? [...s.agentSessionIdHistory, previous]
          : s.agentSessionIdHistory;
      cb.onSessionIdAssigned(session.sessionId, nextHistory);
      cb.emitStateSnapshot();
    }

    this.sessions.set(s.id, { session, copilotSessionId: session.sessionId, model, effort });
    return session;
  }

  private buildSessionConfig(s: AgentSession): SessionConfigBase {
    const effort = mapEffort(s.thinkingEffort);
    return {
      workingDirectory: s.workingDir || undefined,
      streaming: true,
      ...(s.model ? { model: s.model } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      onPermissionRequest: (req, invocation) => this.handlePermission(s.id, req, invocation),
      onUserInputRequest: (req) => this.handleUserInput(s.id, req),
      onElicitationRequest: (ctx) => this.handleElicitation(s.id, ctx),
      onExitPlanModeRequest: (req) => this.handleExitPlanMode(s.id, req),
    };
  }

  // Copilot's native permission engine self-gates by agentMode (autopilot
  // auto-approves runtime-side), so this fires only when the runtime wants an
  // interactive decision. Route through the same prompt card Claude uses.
  private async handlePermission(
    mtSessionId: string,
    req: PermissionRequest,
    _invocation: { sessionId: string },
  ): Promise<PermissionRequestResult> {
    // Defensive: never prompt in autopilot even if the runtime asks.
    if (this.mtSessions.get(mtSessionId)?.mode === 'autopilot') {
      return { kind: 'approve-once' };
    }
    const { toolName, toolInput, extras } = describePermission(req);
    const signal = (this.activeTurnCtrls.get(mtSessionId) ?? new AbortController()).signal;
    const result = await this.permManager.requestFromSdk(
      mtSessionId,
      '',
      toolName,
      toolInput as Record<string, any>,
      signal,
      extras,
    );
    if (result.behavior === 'allow') return { kind: 'approve-once' };
    return { kind: 'reject', feedback: result.message };
  }

  // Copilot's ask_user tool → MultiTable's interactive question UI. Multiple
  // choice goes through the AskUserQuestion prompt card (grok pattern: the
  // answer comes back as a deny whose message is the answers JSON); freeform
  // questions reuse the elicitation FORM UI (the question card has no text
  // input; ElicitationModal renders string fields from a schema).
  private async handleUserInput(
    mtSessionId: string,
    req: UserInputRequest,
  ): Promise<UserInputResponse> {
    const signal = (this.activeTurnCtrls.get(mtSessionId) ?? new AbortController()).signal;
    if (Array.isArray(req.choices) && req.choices.length > 0) {
      const result = await this.permManager.requestFromSdk(
        mtSessionId,
        '',
        'AskUserQuestion',
        {
          questions: [
            {
              question: req.question,
              header: 'Copilot',
              multiSelect: false,
              options: req.choices.map((label) => ({ label })),
            },
          ],
        },
        signal,
      );
      if (result.behavior === 'deny' && result.message) {
        try {
          const parsed = JSON.parse(result.message) as {
            questions?: Array<{ answer?: unknown }>;
          };
          const answer = Array.isArray(parsed.questions?.[0]?.answer)
            ? (parsed.questions[0].answer as unknown[]).filter(
                (a): a is string => typeof a === 'string',
              )
            : [];
          if (answer.length > 0) return { answer: answer.join(', '), wasFreeform: false };
        } catch {
          // non-JSON deny ('Cancelled' / 'Session cleared') → cancelled
        }
      }
      return { answer: '', wasFreeform: false };
    }
    // Freeform question → one-field elicitation form.
    const res = await this.elicitManager.requestFromSdk(
      mtSessionId,
      {
        serverName: 'copilot',
        message: req.question,
        mode: 'form',
        requestedSchema: {
          type: 'object',
          properties: { answer: { type: 'string', title: 'Answer' } },
          required: ['answer'],
        },
        title: 'Copilot asks',
      },
      signal,
    );
    const answer =
      res.action === 'accept' && typeof res.content?.answer === 'string' ? res.content.answer : '';
    return { answer, wasFreeform: true };
  }

  private async handleElicitation(
    mtSessionId: string,
    ctx: ElicitationContext,
  ): Promise<ElicitationResult> {
    const signal = (this.activeTurnCtrls.get(mtSessionId) ?? new AbortController()).signal;
    const res = await this.elicitManager.requestFromSdk(
      mtSessionId,
      {
        serverName: ctx.elicitationSource || 'copilot',
        message: ctx.message,
        mode: ctx.mode === 'url' ? 'url' : 'form',
        url: ctx.url,
        requestedSchema: ctx.requestedSchema as Record<string, unknown> | undefined,
      },
      signal,
    );
    if (res.action === 'accept') return { action: 'accept', content: res.content ?? {} };
    return { action: res.action };
  }

  // Native plan-mode gate: the runtime finished planning and asks to proceed.
  // Same prompt card as Grok's exit_plan_mode / Claude's ExitPlanMode.
  private async handleExitPlanMode(
    mtSessionId: string,
    req: ExitPlanModeRequest,
  ): Promise<ExitPlanModeResult> {
    if (this.mtSessions.get(mtSessionId)?.mode === 'autopilot') {
      return { approved: true, selectedAction: req.recommendedAction };
    }
    const signal = (this.activeTurnCtrls.get(mtSessionId) ?? new AbortController()).signal;
    const result = await this.permManager.requestFromSdk(
      mtSessionId,
      '',
      'ExitPlanMode',
      { plan: req.planContent ?? req.summary },
      signal,
      { title: 'Review plan & execute', displayName: 'exit_plan_mode' },
    );
    if (result.behavior === 'allow') {
      return { approved: true, selectedAction: req.recommendedAction };
    }
    return { approved: false, feedback: result.message };
  }
}

// account.getQuota → AccountGetQuotaResult.quotaSnapshots, keyed by quota type
// (premium_interactions is the one that matters for Copilot billing). Each
// snapshot: { isUnlimitedEntitlement, entitlementRequests, usedRequests,
// remainingPercentage, overage, resetDate? }.
function normalizeQuota(
  snapshots: Record<string, unknown> | undefined | null,
): UsageLimitSnapshot | null {
  if (!snapshots || typeof snapshots !== 'object') return null;
  const raw = (snapshots['premium_interactions'] ??
    snapshots['premiumInteractions'] ??
    Object.values(snapshots)[0]) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const remainingPct =
    typeof raw.remainingPercentage === 'number' ? raw.remainingPercentage : null;
  const entitlement =
    typeof raw.entitlementRequests === 'number' ? raw.entitlementRequests : null;
  const used = typeof raw.usedRequests === 'number' ? raw.usedRequests : null;
  const unlimited = raw.isUnlimitedEntitlement === true;
  const resetsAt =
    typeof raw.resetDate === 'string' && !Number.isNaN(Date.parse(raw.resetDate))
      ? Date.parse(raw.resetDate)
      : null;
  const usedPercent = unlimited
    ? 0
    : remainingPct != null
      ? Math.min(100, Math.max(0, Math.round(100 - remainingPct)))
      : entitlement && used != null && entitlement > 0
        ? Math.min(100, Math.round((used / entitlement) * 100))
        : null;
  if (usedPercent == null) return null;
  return {
    status: 'live',
    source: 'copilot',
    windows: [{ label: 'Premium requests', usedPercent, resetsAt }],
    creditsRemaining:
      !unlimited && entitlement != null && used != null ? Math.max(0, entitlement - used) : null,
    capturedAt: Date.now(),
  };
}
