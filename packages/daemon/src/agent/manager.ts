import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentSession, SendTurnInput, AlertSeverity } from './types.js';
import type { ProcessState } from '../types.js';
import type { Message } from '../transcripts/parser.js';
import { parseCodexThread } from '../transcripts/codexParser.js';
import type { PermissionManager } from '../hooks/permissionManager.js';
import type { ElicitationManager } from '../hooks/elicitationManager.js';
import type { OnElicitation } from '@anthropic-ai/claude-agent-sdk';
import {
  sdkSystemInit,
  sdkAssistantToMessages,
  sdkUserToMessages,
  sdkResult,
} from './sdkAdapter.js';
import { createAlert } from './alerts.js';
import { updateSession, insertCostRecord, getSessionById } from '../db/store.js';
import { detectOptions } from '../hooks/optionDetector.js';
import { CodexAdapter } from './providers/codex.js';
import type { AdapterCallbacks } from './providers/types.js';

// Agent-modal defaults from AddAgentModal — session.name matching one of these
// is considered unnamed and eligible for auto-rename from the first prompt.
const AGENT_DEFAULT_NAMES = new Set([
  'Claude Code',
  'Codex',
  'Gemini CLI',
  'Amp',
  'Aider',
  'Goose',
]);

const requireFromHere = createRequire(__filename);

function isMuslRuntime(): boolean {
  const report = typeof process.report?.getReport === 'function'
    ? process.report.getReport() as { header?: { glibcVersionRuntime?: string } }
    : null;
  return process.platform === 'linux' && !report?.header?.glibcVersionRuntime;
}

function resolveClaudeCodeExecutable(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  const arch = process.arch;
  const libcSuffix = isMuslRuntime() ? '-musl' : '';
  const preferred = `@anthropic-ai/claude-agent-sdk-linux-${arch}${libcSuffix}/claude`;
  const fallback = `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`;
  for (const specifier of [preferred, fallback]) {
    try {
      return requireFromHere.resolve(specifier);
    } catch {
      /* try next candidate */
    }
  }
  return undefined;
}

function titleFromFirstPrompt(prompt: string, maxLen = 60): string {
  const firstLine = prompt.split('\n', 1)[0] ?? prompt;
  const cleaned = firstLine.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1).trimEnd() + '…';
}

type RegisterInput = Omit<
  AgentSession,
  | 'state'
  | 'currentTurn'
  | 'startedAt'
  | 'provider'
  | 'model'
  | 'agentSessionId'
  | 'agentSessionIdHistory'
  | 'claudeSessionId'
  | 'claudeSessionIdHistory'
  | 'totalCostUsd'
  | 'tokensIn'
  | 'tokensOut'
  | 'cacheCreationTokens'
  | 'cacheReadTokens'
  | 'toolCount'
  | 'currentTool'
  | 'activeSubagents'
  | 'lastActivity'
  | 'userMessages'
  | 'messages'
  | 'streamingText'
  | 'streamingBlockIndex'
> &
  Partial<
    Pick<
      AgentSession,
      | 'provider'
      | 'model'
      | 'agentSessionId'
      | 'agentSessionIdHistory'
      | 'claudeSessionId'
      | 'claudeSessionIdHistory'
    >
  >;

