import { createRequire } from 'node:module';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  OnElicitation,
  PermissionMode,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentSession } from '../types.js';
import type { Message } from '../../transcripts/parser.js';
import type { PermissionManager } from '../../hooks/permissionManager.js';
import type { ElicitationManager } from '../../hooks/elicitationManager.js';
import {
  sdkSystemInit,
  sdkAssistantToMessages,
  sdkUserToMessages,
  sdkResult,
} from '../sdkAdapter.js';
import { StreamBuffer } from '../streamBuffer.js';
import type {
  AdapterCallbacks,
  ProviderAdapter,
  ProviderCapabilities,
} from './types.js';

const requireFromHere = createRequire(__filename);

function isMuslRuntime(): boolean {
  const report =
    typeof process.report?.getReport === 'function'
      ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
      : null;
  return process.platform === 'linux' && !report?.header?.glibcVersionRuntime;
}

export function resolveClaudeCodeExecutable(): string | undefined {
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

// === Native Claude permission modes ========================================
//
// The full SDK `PermissionMode` enum, with display strings lifted verbatim
// from the SDK JSDoc (sdk.d.ts:1757). MultiTable does NOT translate or invent
// modes — `session.mode` is one of these strings and goes straight to the
// SDK as `permissionMode`.
const CLAUDE_NATIVE_MODES = [
  {
    value: 'default' as PermissionMode,
    label: 'Default',
    description: 'Standard behavior, prompts for dangerous operations.',
  },
  {
    value: 'acceptEdits' as PermissionMode,
    label: 'Accept edits',
    description: 'Auto-accept file edit operations.',
  },
  {
    value: 'bypassPermissions' as PermissionMode,
    label: 'Bypass permissions',
    description: 'Bypass all permission checks (requires allowDangerouslySkipPermissions).',
  },
  {
    value: 'plan' as PermissionMode,
    label: 'Plan',
    description: 'Planning mode, no actual tool execution.',
  },
  {
    value: 'dontAsk' as PermissionMode,
    label: 'Don’t ask',
    description: "Don't prompt for permissions, deny if not pre-approved.",
  },
  {
    value: 'auto' as PermissionMode,
    label: 'Auto (classifier)',
    description: 'Use a model classifier to approve/deny permission prompts.',
  },
] as const;

export type { PermissionMode };

// === ClaudeAdapter =========================================================
//
// Translates the Claude Agent SDK's async-iterable event stream into the
// provider-agnostic AdapterCallbacks contract. The manager owns:
//   - state machine, DB persistence, WS dispatch
//   - watchdog (5min no-progress)
//   - the unified PermissionManager / ElicitationManager
//
// This adapter owns:
//   - SDK options assembly (resume, model, mode, hooks, canUseTool, …)
//   - SDK message dispatch (system / assistant / user / result / stream_event / …)
//   - StreamBuffer reducer (additive deltas)
//   - Hook → AdapterCallbacks event translation (notification, alert, currentTool…)
//
// Adding a Claude SDK feature now lives in ONE place — this file — instead of
// spread between manager.ts and the SDK option assembly.

export class ClaudeAdapter implements ProviderAdapter {
  readonly name = 'claude' as const;

  readonly capabilities: ProviderCapabilities = {
    costUsd: true,
    planMode: 'native',
    perCallApproval: 'callback',
    userQuestion: 'tool', // AskUserQuestion built-in tool
    elicitation: true,
    subagents: 'manual',
    midTurnInput: false, // streaming-input mode is unused today
    byok: false,
    hardSandbox: false,
    hooks: 'rich',
    streamingDeltaSemantics: 'additive',
    modelSwitchScope: 'per-turn',
    modes: CLAUDE_NATIVE_MODES.map((m) => ({ ...m })),
    thinkingEffort: 'native',
  };

  // Per-session live state the adapter needs to track within a single turn.
  // Cleared at turn end via the reset() helper.
  private streamBuffers = new Map<string, StreamBuffer>();
  private streamingBlockIndex = new Map<string, number | null>();

  constructor(
    private permManager: PermissionManager,
    private elicitManager: ElicitationManager,
  ) {}

  reset(s: AgentSession): void {
    this.streamBuffers.delete(s.id);
    this.streamingBlockIndex.delete(s.id);
  }

  // Intentionally NO provisionSession for Claude. The SDK's `system:init` event
  // hands us a claudeSessionId early, but the JSONL backing that id isn't
  // written until the SDK actually processes a prompt — aborting the query
  // right after init leaves us with a session id that has no on-disk
  // transcript, and the next real turn's `resume: <id>` then fails with
  // "No conversation found with session ID: …". The first real sendTurn
  // assigns the id and creates the JSONL naturally; no eager mint is needed.

  async runTurn(
    s: AgentSession,
    text: string,
    ctrl: AbortController,
    cb: AdapterCallbacks,
  ): Promise<void> {
    if (s.userMessages.length === 1) cb.maybeRenameFromFirstPrompt(text);

    const pathToClaudeCodeExecutable = resolveClaudeCodeExecutable();

    // Initialize per-turn streaming state.
    this.streamBuffers.set(s.id, new StreamBuffer('additive'));
    this.streamingBlockIndex.set(s.id, null);

    const it = query({
      prompt: text,
      options: {
        cwd: s.workingDir,
        ...(s.claudeSessionId ? { resume: s.claudeSessionId } : {}),
        ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
        ...(s.model ? { model: s.model } : {}),
        ...(s.thinkingEffort ? { effort: s.thinkingEffort } : {}),
        settingSources: ['project', 'user'],
        // Mode passthrough: `s.mode` is already a native `PermissionMode`
        // value (validated by the API + DB migration). No translation.
        permissionMode: s.mode as PermissionMode,
        canUseTool: this.makeCanUseTool(s),
        onElicitation: this.makeOnElicitation(s, cb),
        hooks: this.makeHooks(s, cb),
        includePartialMessages: true,
        // SDK accepts the AbortController itself — passing only `.signal`
        // through `as any` casts results in a silent no-op (the SDK keys off
        // identity). Pass the controller.
        abortController: ctrl,
      },
    });

    try {
      for await (const msg of it) {
        try {
          this.handleSdkMessage(s, msg, cb);
        } catch (handlerErr) {
          // Don't let a handler bug abort the whole turn — log and continue.
          console.error('[claude-adapter] handler error:', handlerErr);
        }
      }
    } finally {
      // Clear per-turn streaming state regardless of how the turn ended
      // (success / abort / error). Belt-and-braces — handleSdkMessage
      // normally clears at message_stop, but a network drop or abort can
      // leave a partial buffer.
      const buf = this.streamBuffers.get(s.id);
      if (buf && !buf.isEmpty) {
        cb.emitAssistantDelta('');
      }
      this.streamBuffers.delete(s.id);
      this.streamingBlockIndex.delete(s.id);
    }
  }

  // === SDK message dispatch ===============================================

  private handleSdkMessage(s: AgentSession, msg: unknown, cb: AdapterCallbacks): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; subtype?: string };

    switch (m.type) {
      case 'system': {
        switch (m.subtype) {
          case 'init': {
            const info = sdkSystemInit(msg);
            if (!info?.claudeSessionId) return;
            const newSid = info.claudeSessionId;
            if (newSid !== s.claudeSessionId) {
              const previousSid = s.claudeSessionId;
              const nextHistory =
                previousSid && !s.claudeSessionIdHistory.includes(previousSid)
                  ? [...s.claudeSessionIdHistory, previousSid]
                  : s.claudeSessionIdHistory;
              cb.onSessionIdAssigned(newSid, nextHistory);
            }
            return;
          }
          case 'notification':
            this.handleSdkNotificationMessage(msg, cb);
            return;
          case 'compact_boundary':
            this.handleCompactBoundary(msg, cb);
            return;
          case 'mirror_error':
            this.handleMirrorError(msg, cb);
            return;
          case 'api_retry':
            this.handleApiRetry(msg, cb);
            return;
          case 'status':
            // The previous implementation emitted a `status` event. We fold
            // this into bumpActivity + a transient alert so the UI sees the
            // "compacting…" / "requesting…" beat.
            this.handleStatus(msg, cb);
            return;
          case 'task_started':
          case 'task_progress':
          case 'task_updated':
          case 'task_notification':
            this.handleTaskEvent(m.subtype, msg, cb);
            return;
          default:
            return;
        }
      }
      case 'rate_limit_event':
        this.handleRateLimitEvent(msg, cb);
        return;
      case 'auth_status':
        this.handleAuthStatus(msg, cb);
        return;
      case 'tool_progress':
        // Tool progress is purely informational — bump activity so the
        // watchdog doesn't fire and the UI's "running for X" badge updates.
        cb.bumpActivity();
        return;
      case 'assistant': {
        const messages = sdkAssistantToMessages(msg);
        if (messages.length === 0) return;
        for (const out of messages) {
          if (out.kind === 'tool_use') {
            cb.incrementToolCount();
            cb.setCurrentTool(out.toolName || null);
          }
        }
        cb.bumpActivity();
        // Final assistant message arrived — clear in-flight streaming preview.
        const buf = this.streamBuffers.get(s.id);
        if (buf && !buf.isEmpty) {
          buf.reset();
          this.streamingBlockIndex.set(s.id, null);
          cb.emitAssistantDelta('');
        }
        cb.pushMessages(messages);
        cb.emitAssistantMessage(messages);
        return;
      }
      case 'stream_event':
        this.handleStreamEvent(s, msg, cb);
        return;
      case 'user': {
        const messages = sdkUserToMessages(msg);
        if (messages.length === 0) return;
        const toolEvents: Message[] = [];
        const userMessages: Message[] = [];
        for (const out of messages) {
          if (out.kind === 'tool_result') toolEvents.push(out);
          else if (out.kind === 'user') userMessages.push(out);
        }
        if (toolEvents.length > 0) {
          cb.setCurrentTool(null);
          cb.pushMessages(toolEvents);
          cb.emitToolEvent(toolEvents);
        }
        if (userMessages.length > 0) {
          // The manager pushes an optimistic user message with id `turn-<ts>-<rand>`
          // at sendTurn start. The SDK then echoes the same text back as a `user`
          // message with its own canonical uuid. Two paths are wrong here:
          //   - Suppress the echo entirely → the JSONL still has the canonical id,
          //     so the next REST `/messages` fetch (e.g. on `session:reconciled`,
          //     focus, visibility) returns the canonical id, doesn't match the
          //     optimistic id, and id-based dedup adds it as a SECOND copy.
          //     This is the long-standing user-message-doubling bug.
          //   - Append the echo as new → instant duplicate.
          // The fix mirrors the Codex reconcile pattern: when we detect the
          // SDK echo is the same logical message as our optimistic push, REKEY
          // the in-memory entry to the canonical id and emit `message-rekeyed`
          // so the frontend updates its store id in place. After this, every
          // layer (in-memory, JSONL, WS, REST) agrees on the same id.
          const optimisticId = s.currentTurn?.userMessageId ?? null;
          const lastPrompt = s.userMessages[s.userMessages.length - 1] ?? '';
          const norm = (t: string) => t.trim().replace(/\s+/g, ' ');
          const lastPromptNorm = norm(lastPrompt);
          const seenIds = new Set(s.messages.map((mm) => mm.id));
          const filtered: Message[] = [];
          for (const u of userMessages) {
            if (u.kind !== 'user') {
              filtered.push(u);
              continue;
            }
            // Already the canonical id (rare — SDK echoed exactly what we pushed).
            if (optimisticId && u.id === optimisticId) continue;
            // Already in s.messages by id (defensive — SDK retried, etc.).
            if (seenIds.has(u.id)) continue;
            // SDK echo of the optimistic prompt — rekey rather than suppress so
            // the canonical id propagates to the store. Only do this once per
            // turn (the first echo wins).
            if (
              optimisticId &&
              s.currentTurn !== null &&
              norm(u.text) === lastPromptNorm
            ) {
              const idx = s.messages.findIndex((m) => m.id === optimisticId);
              if (idx !== -1) {
                s.messages[idx] = { ...s.messages[idx], id: u.id } as Message;
                cb.emitMessageRekey(optimisticId, u.id);
                seenIds.delete(optimisticId);
                seenIds.add(u.id);
                // Clear the optimistic id so a later echo of the same text in
                // the same turn doesn't trigger a second rekey.
                if (s.currentTurn) s.currentTurn.userMessageId = u.id;
                continue;
              }
            }
            // Genuinely new user message (e.g. SDK injected a system reminder
            // mid-turn, or a streaming-input-mode followup).
            filtered.push(u);
          }
          if (filtered.length > 0) {
            cb.pushMessages(filtered);
            cb.emitUserMessage(filtered);
          }
        }
        cb.bumpActivity();
        return;
      }
      case 'result': {
        const info = sdkResult(msg);
        if (!info) return;
        cb.applyUsage({
          tokensIn: info.usage.inputTokens,
          tokensOut: info.usage.outputTokens,
          cacheCreationTokens: info.usage.cacheCreationInputTokens,
          cacheReadTokens: info.usage.cacheReadInputTokens,
          costUsd: info.totalCostUsd,
        });
        cb.bumpActivity();
        cb.emitTurnResult({
          subtype: info.subtype,
          totalCostUsd: info.totalCostUsd,
          usage: info.usage,
          text: info.text,
        });
        cb.emitStateSnapshot();
        this.maybeEmitResultAlert(info.subtype, info.totalCostUsd, cb);
        return;
      }
      default:
        return;
    }
  }

  // === stream_event handler ===============================================

  // The SDK forwards the raw Anthropic SSE event stream when
  // includePartialMessages: true. We accumulate text deltas via StreamBuffer
  // and emit cumulative text on every chunk so the UI can just `setLivePreview`.
  private handleStreamEvent(s: AgentSession, msg: unknown, cb: AdapterCallbacks): void {
    if (!msg || typeof msg !== 'object') return;
    const wrapper = msg as { event?: unknown };
    const inner = (wrapper.event ?? msg) as {
      type?: string;
      index?: number;
      delta?: unknown;
      content_block?: unknown;
    };
    const buf = this.streamBuffers.get(s.id);
    if (!buf) return;

    switch (inner.type) {
      case 'content_block_start': {
        const cb_ = inner.content_block as { type?: string } | undefined;
        const idx = typeof inner.index === 'number' ? inner.index : null;
        if (cb_ && cb_.type === 'text') {
          this.streamingBlockIndex.set(s.id, idx);
          buf.reset();
          cb.emitAssistantDelta('');
        } else {
          // tool_use or other block — clear any previously displayed text
          // partial so the UI doesn't show stale text while a tool is forming.
          if (!buf.isEmpty) {
            buf.reset();
            this.streamingBlockIndex.set(s.id, null);
            cb.emitAssistantDelta('');
          }
        }
        return;
      }
      case 'content_block_delta': {
        const idx = typeof inner.index === 'number' ? inner.index : null;
        if (this.streamingBlockIndex.get(s.id) !== idx) return;
        const delta = inner.delta as { type?: string; text?: unknown } | undefined;
        if (!delta || delta.type !== 'text_delta') return;
        if (typeof delta.text !== 'string') return;
        const next = buf.apply(delta.text);
        cb.bumpActivity();
        cb.emitAssistantDelta(next);
        return;
      }
      case 'content_block_stop': {
        const idx = typeof inner.index === 'number' ? inner.index : null;
        if (this.streamingBlockIndex.get(s.id) !== idx) return;
        // Leave accumulated text on screen until the canonical `assistant`
        // message arrives and replaces it. Just close the block tracker.
        this.streamingBlockIndex.set(s.id, null);
        return;
      }
      case 'message_stop': {
        buf.reset();
        this.streamingBlockIndex.set(s.id, null);
        cb.emitAssistantDelta('');
        return;
      }
      default:
        return;
    }
  }

  // === Permission / elicitation =============================================

  private makeCanUseTool(s: AgentSession) {
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
      return await this.permManager.requestFromSdk(
        s.id,
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

  private makeOnElicitation(s: AgentSession, cb: AdapterCallbacks): OnElicitation {
    return async (request, opts) => {
      cb.emitAlert({
        category: 'elicitation',
        severity: 'attention',
        title: request.title || `${request.serverName} needs input`,
        body: request.message,
        metadata: {
          serverName: request.serverName,
          mode: request.mode ?? 'form',
        },
      });
      const result = await this.elicitManager.requestFromSdk(s.id, request, opts.signal);
      return result as unknown as Awaited<ReturnType<OnElicitation>>;
    };
  }

  // === Hooks ===============================================================

  // Replaces the HTTP webhook receiver wholesale: all hook-driven side effects
  // (currentTool tracking, toolCount, subagent counts, auto-rename, alerts,
  // notifications) run as in-process callbacks here. Every callback returns
  // `{ continue: true }` so the SDK never gates on our state-tracking; tool
  // gating still flows through canUseTool.
  private makeHooks(
    s: AgentSession,
    cb: AdapterCallbacks,
  ): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const onPre: HookCallback = async (input) => {
      const tn = (input as { tool_name?: unknown })?.tool_name;
      if (typeof tn === 'string' && tn !== 'AskUserQuestion') {
        cb.setCurrentTool(tn);
        cb.bumpActivity();
      }
      return { continue: true };
    };

    const onPost: HookCallback = async () => {
      cb.incrementToolCount();
      cb.setCurrentTool(null);
      cb.bumpActivity();
      cb.emitStateSnapshot();
      return { continue: true };
    };

    const onUserPrompt: HookCallback = async () => {
      // Manager pushes user text into s.userMessages BEFORE runTurn calls
      // query(), so length === 1 means "this is the first prompt of the
      // session" — the auto-rename trigger.
      if (s.userMessages.length === 1) {
        cb.maybeRenameFromFirstPrompt(s.userMessages[0]);
      }
      return { continue: true };
    };

    const onStop: HookCallback = async () => {
      // Hand off to manager-side post-stop work (option detection from JSONL).
      // We fire-and-forget via the alert channel rather than a dedicated
      // callback to keep the contract small. Manager has its own JSONL parse
      // path on Stop already.
      return { continue: true };
    };

    const onSubStart: HookCallback = async () => {
      cb.incrementSubagents(1);
      cb.bumpActivity();
      cb.emitStateSnapshot();
      return { continue: true };
    };

    const onSubStop: HookCallback = async () => {
      cb.incrementSubagents(-1);
      cb.bumpActivity();
      cb.emitStateSnapshot();
      return { continue: true };
    };

    const onNotification: HookCallback = async (input) => {
      cb.emitNotification(input);
      const i = (input ?? {}) as Record<string, unknown>;
      const notifType = typeof i.notification_type === 'string' ? i.notification_type : '';
      const severity =
        notifType === 'agent_waiting' || notifType === 'idle' ? 'attention' : 'info';
      const title = typeof i.title === 'string' && i.title ? i.title : 'Claude needs attention';
      const body = typeof i.message === 'string' ? i.message : undefined;
      cb.emitAlert({
        category: 'turn',
        severity: severity as 'attention' | 'info',
        title,
        body,
        metadata: { source: 'sdk-notification-hook', notificationType: notifType },
      });
      return { continue: true };
    };

    const onSessionStart: HookCallback = async () => ({ continue: true });

    const onSessionEnd: HookCallback = async () => {
      cb.emitSessionEnded();
      cb.emitAlert({
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
      cb.emitAlert({
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
      cb.emitAlert({
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
      cb.emitAlert({
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

    const onTaskCompleted: HookCallback = async (input) => {
      const i = (input ?? {}) as {
        task_id?: unknown;
        task_subject?: unknown;
        teammate_name?: unknown;
      };
      const subject = typeof i.task_subject === 'string' ? i.task_subject : 'Task';
      cb.emitAlert({
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
      cb.emitAlert({
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
      cb.emitAlert({
        category: 'compaction',
        severity: 'info',
        title: trigger === 'auto' ? 'Compacting context…' : 'Manual compact starting…',
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
      cb.emitAlert({
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

  // === System-message subtype handlers =====================================

  private handleSdkNotificationMessage(msg: unknown, cb: AdapterCallbacks): void {
    const m = (msg ?? {}) as Record<string, unknown>;
    const text = typeof m.text === 'string' ? m.text : '';
    const priority = typeof m.priority === 'string' ? m.priority : 'medium';
    const color = typeof m.color === 'string' ? m.color : undefined;
    const timeoutMs = typeof m.timeout_ms === 'number' ? m.timeout_ms : undefined;
    const severity = priority === 'immediate' || priority === 'high' ? 'attention' : 'info';
    cb.emitAlert({
      category: 'turn',
      severity: severity as 'attention' | 'info',
      title: 'Claude notification',
      body: text,
      ttlMs: timeoutMs,
      metadata: { source: 'sdk-notification-message', priority, color },
    });
  }

  private handleCompactBoundary(msg: unknown, cb: AdapterCallbacks): void {
    const m = (msg ?? {}) as { compact_metadata?: unknown };
    const meta = (m.compact_metadata ?? {}) as Record<string, unknown>;
    const trigger = meta.trigger === 'auto' ? 'auto' : 'manual';
    const preTokens = typeof meta.pre_tokens === 'number' ? meta.pre_tokens : 0;
    const postTokens = typeof meta.post_tokens === 'number' ? meta.post_tokens : undefined;
    const body =
      postTokens !== undefined
        ? `Reduced ${preTokens.toLocaleString()} → ${postTokens.toLocaleString()} tokens.`
        : `Compacted (${preTokens.toLocaleString()} tokens).`;
    cb.emitAlert({
      category: 'compaction',
      severity: 'info',
      title: trigger === 'auto' ? 'Context auto-compacted' : 'Context compacted',
      body,
      metadata: { trigger, preTokens, postTokens },
    });
  }

  private handleMirrorError(msg: unknown, cb: AdapterCallbacks): void {
    const m = (msg ?? {}) as { error?: unknown };
    const err = typeof m.error === 'string' ? m.error : 'Session sync failed.';
    cb.emitAlert({
      category: 'sync',
      severity: 'error',
      title: 'Session sync error',
      body: err,
    });
  }

  private handleApiRetry(msg: unknown, cb: AdapterCallbacks): void {
    const m = (msg ?? {}) as { attempt?: unknown; max_retries?: unknown; error?: unknown };
    const attempt = typeof m.attempt === 'number' ? m.attempt : 0;
    const max = typeof m.max_retries === 'number' ? m.max_retries : 0;
    const errMsg =
      m.error && typeof m.error === 'object' && 'message' in m.error
        ? String((m.error as { message?: unknown }).message ?? '')
        : '';
    cb.emitAlert({
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

  private handleStatus(msg: unknown, cb: AdapterCallbacks): void {
    const m = (msg ?? {}) as {
      status?: unknown;
      compact_result?: unknown;
      compact_error?: unknown;
    };
    const status = m.status === 'compacting' || m.status === 'requesting' ? m.status : null;
    if (status === 'compacting') {
      cb.emitAlert({
        category: 'compaction',
        severity: 'info',
        title: 'Compacting…',
        ttlMs: 1500,
        persistent: false,
        needsAttention: false,
        metadata: { status },
      });
    }
    cb.bumpActivity();
  }

  private handleTaskEvent(subtype: string, msg: unknown, cb: AdapterCallbacks): void {
    const m = (msg ?? {}) as Record<string, unknown>;

    // Forward all four subtypes verbatim — the SDK message fields
    // (task_id, description, patch, usage, status, summary, output_file, …)
    // already match the frontend `applyTaskEvent` reducer, which ignores
    // extras (uuid, session_id, tool_use_id), so a raw passthrough is safe.
    cb.emitTaskEvent(subtype, m);

    // Preserve the existing failure/stop alert: the Tasks panel surfaces the
    // row, but a failed/stopped subagent should still raise a toast/chime.
    if (subtype !== 'task_notification') return;
    const status = typeof m.status === 'string' ? m.status : '';
    const summary = typeof m.summary === 'string' ? m.summary : undefined;
    const taskId = typeof m.task_id === 'string' ? m.task_id : undefined;
    if (status === 'failed') {
      cb.emitAlert({
        category: 'task',
        severity: 'warning',
        title: 'Task failed',
        body: summary,
        metadata: { taskId, status },
      });
    } else if (status === 'stopped') {
      cb.emitAlert({
        category: 'task',
        severity: 'info',
        title: 'Task stopped',
        body: summary,
        metadata: { taskId, status },
      });
    }
  }

  private handleRateLimitEvent(msg: unknown, cb: AdapterCallbacks): void {
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
    const severity = status === 'rejected' ? 'error' : 'warning';
    const title =
      status === 'rejected'
        ? `Rate limit hit (${limitType})`
        : `Approaching rate limit (${limitType})`;
    const parts: string[] = [];
    if (utilization !== null) parts.push(`${Math.round(utilization * 100)}% used`);
    if (resetsAt !== null) parts.push(`resets ${new Date(resetsAt).toLocaleString()}`);
    cb.emitAlert({
      category: 'rate-limit',
      severity: severity as 'error' | 'warning',
      title,
      body: parts.join(' · ') || undefined,
      metadata: { status, utilization, resetsAt, rateLimitType: limitType },
    });
  }

  private handleAuthStatus(msg: unknown, cb: AdapterCallbacks): void {
    const m = (msg ?? {}) as { isAuthenticating?: unknown; error?: unknown; output?: unknown };
    const errText = typeof m.error === 'string' ? m.error : '';
    if (errText) {
      cb.emitAlert({
        category: 'auth',
        severity: 'error',
        title: 'Auth failed',
        body: `${errText} — set ANTHROPIC_API_KEY or run \`claude login\`.`,
      });
      return;
    }
    if (m.isAuthenticating === true) {
      cb.emitAlert({
        category: 'auth',
        severity: 'info',
        title: 'Authenticating…',
        ttlMs: 2000,
        persistent: false,
        needsAttention: false,
      });
    }
  }

  private maybeEmitResultAlert(subtype: string, totalCostUsd: number, cb: AdapterCallbacks): void {
    if (subtype === 'error_max_budget_usd') {
      cb.emitAlert({
        category: 'budget',
        severity: 'error',
        title: 'Budget limit reached',
        body: `Spent $${totalCostUsd.toFixed(4)}; turn stopped at the configured maxBudgetUsd.`,
      });
    } else if (subtype === 'error_max_turns') {
      cb.emitAlert({
        category: 'budget',
        severity: 'error',
        title: 'Turn limit reached',
        body: 'Conversation hit the configured maxTurns ceiling.',
      });
    } else if (subtype === 'error_max_structured_output_retries') {
      cb.emitAlert({
        category: 'budget',
        severity: 'error',
        title: 'Structured-output retries exhausted',
        body: 'Claude could not produce a valid structured response after the maximum retries.',
      });
    }
  }
}