export class AgentSessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>();
  private codexAdapter = new CodexAdapter();
  private permManager: PermissionManager;
  private elicitManager: ElicitationManager;

  constructor(permManager: PermissionManager, elicitManager: ElicitationManager) {
    super();
    this.permManager = permManager;
    this.elicitManager = elicitManager;
  }

  /**
   * Register a session with the manager. Pure bookkeeping: initializes all
   * stat fields to zero/empty defaults, sets state to 'stopped', stores the
   * session in the in-memory map, and returns it.
   */
  register(input: RegisterInput): AgentSession {
    const existing = this.sessions.get(input.id);
    if (existing) return existing;
    const session: AgentSession = {
      id: input.id,
      projectId: input.projectId,
      name: input.name,
      workingDir: input.workingDir,
      provider: input.provider ?? 'claude',
      model: input.model ?? null,
      agentSessionId: input.agentSessionId ?? input.claudeSessionId ?? null,
      agentSessionIdHistory: [
        ...(input.agentSessionIdHistory ?? input.claudeSessionIdHistory ?? []),
      ],
      claudeSessionId: input.claudeSessionId ?? input.agentSessionId ?? null,
      claudeSessionIdHistory: [
        ...(input.claudeSessionIdHistory ?? input.agentSessionIdHistory ?? []),
      ],
      state: 'stopped',
      startedAt: null,
      currentTurn: null,
      totalCostUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      toolCount: 0,
      currentTool: null,
      activeSubagents: 0,
      lastActivity: 0,
      userMessages: [],
      messages: [],
      streamingText: '',
      streamingBlockIndex: null,
    };
    this.sessions.set(session.id, session);
    // Codex sessions have no JSONL parser at the API layer — the daemon's own
    // s.messages is the source of truth. Hydrate from the codex CLI's
    // ~/.codex/sessions/<thread_id> rollout file so reconnects after a daemon
    // restart show the prior conversation. Failures are non-fatal — a brand
    // new session has no file yet, which is expected.
    if (session.provider === 'codex' && session.agentSessionId) {
      try {
        const hydrated = parseCodexThread(session.agentSessionId);
        if (hydrated.length > 0) session.messages = hydrated;
      } catch (err) {
        console.error('[agent] codex hydration failed for', session.id, err);
      }
    }
    return session;
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  getAll(): AgentSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Drive one user turn through the SDK. Serialized per session: throws if a
   * turn is already in flight. Emits state-changed/user-message/assistant-
   * message/tool-event/turn-result/turn-error/turn-complete events so
   * server.ts can broadcast to WebSocket subscribers.
   */
  async sendTurn({ sessionId, text }: SendTurnInput): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    if (s.currentTurn) throw new Error('turn already in flight');

    const ctrl = new AbortController();
    const turnStartedAt = Date.now();
    // Random suffix avoids a collision if two sendTurn calls happen in the
    // same millisecond — the frontend dedups optimistic-vs-canonical user
    // messages by content + near-time, which would falsely collapse two
    // legitimate sends if their optimistic ids happened to match.
    const userMessageId = `turn-${turnStartedAt}-${Math.random().toString(36).slice(2, 8)}`;
    s.currentTurn = {
      abortController: ctrl,
      startedAt: turnStartedAt,
      promptPreview: text.slice(0, 80),
      userMessageId,
    };
    s.state = 'running';
    s.lastActivity = Date.now();
    s.userMessages.push(text);
    if (!s.startedAt) s.startedAt = new Date();

    try {
      updateSession(sessionId, { lastActiveAt: s.lastActivity });
    } catch {
      /* don't let a DB hiccup block the turn */
    }

    this.emit('state-changed', { sessionId, state: 'running' as ProcessState });

    // Always surface the submitted prompt immediately. Claude's SDK does not
    // reliably echo user messages for resumed sessions; Codex does not emit a
    // separate user item at all. If Claude later sends the same user message,
    // handleSdkMessage suppresses that duplicate.
    const userMsg: Message = {
      id: s.currentTurn.userMessageId,
      ts: s.currentTurn.startedAt,
      kind: 'user',
      text,
    };
    s.messages.push(userMsg);
    this.emit('user-message', { sessionId, messages: [userMsg] });

    // Watchdog: if the SDK iterator yields no message for this long, abort
    // the turn and surface a clear error. Catches silent hangs (TLS retry
    // loops, stuck subprocess, network drops) that would otherwise leave the
    // UI spinning forever.
    //
    // The iterator legitimately goes silent in two cases that aren't hangs:
    //   1. canUseTool / onElicitation are awaiting a user decision — the
    //      permission card / elicitation modal is up on the UI.
    //   2. A tool is executing (long bash, npm install, build, tests). The
    //      SDK only yields again when the tool completes and the tool_result
    //      message comes back.
    // Both can take many minutes. We handle (1) by re-arming whenever a
    // permission/elicitation is pending instead of aborting, and (2) by
    // budgeting 5 minutes per silent stretch instead of 60s.
    const NO_PROGRESS_MS = 5 * 60_000;
    let stuckTimer: NodeJS.Timeout | null = null;
    let abortedDueToStuck = false;
    let sawAnyMessage = false;
    const armStuckTimer = () => {
      if (stuckTimer) clearTimeout(stuckTimer);
      stuckTimer = setTimeout(() => {
        if (
          this.permManager.hasPending(sessionId) ||
          this.elicitManager.hasPending(sessionId)
        ) {
          armStuckTimer();
          return;
        }
        abortedDueToStuck = true;
        try {
          ctrl.abort();
        } catch {
          /* ignore */
        }
      }, NO_PROGRESS_MS);
    };

    try {
      if (s.provider === 'codex') {
        await this.codexAdapter.runTurn(s, text, ctrl, this.makeAdapterCallbacks(sessionId));
      } else {
        const pathToClaudeCodeExecutable = resolveClaudeCodeExecutable();
        const it = query({
          prompt: text,
          options: {
            cwd: s.workingDir,
            ...(s.claudeSessionId ? { resume: s.claudeSessionId } : {}),
            ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
            ...(s.model ? { model: s.model } : {}),
            settingSources: ['project', 'user'],
            permissionMode: 'default',
            canUseTool: this.makeCanUseTool(sessionId),
            onElicitation: this.makeOnElicitation(sessionId),
            hooks: this.makeHooks(sessionId),
            includePartialMessages: true,
            // NOTE: Phase 0 correction — SDK accepts the controller, NOT just its signal.
            abortController: ctrl,
          },
        });
        armStuckTimer();
        for await (const msg of it) {
          sawAnyMessage = true;
          armStuckTimer();
          try {
            this.handleSdkMessage(sessionId, msg);
          } catch (handlerErr) {
            // Don't let a handler bug abort the whole turn — log and continue.
            console.error('[agent] handler error:', handlerErr);
          }
        }
      }
      if (abortedDueToStuck) {
        throw new Error(
          sawAnyMessage
            ? `Claude API went silent for ${NO_PROGRESS_MS / 1000}s mid-turn — aborted.`
            : `No response from Claude API in ${NO_PROGRESS_MS / 1000}s. ` +
              `Check NODE_EXTRA_CA_CERTS (corporate TLS), ANTHROPIC_API_KEY, or network connection.`,
        );
      }
    } catch (err: unknown) {
      const baseMessage = err instanceof Error ? err.message : String(err);
      const message =
        abortedDueToStuck && !/Claude API/.test(baseMessage)
          ? `No response from Claude API in ${NO_PROGRESS_MS / 1000}s. ` +
            `Check NODE_EXTRA_CA_CERTS (corporate TLS), ANTHROPIC_API_KEY, or network connection. ` +
            `(${baseMessage})`
          : baseMessage;
      if (s.provider === 'codex') {
        this.codexAdapter.reset?.(s);
        console.error('[agent] Codex turn failed', {
          sessionId,
          threadId: s.agentSessionId,
          error: err instanceof Error ? err.stack ?? err.message : String(err),
        });
      }
      // Stable id keyed off the turn start time so a WS reconnect that
      // re-delivers the same event doesn't render a second error bubble.
      const errorId =
        s.provider === 'codex'
          ? `codex:${s.agentSessionId ?? 'pending'}:turn-error:${turnStartedAt}`
          : `turn-error:${sessionId}:${turnStartedAt}`;
      const errorMsg: Message = {
        id: errorId,
        ts: Date.now(),
        kind: 'system',
        text: `Turn failed: ${message}`,
      };
      s.messages.push(errorMsg);
      this.emit('tool-event', { sessionId, messages: [errorMsg] });
      s.state = 'errored';
      this.emit('turn-error', { sessionId, error: message });
      this.emit('state-changed', { sessionId, state: 'errored' as ProcessState });
      this.emitAlert({
        sessionId,
        category: 'turn',
        severity: 'error',
        title: 'Turn failed',
        body: message,
      });
    } finally {
      if (stuckTimer) clearTimeout(stuckTimer);
      s.currentTurn = null;
      // Safety: turn ended (success or error) — wipe any leftover streaming
      // text so the UI doesn't keep showing a stale partial.
      if (s.streamingText !== '' || s.streamingBlockIndex !== null) {
        s.streamingText = '';
        s.streamingBlockIndex = null;
        this.emit('assistant-delta', { sessionId, text: '' });
      }
      // Same safety for codex live tool/reasoning previews.
      this.emit('tool-delta', { sessionId, payload: null });
      this.emit('reasoning-delta', { sessionId, text: '' });
      if (s.state === 'running') {
        s.state = 'stopped';
        this.emit('state-changed', { sessionId, state: 'stopped' as ProcessState });
      }
      s.lastActivity = Date.now();
      try {
        updateSession(sessionId, { lastActiveAt: s.lastActivity });
      } catch {
        /* see note above */
      }
      this.emit('turn-complete', { sessionId });
    }
  }

  /**
   * Build the AdapterCallbacks bag for a given session id. Provider adapters
   * call into this when they produce SDK output; the manager owns the actual
   * EventEmitter surface, the in-memory AgentSession, and the DB writes.
   *
   * Adding a new provider = drop a new adapter file under agent/providers/,
   * implement ProviderAdapter, and dispatch to it in sendTurn (one branch).
   */
  private makeAdapterCallbacks(sessionId: string): AdapterCallbacks {
    return {
      emitAssistantMessage: (messages) => this.emit('assistant-message', { sessionId, messages }),
      emitAssistantDelta: (text) => {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        s.streamingText = text;
        s.streamingBlockIndex = null;
        s.lastActivity = Date.now();
        this.emit('assistant-delta', { sessionId, text });
      },
      emitToolEvent: (messages) => this.emit('tool-event', { sessionId, messages }),
      emitUserMessage: (messages) => this.emit('user-message', { sessionId, messages }),
      pushMessages: (messages) => {
        const s = this.sessions.get(sessionId);
        if (s) s.messages.push(...messages);
      },
      onSessionIdAssigned: (newId, history) => {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        s.agentSessionId = newId;
        s.agentSessionIdHistory = history;
        // Mirror to the legacy claudeSessionId fields so existing code paths
        // (cost endpoint, AddAgentModal, etc.) keep working during the
        // back-compat window.
        s.claudeSessionId = newId;
        s.claudeSessionIdHistory = history;
        try {
          updateSession(sessionId, {
            agentSessionId: newId,
            agentSessionIdHistory: history,
            claudeSessionId: newId,
            claudeSessionIdHistory: history,
          });
        } catch (err) {
          console.error('[agent] failed to persist agent session id:', err);
        }
        this.emit('session-updated', { sessionId, claudeSessionId: newId });
      },
      emitStateSnapshot: () => {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        this.emit('state-snapshot', { sessionId, snapshot: this.snapshotStats(s) });
      },
      applyUsage: ({ tokensIn, tokensOut, cacheCreationTokens, cacheReadTokens, costUsd }) => {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        s.tokensIn += tokensIn;
        s.tokensOut += tokensOut;
        s.cacheCreationTokens += cacheCreationTokens;
        s.cacheReadTokens += cacheReadTokens;
        s.totalCostUsd += costUsd;
        try {
          insertCostRecord({ sessionId, tokensIn, tokensOut, costUsd });
        } catch (err) {
          console.error('[agent] failed to insert usage record:', err);
        }
      },
      emitTurnResult: (input) => this.emit('turn-result', { sessionId, ...input }),
      setCurrentTool: (name) => {
        const s = this.sessions.get(sessionId);
        if (s) s.currentTool = name;
      },
      bumpActivity: () => {
        const s = this.sessions.get(sessionId);
        if (s) s.lastActivity = Date.now();
      },
      maybeRenameFromFirstPrompt: (prompt) => this.maybeRenameFromFirstPrompt(sessionId, prompt),
      emitReconciled: (addedMessageIds) =>
        this.emit('reconciled', { sessionId, addedMessageIds }),
      emitToolDelta: (payload) => this.emit('tool-delta', { sessionId, payload }),
      emitReasoningDelta: (text) => this.emit('reasoning-delta', { sessionId, text }),
      emitMessageRekey: (oldId, newId) =>
        this.emit('message-rekeyed', { sessionId, oldId, newId }),
    };
  }

  /**
   * Handle a `stream_event` SDK message — the SDK forwards the raw Anthropic
   * SSE event stream when `includePartialMessages: true`. We only react to
   * text deltas (the most useful streaming signal in a chat UI). Tool-input
   * JSON deltas and metadata events fall through as no-ops; the canonical
   * `assistant` message arrives at the end and remains the source of truth
   * for rendering the final turn.
   *
   * Event shapes (Anthropic SSE):
   *   message_start          — start of an assistant message
   *   content_block_start    — { index, content_block: { type: 'text' | 'tool_use', ... } }
   *   content_block_delta    — { index, delta: { type: 'text_delta', text } | { type: 'input_json_delta', partial_json } }
   *   content_block_stop     — { index }
   *   message_delta          — { delta: { stop_reason }, usage }
   *   message_stop           — terminator
   */
  private handleStreamEvent(sessionId: string, msg: unknown): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (!msg || typeof msg !== 'object') return;
    const wrapper = msg as { event?: unknown };
    // The SDK either passes the SSE event verbatim under msg.event or inlines
    // it on the top-level. Be defensive about both shapes.
    const inner = (wrapper.event ?? msg) as { type?: string; index?: number; delta?: unknown; content_block?: unknown };
    const t = inner.type;
    switch (t) {
      case 'content_block_start': {
        const cb = inner.content_block as { type?: string } | undefined;
        const idx = typeof inner.index === 'number' ? inner.index : null;
        if (cb && cb.type === 'text') {
          s.streamingBlockIndex = idx;
          s.streamingText = '';
          this.emit('assistant-delta', { sessionId, text: '' });
        } else {
          // tool_use or other block — clear any previously displayed text
          // partial so the UI doesn't show stale text while a tool is forming.
          if (s.streamingText !== '' || s.streamingBlockIndex !== null) {
            s.streamingText = '';
            s.streamingBlockIndex = null;
            this.emit('assistant-delta', { sessionId, text: '' });
          }
        }
        return;
      }
      case 'content_block_delta': {
        const idx = typeof inner.index === 'number' ? inner.index : null;
        if (s.streamingBlockIndex !== idx) return; // delta for non-text block
        const delta = inner.delta as { type?: string; text?: unknown } | undefined;
        if (!delta || delta.type !== 'text_delta') return;
        if (typeof delta.text !== 'string') return;
        s.streamingText += delta.text;
        s.lastActivity = Date.now();
        this.emit('assistant-delta', { sessionId, text: s.streamingText });
        return;
      }
      case 'content_block_stop': {
        const idx = typeof inner.index === 'number' ? inner.index : null;
        if (s.streamingBlockIndex !== idx) return;
        // Leave the accumulated text on screen until the canonical `assistant`
        // message arrives and replaces it. Just close the block tracker.
        s.streamingBlockIndex = null;
        return;
      }
      case 'message_stop': {
        s.streamingText = '';
        s.streamingBlockIndex = null;
        this.emit('assistant-delta', { sessionId, text: '' });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Dispatch one SDK message to event consumers. Tolerates the full ~30-variant
   * SDK message union via a `default` branch that silently ignores types we
   * don't consume today. Only reacts to: system/init, assistant, user, result.
   */
  private handleSdkMessage(sessionId: string, msg: unknown): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; subtype?: string };

    switch (m.type) {
      case 'system': {
        switch (m.subtype) {
          case 'init': {
            const info = sdkSystemInit(msg);
            if (!info) return;
            const newSid = info.claudeSessionId;
            if (newSid && newSid !== s.claudeSessionId) {
              // The SDK assigns a new claudeSessionId on certain resume paths
              // (claude-code#8069, closed not-planned). The OLD id still names
              // the JSONL containing prior history, so we must remember it —
              // otherwise the messages endpoint reads only the post-fork file
              // and the UI shows no scrollback.
              const previousSid = s.claudeSessionId;
              const nextHistory =
                previousSid && !s.claudeSessionIdHistory.includes(previousSid)
                  ? [...s.claudeSessionIdHistory, previousSid]
                  : s.claudeSessionIdHistory;
              s.claudeSessionId = newSid;
              s.claudeSessionIdHistory = nextHistory;
              s.agentSessionId = newSid;
              s.agentSessionIdHistory = nextHistory;
              try {
                updateSession(sessionId, {
                  agentSessionId: newSid,
                  agentSessionIdHistory: nextHistory,
                  claudeSessionId: newSid,
                  claudeSessionIdHistory: nextHistory,
                });
              } catch (err) {
                console.error('[agent] failed to persist claudeSessionId:', err);
              }
              this.emit('session-updated', { sessionId, claudeSessionId: newSid });
            }
            return;
          }
          case 'notification': {
            this.handleSdkNotificationMessage(sessionId, msg);
            return;
          }
          case 'compact_boundary': {
            this.handleCompactBoundary(sessionId, msg);
            return;
          }
          case 'mirror_error': {
            this.handleMirrorError(sessionId, msg);
            return;
          }
          case 'api_retry': {
            this.handleApiRetry(sessionId, msg);
            return;
          }
          case 'status': {
            this.handleStatus(sessionId, msg);
            return;
          }
          case 'task_started':
          case 'task_progress':
          case 'task_updated':
          case 'task_notification': {
            this.handleTaskEvent(sessionId, m.subtype, msg);
            return;
          }
          default:
            return;
        }
      }
      case 'rate_limit_event': {
        this.handleRateLimitEvent(sessionId, msg);
        return;
      }
      case 'auth_status': {
        this.handleAuthStatus(sessionId, msg);
        return;
      }
      case 'tool_progress': {
        this.handleToolProgress(sessionId, msg);
        return;
      }
      case 'assistant': {
        const messages = sdkAssistantToMessages(msg);
        if (messages.length === 0) return;
        for (const out of messages) {
          if (out.kind === 'tool_use') {
            s.toolCount += 1;
            s.currentTool = out.toolName || s.currentTool;
          }
        }
        s.lastActivity = Date.now();
        // Final assistant message arrived — clear any in-flight streaming
        // text so the UI replaces the partial preview with the canonical
        // rendered messages.
        if (s.streamingText !== '' || s.streamingBlockIndex !== null) {
          s.streamingText = '';
          s.streamingBlockIndex = null;
          this.emit('assistant-delta', { sessionId, text: '' });
        }
        s.messages.push(...messages);
        this.emit('assistant-message', { sessionId, messages });
        return;
      }
      case 'stream_event': {
        this.handleStreamEvent(sessionId, msg);
        return;
      }
      case 'user': {
        const messages = sdkUserToMessages(msg);
        if (messages.length === 0) return;
        const toolEvents: Message[] = [];
        const userMessages: Message[] = [];
        for (const out of messages) {
          if (out.kind === 'tool_result') {
            toolEvents.push(out);
          } else if (out.kind === 'user') {
            userMessages.push(out);
          }
        }
        if (toolEvents.length > 0) {
          // Tool call completed — clear currentTool.
          s.currentTool = null;
          s.messages.push(...toolEvents);
          this.emit('tool-event', { sessionId, messages: toolEvents });
        }
        if (userMessages.length > 0) {
          // Suppress the SDK's echo of the prompt we already pushed optimistically
          // at sendTurn start. We compare on normalized text rather than exact
          // text because Claude's SDK sometimes reformats whitespace / expands
          // slash commands on the way through. We also suppress when the SDK
          // emits a message whose id collides with one already in s.messages
          // (defensive against future SDK changes that pass the optimistic id
          // through verbatim).
          const optimisticId = s.currentTurn?.userMessageId ?? null;
          const lastPrompt = s.userMessages[s.userMessages.length - 1] ?? '';
          const norm = (t: string) => t.trim().replace(/\s+/g, ' ');
          const lastPromptNorm = norm(lastPrompt);
          const seenIds = new Set(s.messages.map((m) => m.id));
          const filtered = userMessages.filter((u) => {
            if (u.kind !== 'user') return true;
            if (s.currentTurn !== null && norm(u.text) === lastPromptNorm) return false;
            if (optimisticId && u.id === optimisticId) return false;
            if (seenIds.has(u.id)) return false;
            return true;
          });
          if (filtered.length === 0) {
            s.lastActivity = Date.now();
            return;
          }
          s.messages.push(...filtered);
          this.emit('user-message', { sessionId, messages: filtered });
        }
        s.lastActivity = Date.now();
        return;
      }
      case 'result': {
        const info = sdkResult(msg);
        if (!info) return;
        s.totalCostUsd += info.totalCostUsd;
        s.tokensIn += info.usage.inputTokens;
        s.tokensOut += info.usage.outputTokens;
        s.cacheCreationTokens += info.usage.cacheCreationInputTokens;
        s.cacheReadTokens += info.usage.cacheReadInputTokens;
        s.lastActivity = Date.now();
        try {
          insertCostRecord({
            sessionId,
            tokensIn: info.usage.inputTokens,
            tokensOut: info.usage.outputTokens,
            costUsd: info.totalCostUsd,
          });
        } catch (err) {
          console.error('[agent] failed to insert cost record:', err);
        }
        this.emit('turn-result', {
          sessionId,
          subtype: info.subtype,
          totalCostUsd: info.totalCostUsd,
          usage: info.usage,
          text: info.text,
        });
        // Phase 7: broadcast updated stats live so the cost panel refreshes
        // without waiting for JSONL re-parse. server.ts re-emits this as
        // `session:state-updated` to all clients.
        this.emit('state-snapshot', { sessionId, snapshot: this.snapshotStats(s) });
        this.maybeEmitResultAlert(sessionId, info.subtype, info.totalCostUsd);
        return;
      }
      default:
        // Silently ignore every other SDK message variant (stream_event,
        // rate_limit_event, tool_progress, hook_*, task_*, compact_boundary,
        // notification, etc.). Phase 7 may revisit.
        return;
    }
  }

  /**
   * Build the canUseTool callback the SDK invokes for every tool call.
   * Delegates to PermissionManager.requestFromSdk, which mirrors the existing
   * hook-based state machine (auto-defer, allowlist, dedup, 110s timeout)
   * and resolves to an SDK PermissionResult. We pass through the Claude-
   * rendered labels (title/displayName/subtitle/blockedPath) so the UI can
   * eventually render them; today the existing PermissionBar still works
   * unchanged off toolName/toolInput.
   */
  private makeCanUseTool(sessionId: string) {
    return async (
      toolName: string,
      toolInput: Record<string, unknown>,
      opts: {
        signal: AbortSignal;
        title?: string;
        displayName?: string;
        subtitle?: string;
        blockedPath?: string;
        decisionReason?: string;
        suggestions?: unknown;
      },
    ) => {
      const s = this.sessions.get(sessionId);
      if (!s) {
        return { behavior: 'deny' as const, message: 'unknown session' };
      }
      return await this.permManager.requestFromSdk(
        sessionId,
        s.claudeSessionId ?? '',
        toolName,
        toolInput as Record<string, any>,
        opts.signal,
        {
          title: opts.title,
          displayName: opts.displayName,
          subtitle: opts.subtitle,
          blockedPath: opts.blockedPath,
        },
      );
    };
  }

  /**
   * Build the onElicitation callback the SDK invokes when an MCP server asks
   * for structured user input (form mode) or browser-based auth (url mode).
   * Delegates to ElicitationManager.requestFromSdk; returned action+content
   * is forwarded back to the MCP server by the SDK. Also emits an attention-
   * level alert so the UI surfaces the request even when the user is on a
   * different session.
   */
  private makeOnElicitation(sessionId: string): OnElicitation {
    return async (request, opts) => {
      this.emitAlert({
        sessionId,
        category: 'elicitation',
        severity: 'attention',
        title: request.title || `${request.serverName} needs input`,
        body: request.message,
        metadata: {
          serverName: request.serverName,
          mode: request.mode ?? 'form',
        },
      });
      const result = await this.elicitManager.requestFromSdk(sessionId, request, opts.signal);
      // ElicitationResult has a loose index signature in the MCP schema; our
      // narrower runtime shape is structurally compatible.
      return result as unknown as Awaited<ReturnType<OnElicitation>>;
    };
  }

  /**
   * Abort an in-flight turn. The `for await` loop in sendTurn will exit and
   * the `finally` block handles the state cleanup + turn-complete emission.
   */
  abortTurn(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (!s.currentTurn) return;
    try {
      s.currentTurn.abortController.abort();
    } catch (err) {
      console.error('[agent] abortTurn failed:', err);
    }
  }

  /**
   * Remove a session from the manager. Aborts any in-flight turn and clears
   * outstanding permission prompts for the session before deletion.
   */
  remove(sessionId: string): void {
    this.abortTurn(sessionId);
    try {
      this.permManager.clearForSession(sessionId);
    } catch (err) {
      console.error('[agent] clearForSession failed:', err);
    }
    try {
      this.elicitManager.clearForSession(sessionId);
    } catch (err) {
      console.error('[agent] elicit clearForSession failed:', err);
    }
    const s = this.sessions.get(sessionId);
    if (s) this.codexAdapter.reset?.(s);
    this.sessions.delete(sessionId);
  }

  resetSession(sessionId: string): void {
    this.abortTurn(sessionId);
    const s = this.sessions.get(sessionId);
    if (s) this.codexAdapter.reset?.(s);
    if (!s) return;
    s.agentSessionId = null;
    s.agentSessionIdHistory = [];
    s.claudeSessionId = null;
    s.claudeSessionIdHistory = [];
    s.userMessages = [];
    s.messages = [];
    s.toolCount = 0;
    s.currentTool = null;
    s.tokensIn = 0;
    s.tokensOut = 0;
    s.cacheCreationTokens = 0;
    s.cacheReadTokens = 0;
    s.totalCostUsd = 0;
    s.streamingText = '';
    s.streamingBlockIndex = null;
    s.lastActivity = Date.now();
    this.emit('state-snapshot', { sessionId, snapshot: this.snapshotStats(s) });
  }

  /**
   * Emit a unified alert envelope. server.ts re-broadcasts as `session:alert`.
   */
  private emitAlert(input: Parameters<typeof createAlert>[0]): void {
    this.emit('alert', { alert: createAlert(input) });
  }

  /**
   * Surface budget/turn-limit and structured-output-retry exhaustion as alerts.
   * Plain `result` with subtype 'success' or 'error_during_execution' are
   * handled by the existing `turn-result` event and don't need a banner.
   */
  private maybeEmitResultAlert(sessionId: string, subtype: string, totalCostUsd: number): void {
    if (subtype === 'error_max_budget_usd') {
      this.emitAlert({
        sessionId,
        category: 'budget',
        severity: 'error',
        title: 'Budget limit reached',
        body: `Spent $${totalCostUsd.toFixed(4)}; turn stopped at the configured maxBudgetUsd.`,
      });
    } else if (subtype === 'error_max_turns') {
      this.emitAlert({
        sessionId,
        category: 'budget',
        severity: 'error',
        title: 'Turn limit reached',
        body: 'Conversation hit the configured maxTurns ceiling.',
      });
    } else if (subtype === 'error_max_structured_output_retries') {
      this.emitAlert({
        sessionId,
        category: 'budget',
        severity: 'error',
        title: 'Structured-output retries exhausted',
        body: 'Claude could not produce a valid structured response after the maximum retries.',
      });
    }
  }

  // ─── Phase 4: SDK message-type handlers ─────────────────────────────────
  //
  // Each handler is fed the raw SDK message; it extracts what it needs and
  // emits a typed `session:alert`. All are best-effort — any missing field
  // falls back to a sensible default so a future SDK shape change doesn't
  // crash the iteration loop.

  private handleSdkNotificationMessage(sessionId: string, msg: unknown): void {
    const m = (msg ?? {}) as Record<string, unknown>;
    const text = typeof m.text === 'string' ? m.text : '';
    const priority = typeof m.priority === 'string' ? m.priority : 'medium';
    const color = typeof m.color === 'string' ? m.color : undefined;
    const timeoutMs = typeof m.timeout_ms === 'number' ? m.timeout_ms : undefined;
    const severity: AlertSeverity =
      priority === 'immediate' || priority === 'high' ? 'attention' : 'info';
    this.emitAlert({
      sessionId,
      category: 'turn',
      severity,
      title: 'Claude notification',
      body: text,
      ttlMs: timeoutMs,
      metadata: { source: 'sdk-notification-message', priority, color },
    });
  }

  private handleCompactBoundary(sessionId: string, msg: unknown): void {
    const m = (msg ?? {}) as { compact_metadata?: unknown };
    const meta = (m.compact_metadata ?? {}) as Record<string, unknown>;
    const trigger = meta.trigger === 'auto' ? 'auto' : 'manual';
    const preTokens = typeof meta.pre_tokens === 'number' ? meta.pre_tokens : 0;
    const postTokens = typeof meta.post_tokens === 'number' ? meta.post_tokens : undefined;
    const body =
      postTokens !== undefined
        ? `Reduced ${preTokens.toLocaleString()} → ${postTokens.toLocaleString()} tokens.`
        : `Compacted (${preTokens.toLocaleString()} tokens).`;
    this.emitAlert({
      sessionId,
      category: 'compaction',
      severity: 'info',
      title: trigger === 'auto' ? 'Context auto-compacted' : 'Context compacted',
      body,
      metadata: { trigger, preTokens, postTokens },
    });
  }

  private handleMirrorError(sessionId: string, msg: unknown): void {
    const m = (msg ?? {}) as { error?: unknown };
    const err = typeof m.error === 'string' ? m.error : 'Session sync failed.';
    this.emitAlert({
      sessionId,
      category: 'sync',
      severity: 'error',
      title: 'Session sync error',
      body: err,
    });
  }

  private handleApiRetry(sessionId: string, msg: unknown): void {
    const m = (msg ?? {}) as { attempt?: unknown; max_retries?: unknown; error?: unknown };
    const attempt = typeof m.attempt === 'number' ? m.attempt : 0;
    const max = typeof m.max_retries === 'number' ? m.max_retries : 0;
    const errMsg =
      m.error && typeof m.error === 'object' && 'message' in m.error
        ? String((m.error as { message?: unknown }).message ?? '')
        : '';
    this.emitAlert({
      sessionId,
      category: 'status',
      severity: 'info',
      title: max ? `Retrying API call (${attempt}/${max})` : 'Retrying API call',
      body: errMsg || undefined,
      ttlMs: 3000,
      persistent: false,
      needsAttention: false,
      metadata: { attempt, maxRetries: max },
    });
  }

  private handleRateLimitEvent(sessionId: string, msg: unknown): void {
    const m = (msg ?? {}) as { rate_limit_info?: unknown };
    const info = (m.rate_limit_info ?? {}) as Record<string, unknown>;
    const status =
      info.status === 'allowed' || info.status === 'allowed_warning' || info.status === 'rejected'
        ? (info.status as 'allowed' | 'allowed_warning' | 'rejected')
        : 'allowed';
    if (status === 'allowed') return;
    const utilization = typeof info.utilization === 'number' ? info.utilization : null;
    const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt : null;
    const limitType = typeof info.rateLimitType === 'string' ? info.rateLimitType : 'limit';
    const severity: AlertSeverity = status === 'rejected' ? 'error' : 'warning';
    const title =
      status === 'rejected' ? `Rate limit hit (${limitType})` : `Approaching rate limit (${limitType})`;
    const parts: string[] = [];
    if (utilization !== null) parts.push(`${Math.round(utilization * 100)}% used`);
    if (resetsAt !== null) parts.push(`resets ${new Date(resetsAt).toLocaleString()}`);
    this.emitAlert({
      sessionId,
      category: 'rate-limit',
      severity,
      title,
      body: parts.join(' · ') || undefined,
      metadata: { status, utilization, resetsAt, rateLimitType: limitType },
    });
  }

  // ─── Phase 5: informational events (not alerts) ─────────────────────────

  private handleStatus(sessionId: string, msg: unknown): void {
    const m = (msg ?? {}) as {
      status?: unknown;
      compact_result?: unknown;
      compact_error?: unknown;
    };
    const status = m.status === 'compacting' || m.status === 'requesting' ? m.status : null;
    this.emit('status', {
      sessionId,
      status,
      compactResult:
        m.compact_result === 'success' || m.compact_result === 'failed' ? m.compact_result : null,
      compactError: typeof m.compact_error === 'string' ? m.compact_error : null,
    });
  }

  private handleTaskEvent(sessionId: string, subtype: string, msg: unknown): void {
    const m = (msg ?? {}) as Record<string, unknown>;
    this.emit('task-event', { sessionId, subtype, payload: m });

    // task_notification carries the terminal outcome. The TaskCompleted hook
    // already covers status==='completed'; we only emit alerts for failure /
    // stop here so we don't double-toast.
    if (subtype === 'task_notification') {
      const status = typeof m.status === 'string' ? m.status : '';
      const summary = typeof m.summary === 'string' ? m.summary : undefined;
      const taskId = typeof m.task_id === 'string' ? m.task_id : undefined;
      if (status === 'failed') {
        this.emitAlert({
          sessionId,
          category: 'task',
          severity: 'warning',
          title: 'Task failed',
          body: summary,
          metadata: { taskId, status },
        });
      } else if (status === 'stopped') {
        this.emitAlert({
          sessionId,
          category: 'task',
          severity: 'info',
          title: 'Task stopped',
          body: summary,
          metadata: { taskId, status },
        });
      }
    }
  }

  private handleToolProgress(sessionId: string, msg: unknown): void {
    const m = (msg ?? {}) as {
      tool_use_id?: unknown;
      tool_name?: unknown;
      elapsed_time_seconds?: unknown;
      task_id?: unknown;
      parent_tool_use_id?: unknown;
    };
    this.emit('tool-progress', {
      sessionId,
      toolUseId: typeof m.tool_use_id === 'string' ? m.tool_use_id : '',
      toolName: typeof m.tool_name === 'string' ? m.tool_name : '',
      elapsedSeconds: typeof m.elapsed_time_seconds === 'number' ? m.elapsed_time_seconds : 0,
      taskId: typeof m.task_id === 'string' ? m.task_id : null,
      parentToolUseId: typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : null,
    });
  }

  private handleAuthStatus(sessionId: string, msg: unknown): void {
    const m = (msg ?? {}) as { isAuthenticating?: unknown; error?: unknown; output?: unknown };
    const errText = typeof m.error === 'string' ? m.error : '';
    if (errText) {
      this.emitAlert({
        sessionId,
        category: 'auth',
        severity: 'error',
        title: 'Auth failed',
        body: `${errText} — set ANTHROPIC_API_KEY or run \`claude login\`.`,
      });
      return;
    }
    if (m.isAuthenticating === true) {
      this.emitAlert({
        sessionId,
        category: 'auth',
        severity: 'info',
        title: 'Authenticating…',
        ttlMs: 2000,
        persistent: false,
        needsAttention: false,
      });
    }
  }

  /**
   * Build a plain-object stat snapshot for the `session:state-updated` payload.
   * Shape mirrors what the old HTTP receiver broadcast (`ClaudeSessionState`)
   * so the frontend store keeps interpreting it without changes.
   */
  private snapshotStats(s: AgentSession): Record<string, unknown> {
    return {
      provider: s.provider,
      agentProvider: s.provider,
      agentSessionId: s.agentSessionId,
      claudeSessionId: s.claudeSessionId,
      currentTool: s.currentTool,
      toolCount: s.toolCount,
      tokenCount: s.tokensIn + s.tokensOut + s.cacheCreationTokens + s.cacheReadTokens,
      costUsd: s.totalCostUsd,
      totalCostUsd: s.totalCostUsd,
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
      activeSubagents: s.activeSubagents,
      lastActivity: s.lastActivity,
      userMessages: s.userMessages,
    };
  }

  /**
   * If the session still carries a default agent-modal name (e.g. "Claude
   * Code"), rename it from the first user prompt. Mirrors the auto-rename
   * branch of the old UserPromptSubmit HTTP receiver.
   */
  private maybeRenameFromFirstPrompt(sessionId: string, prompt: string): void {
    const row = getSessionById(sessionId);
    if (!row) return;
    if (!AGENT_DEFAULT_NAMES.has(row.name)) return;
    const title = titleFromFirstPrompt(prompt);
    if (!title) return;
    try {
      const updated = updateSession(sessionId, { name: title });
      if (updated) {
        // server.ts subscribes to `session-updated` and broadcasts as
        // `session:updated` with the row payload. Re-fetch to attach the
        // freshly-renamed row.
        this.emit('session-renamed', { sessionId });
      }
    } catch (err) {
      console.error('[agent] maybeRenameFromFirstPrompt failed:', err);
    }
  }

  /**
   * Fire-and-forget: run option-detection on Stop. Reads the JSONL the SDK
   * just wrote. AI rename is no longer auto-triggered here — the user
   * invokes it explicitly via POST /api/sessions/:id/rename-ai.
   */
  private async runStopWork(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;

    if (s.claudeSessionId) {
      try {
        const result = await detectOptions(s.workingDir, s.claudeSessionId);
        if (result) {
          this.emit('options-detected', { sessionId, options: result.options });
        }
      } catch {
        // best-effort — JSONL may not have flushed yet
      }
    }
  }

  /**
   * Build the SDK hook map for a single session. Replaces the HTTP webhook
   * receiver wholesale: all hook-driven side effects (currentTool tracking,
   * toolCount, subagent counts, auto-rename, labeler, option detection,
   * notifications, session-end broadcast) run as in-process callbacks here.
   *
   * Every callback returns `{ continue: true }` so the SDK never gates on
   * our state-tracking — permissions still flow through canUseTool.
   */
  private makeHooks(sessionId: string): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const onPre: HookCallback = async (input) => {
      const s = this.sessions.get(sessionId);
      const tn = (input as { tool_name?: unknown })?.tool_name;
      if (s && typeof tn === 'string' && tn !== 'AskUserQuestion') {
        s.currentTool = tn;
        s.lastActivity = Date.now();
      }
      return { continue: true };
    };

    const onPost: HookCallback = async () => {
      const s = this.sessions.get(sessionId);
      if (!s) return { continue: true };
      s.toolCount++;
      s.currentTool = null;
      s.lastActivity = Date.now();
      // Cost from inline usage: PostToolUse arrives before the SDK's `result`
      // message; canonical totals come from `result` in handleSdkMessage.
      // Skip per-tool cost accumulation here to avoid double-counting.
      this.emit('state-snapshot', { sessionId, snapshot: this.snapshotStats(s) });
      return { continue: true };
    };

    const onUserPrompt: HookCallback = async () => {
      const s = this.sessions.get(sessionId);
      if (!s) return { continue: true };
      // sendTurn pushes the user's text into s.userMessages BEFORE query()
      // runs, so `length === 1` means "this is the first prompt of the
      // session" — the auto-rename trigger.
      if (s.userMessages.length === 1) {
        this.maybeRenameFromFirstPrompt(sessionId, s.userMessages[0]);
      }
      return { continue: true };
    };

    const onStop: HookCallback = async () => {
      void this.runStopWork(sessionId);
      return { continue: true };
    };

    const onSubStart: HookCallback = async () => {
      const s = this.sessions.get(sessionId);
      if (s) {
        s.activeSubagents++;
        s.lastActivity = Date.now();
        this.emit('state-snapshot', { sessionId, snapshot: this.snapshotStats(s) });
      }
      return { continue: true };
    };

    const onSubStop: HookCallback = async () => {
      const s = this.sessions.get(sessionId);
      if (s) {
        s.activeSubagents = Math.max(0, s.activeSubagents - 1);
        s.lastActivity = Date.now();
        this.emit('state-snapshot', { sessionId, snapshot: this.snapshotStats(s) });
      }
      return { continue: true };
    };

    const onNotification: HookCallback = async (input) => {
      this.emit('notification', { sessionId, payload: input });
      const i = (input ?? {}) as Record<string, unknown>;
      const notifType = typeof i.notification_type === 'string' ? i.notification_type : '';
      // notification_type values like 'agent_waiting' = Claude paused for user
      // input; 'permission_required' = the existing permission card already
      // covers it, so keep that path quieter.
      const severity: AlertSeverity =
        notifType === 'agent_waiting' || notifType === 'idle' ? 'attention' : 'info';
      const title = typeof i.title === 'string' && i.title ? i.title : 'Claude needs attention';
      const body = typeof i.message === 'string' ? i.message : undefined;
      this.emitAlert({
        sessionId,
        category: 'turn',
        severity,
        title,
        body,
        metadata: { source: 'sdk-notification-hook', notificationType: notifType },
      });
      return { continue: true };
    };

    const onSessionStart: HookCallback = async () => {
      return { continue: true };
    };

    const onSessionEnd: HookCallback = async () => {
      this.emit('session-ended', { sessionId });
      this.emitAlert({
        sessionId,
        category: 'turn',
        severity: 'info',
        title: 'Session ended',
      });
      return { continue: true };
    };

    const onPostToolUseFailure: HookCallback = async (input) => {
      const i = (input ?? {}) as { tool_name?: unknown; error?: unknown; is_interrupt?: unknown };
      const toolName = typeof i.tool_name === 'string' ? i.tool_name : 'tool';
      const errText = typeof i.error === 'string' ? i.error : 'Tool execution failed.';
      const interrupted = i.is_interrupt === true;
      this.emitAlert({
        sessionId,
        category: 'tool',
        severity: 'warning',
        title: interrupted ? `${toolName} interrupted` : `${toolName} failed`,
        body: errText,
        metadata: { toolName, interrupted },
      });
      return { continue: true };
    };

    const onPermissionDenied: HookCallback = async (input) => {
      const i = (input ?? {}) as { tool_name?: unknown; reason?: unknown };
      const toolName = typeof i.tool_name === 'string' ? i.tool_name : 'tool';
      const reason = typeof i.reason === 'string' ? i.reason : 'Permission denied.';
      this.emitAlert({
        sessionId,
        category: 'permission',
        severity: 'warning',
        title: `Permission denied: ${toolName}`,
        body: reason,
        metadata: { toolName },
      });
      return { continue: true };
    };

    const onTaskCreated: HookCallback = async (input) => {
      const i = (input ?? {}) as {
        task_id?: unknown;
        task_subject?: unknown;
        task_description?: unknown;
        teammate_name?: unknown;
      };
      const subject = typeof i.task_subject === 'string' ? i.task_subject : 'New task';
      const description = typeof i.task_description === 'string' ? i.task_description : undefined;
      this.emitAlert({
        sessionId,
        category: 'task',
        severity: 'info',
        title: `Task created: ${subject}`,
        body: description,
        metadata: {
          taskId: typeof i.task_id === 'string' ? i.task_id : undefined,
          teammate: typeof i.teammate_name === 'string' ? i.teammate_name : undefined,
        },
      });
      return { continue: true };
    };

    // TaskCompleted hook fires only on successful completion; failure / stop
    // outcomes arrive via the `task_notification` SDKMessage (handled in
    // handleSdkMessage). Both surfaces would duplicate on success, so the
    // SDKMessage path skips status==='completed' and lets this hook own it.
    const onTaskCompleted: HookCallback = async (input) => {
      const i = (input ?? {}) as {
        task_id?: unknown;
        task_subject?: unknown;
        teammate_name?: unknown;
      };
      const subject = typeof i.task_subject === 'string' ? i.task_subject : 'Task';
      this.emitAlert({
        sessionId,
        category: 'task',
        severity: 'success',
        title: `Task completed: ${subject}`,
        metadata: {
          taskId: typeof i.task_id === 'string' ? i.task_id : undefined,
          teammate: typeof i.teammate_name === 'string' ? i.teammate_name : undefined,
        },
      });
      return { continue: true };
    };

    const onStopFailure: HookCallback = async (input) => {
      const i = (input ?? {}) as { error?: unknown; error_details?: unknown };
      const errMsg =
        (typeof i.error_details === 'string' && i.error_details) ||
        (i.error && typeof i.error === 'object' && 'message' in i.error
          ? String((i.error as { message?: unknown }).message ?? 'Stop failed')
          : 'Stop failed.');
      this.emitAlert({
        sessionId,
        category: 'turn',
        severity: 'error',
        title: 'Stop failed',
        body: errMsg,
      });
      return { continue: true };
    };

    const onPreCompact: HookCallback = async (input) => {
      const i = (input ?? {}) as { trigger?: unknown };
      const trigger = i.trigger === 'auto' ? 'auto' : 'manual';
      this.emitAlert({
        sessionId,
        category: 'compaction',
        severity: 'info',
        title: trigger === 'auto' ? 'Compacting context…' : 'Manual compact starting…',
        // Status-class signal — keep it transient; Phase 9's status indicator
        // is the primary surface, not a toast.
        ttlMs: 1500,
        persistent: false,
        needsAttention: false,
        metadata: { trigger },
      });
      return { continue: true };
    };

    const onPostCompact: HookCallback = async (input) => {
      const i = (input ?? {}) as { trigger?: unknown; compact_summary?: unknown };
      const trigger = i.trigger === 'auto' ? 'auto' : 'manual';
      const summary = typeof i.compact_summary === 'string' ? i.compact_summary : undefined;
      this.emitAlert({
        sessionId,
        category: 'compaction',
        severity: 'info',
        title: trigger === 'auto' ? 'Context compacted' : 'Manual compact finished',
        body: summary,
        metadata: { trigger },
      });
      return { continue: true };
    };

    return {
      PreToolUse: [{ hooks: [onPre] }],
      PostToolUse: [{ hooks: [onPost] }],
      PostToolUseFailure: [{ hooks: [onPostToolUseFailure] }],
      PermissionDenied: [{ hooks: [onPermissionDenied] }],
      UserPromptSubmit: [{ hooks: [onUserPrompt] }],
      Stop: [{ hooks: [onStop] }],
      StopFailure: [{ hooks: [onStopFailure] }],
      SubagentStart: [{ hooks: [onSubStart] }],
      SubagentStop: [{ hooks: [onSubStop] }],
      Notification: [{ hooks: [onNotification] }],
      SessionStart: [{ hooks: [onSessionStart] }],
      SessionEnd: [{ hooks: [onSessionEnd] }],
      TaskCreated: [{ hooks: [onTaskCreated] }],
      TaskCompleted: [{ hooks: [onTaskCompleted] }],
      PreCompact: [{ hooks: [onPreCompact] }],
      PostCompact: [{ hooks: [onPostCompact] }],
    };
  }
}
