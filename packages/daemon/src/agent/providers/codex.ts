import type { Thread, ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import type { AgentSession } from '../types.js';
import type { Message } from '../../transcripts/parser.js';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  AdapterCallbacks,
  ToolDeltaPayload,
} from './types.js';
import {
  countCodexTurns,
  parseCodexThread,
  codexCanonicalId,
} from '../../transcripts/codexParser.js';

// CodexAdapter wraps @openai/codex-sdk. The SDK is a subprocess wrapper that
// spawns `codex exec --experimental-json` per turn and streams JSONL events
// back. Key constraints baked into this adapter:
//
// - approvalPolicy MUST be 'never'. The SDK closes child stdin immediately
//   after writing the prompt and exposes no host-side approval callback, so
//   any other policy will hang or auto-fail. Tool gating happens via
//   sandboxMode + additionalDirectories + networkAccessEnabled.
// - Each runStreamed() call is a fresh subprocess. We cache the Thread
//   instance per multitable session id because Thread holds the codex
//   thread_id used to resume on subsequent turns. The cache is rebuilt from
//   the DB on daemon restart.
// - Codex emits item-level events (item.started/updated/completed). For
//   agent_message updates, the item text is the current partial response; we
//   forward that through the shared assistant-delta channel and keep
//   item.completed as the canonical final message.
// - Item ids the SDK exposes (e.g. `item_0`, `item_1`) are NOT globally
//   unique — each subprocess restarts the counter, so turn 2 collides with
//   turn 1. We mint canonical ids of the form
//   `codex:{threadId}:t{turnIndex}:{kind}:{seq}` that match what the JSONL
//   parser produces, so id-based dedup works on both the live WS path and
//   the REST refresh path.
// - After each turn we reconcile in-memory s.messages against the on-disk
//   JSONL (the codex CLI's own source of truth). Any item the live event
//   stream missed gets recovered and re-broadcast — the daemon-side
//   guarantee that "every codex action shows up in the chat".

interface TurnState {
  // Index of the upcoming/current turn relative to the thread. 0 = first.
  turnIndex: number;
  // Per-item-kind seq counters, reset at the start of every turn.
  seq: Map<string, number>;
  // Fires after the for-await loop ends to diff in-memory vs disk.
  reconcileTimer: NodeJS.Timeout | null;
}

// Tunable: how long after the stream closes before we reconcile from disk.
// The codex CLI flushes JSONL slightly after stream close; 250ms is invisible
// behind the UI's "agent done" toast and gives the file time to settle.
const RECONCILE_DELAY_MS = 250;

export class CodexAdapter implements ProviderAdapter {
  readonly name = 'codex' as const;

  readonly capabilities: ProviderCapabilities = {
    // Codex SDK does not surface per-turn cost in USD — by design, codex
    // pricing is contract-specific. The UI hides the dollar row.
    costUsd: false,
    // Plan mode is TUI-only in Codex; we approximate via sandboxMode swap
    // (read-only thread → resume workspace-write) but the wiring lives in
    // the manager today, not here. Mark as 'simulated' so UI gates accordingly.
    planMode: 'simulated',
    // Sandbox enum, no per-call host approval — stdin closes after the
    // prompt and Codex exposes no callback.
    perCallApproval: 'sandbox',
    // No agent-side Q&A mechanism — all interaction goes through the
    // sandbox flags + the message stream itself.
    userQuestion: 'unsupported',
    // No MCP elicitation flow exposed by the SDK.
    elicitation: false,
    // Codex events lack agent_id / parent_item_id — see GitHub #20979.
    subagents: 'none',
    // stdin closed after prompt = no mid-turn input.
    midTurnInput: false,
    byok: false,
    // Codex binary enforces the actual sandbox at the OS level.
    hardSandbox: true,
    // No lifecycle hooks at the SDK level — only the event stream.
    hooks: 'none',
    // item.updated.item.text is cumulative — must REPLACE buffer.
    streamingDeltaSemantics: 'cumulative',
    modelSwitchScope: 'per-thread',
    // Read-only and default we can simulate via sandboxMode. Plan is also
    // simulated. Other modes (chat, accept-edits, auto) don't map cleanly to
    // the codex sandbox enum — leave them out so the UI doesn't show them.
    modes: ['default', 'plan', 'read-only'],
  };

  private codex: {
    startThread: (options?: Record<string, unknown>) => Thread;
    resumeThread: (id: string, options?: Record<string, unknown>) => Thread;
  } | null = null;
  private codexLoad: Promise<CodexAdapter['codex']> | null = null;
  private threads = new Map<string, Thread>();
  private turnStates = new Map<string, TurnState>();

  reset(s: AgentSession): void {
    this.threads.delete(s.id);
    const state = this.turnStates.get(s.id);
    if (state?.reconcileTimer) clearTimeout(state.reconcileTimer);
    this.turnStates.delete(s.id);
  }

  async runTurn(
    s: AgentSession,
    text: string,
    ctrl: AbortController,
    cb: AdapterCallbacks,
  ): Promise<void> {
    if (s.userMessages.length === 1) cb.maybeRenameFromFirstPrompt(text);
    const thread = await this.getThread(s);

    // Determine turnIndex from disk so live ids match what parseCodexThread
    // will later compute. New thread → 0; resumed thread → existing count.
    let turnIndex = 0;
    if (s.agentSessionId) {
      try {
        turnIndex = countCodexTurns(s.agentSessionId);
      } catch {
        /* file not flushed yet → safe to start at 0 */
      }
    }
    // Cancel any pending reconcile from the previous turn before overwriting.
    const prev = this.turnStates.get(s.id);
    if (prev?.reconcileTimer) clearTimeout(prev.reconcileTimer);
    this.turnStates.set(s.id, { turnIndex, seq: new Map(), reconcileTimer: null });

    console.info('[codex] starting turn', {
      sessionId: s.id,
      threadId: s.agentSessionId ?? thread.id ?? null,
      turnIndex,
      promptLength: text.length,
    });

    try {
      const { events } = await thread.runStreamed(text, { signal: ctrl.signal });
      for await (const event of events) {
        try {
          this.handleEvent(s, event, cb);
        } catch (err) {
          if (event.type === 'turn.failed' || event.type === 'error') throw err;
          const message = err instanceof Error ? err.message : String(err);
          console.error('[codex] non-fatal event handling error', {
            sessionId: s.id,
            threadId: s.agentSessionId ?? thread.id ?? null,
            event: this.describeEvent(event),
            error: message,
          });
          const seq = this.nextSeq(s.id, 'evterr');
          const messages: Message[] = [
            {
              id: codexCanonicalId(s.agentSessionId, turnIndex, 'evterr', seq),
              ts: Date.now(),
              kind: 'system',
              text: `Codex event handling error: ${message}`,
            },
          ];
          cb.pushMessages(messages);
          cb.emitToolEvent(messages);
        }
      }
      console.info('[codex] turn stream ended', {
        sessionId: s.id,
        threadId: s.agentSessionId ?? thread.id ?? null,
      });
      // Schedule reconciliation. Captures items the live stream may have
      // dropped (handler exception, SDK skip, etc.) by reading the codex
      // CLI's authoritative on-disk JSONL.
      this.scheduleReconcile(s, cb);
    } catch (err) {
      this.threads.delete(s.id);
      console.error('[codex] turn failed', {
        sessionId: s.id,
        threadId: s.agentSessionId ?? thread.id ?? null,
        error: err instanceof Error ? err.stack ?? err.message : String(err),
      });
      // Even on failure: reconcile so partial output the agent produced
      // before failing isn't lost.
      this.scheduleReconcile(s, cb);
      throw err;
    }
  }

  private scheduleReconcile(s: AgentSession, cb: AdapterCallbacks): void {
    const state = this.turnStates.get(s.id);
    if (!state) return;
    if (state.reconcileTimer) clearTimeout(state.reconcileTimer);
    state.reconcileTimer = setTimeout(() => {
      state.reconcileTimer = null;
      try {
        this.reconcileTurn(s, cb);
      } catch (err) {
        console.error('[codex] reconcileTurn failed', {
          sessionId: s.id,
          threadId: s.agentSessionId ?? null,
          error: err instanceof Error ? err.stack ?? err.message : String(err),
        });
      }
    }, RECONCILE_DELAY_MS);
  }

  // Diff in-memory s.messages against the on-disk JSONL and broadcast the
  // delta. This is the daemon-side guarantee that every codex action is
  // captured: even if the live runStreamed() event stream silently drops an
  // item, the JSONL is the codex CLI's authoritative log and we replay any
  // missing pieces from it.
  private reconcileTurn(s: AgentSession, cb: AdapterCallbacks): void {
    if (!s.agentSessionId) return;
    const fromDisk = parseCodexThread(s.agentSessionId);
    if (fromDisk.length === 0) return;
    const inMemoryIds = new Set(s.messages.map((m) => m.id));

    // The optimistic user-message push in AgentSessionManager.sendTurn uses
    // id `turn-${ts}-${rand}`, while the disk version uses canonical
    // `codex:{thread}:t{turnIndex}:user:0`. Match them by text + position
    // (only one user message per turn for codex), re-key the in-memory
    // entry to the canonical id, AND emit a rekey event so the frontend
    // updates its store id in place. After this, every layer (in-memory,
    // disk, WS, REST) agrees on the same id and dedup is pure id match.
    const optimisticUserMatches = (live: Message, disk: Message): boolean => {
      if (live.kind !== 'user' || disk.kind !== 'user') return false;
      if (!live.id.startsWith('turn-')) return false;
      const norm = (t: string) => t.trim().replace(/\s+/g, ' ');
      return norm(live.text) === norm(disk.text);
    };
    for (const dm of fromDisk) {
      if (dm.kind !== 'user') continue;
      const idx = s.messages.findIndex((m) => optimisticUserMatches(m, dm));
      if (idx === -1) continue;
      const existing = s.messages[idx];
      if (existing.id === dm.id) continue;
      inMemoryIds.delete(existing.id);
      const reKeyed: Message = { ...existing, id: dm.id } as Message;
      s.messages[idx] = reKeyed;
      inMemoryIds.add(dm.id);
      cb.emitMessageRekey(existing.id, dm.id);
    }

    const additions: Message[] = [];
    for (const dm of fromDisk) {
      if (inMemoryIds.has(dm.id)) continue;
      additions.push(dm);
      inMemoryIds.add(dm.id);
    }
    if (additions.length === 0) {
      // Nothing missing; still notify so the frontend can do a no-op REST
      // sync to confirm consistency. Cheap.
      cb.emitReconciled([]);
      return;
    }
    s.messages.push(...additions);

    // Route additions to the matching event channel so existing frontend
    // handlers (assistant-message, tool-event, user-message) pick them up.
    const assistant: Message[] = [];
    const tool: Message[] = [];
    const user: Message[] = [];
    for (const m of additions) {
      if (m.kind === 'assistant') assistant.push(m);
      else if (m.kind === 'user') user.push(m);
      else tool.push(m); // tool_use, tool_result, system
    }
    if (assistant.length) cb.emitAssistantMessage(assistant);
    if (tool.length) cb.emitToolEvent(tool);
    if (user.length) cb.emitUserMessage(user);
    cb.emitReconciled(additions.map((m) => m.id));
    cb.emitStateSnapshot();
    console.info('[codex] reconciled missing items', {
      sessionId: s.id,
      threadId: s.agentSessionId,
      added: additions.length,
    });
  }

  private async getClient(): Promise<NonNullable<CodexAdapter['codex']>> {
    if (this.codex) return this.codex;
    if (!this.codexLoad) {
      this.codexLoad = (async () => {
        // The daemon is compiled as CommonJS but @openai/codex-sdk is
        // ESM-only. Wrap the import in `new Function` so TypeScript doesn't
        // rewrite it to require().
        const mod = (await new Function('specifier', 'return import(specifier)')(
          '@openai/codex-sdk',
        )) as typeof import('@openai/codex-sdk');
        this.codex = new mod.Codex();
        return this.codex;
      })();
    }
    return this.codexLoad as Promise<NonNullable<CodexAdapter['codex']>>;
  }

  private async getThread(s: AgentSession): Promise<Thread> {
    const existing = this.threads.get(s.id);
    if (existing) return existing;
    const codex = await this.getClient();
    const opts: Record<string, unknown> = {
      workingDirectory: s.workingDir,
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
    };
    // The Codex SDK forwards unknown option keys to the spawned `codex exec`
    // child as CLI flags, and `model` is the documented flag name (-m,
    // --model). Setting it per-thread means the user's pick from the
    // AddAgentModal is honored on every turn without depending on
    // ~/.codex/config.toml.
    if (s.model) opts.model = s.model;
    const thread = s.agentSessionId
      ? codex.resumeThread(s.agentSessionId, opts)
      : codex.startThread(opts);
    this.threads.set(s.id, thread);
    return thread;
  }

  private nextSeq(sessionId: string, kind: string): number {
    const state = this.turnStates.get(sessionId);
    if (!state) return 0;
    const n = state.seq.get(kind) ?? 0;
    state.seq.set(kind, n + 1);
    return n;
  }

  private currentTurnIndex(sessionId: string): number {
    return this.turnStates.get(sessionId)?.turnIndex ?? 0;
  }

  private handleEvent(s: AgentSession, event: ThreadEvent, cb: AdapterCallbacks): void {
    const now = Date.now();
    switch (event.type) {
      case 'thread.started': {
        const newId = event.thread_id;
        console.info('[codex] thread started', {
          sessionId: s.id,
          threadId: newId,
        });
        if (newId && newId !== s.agentSessionId) {
          const previous = s.agentSessionId;
          const nextHistory =
            previous && !s.agentSessionIdHistory.includes(previous)
              ? [...s.agentSessionIdHistory, previous]
              : s.agentSessionIdHistory;
          cb.onSessionIdAssigned(newId, nextHistory);
          cb.emitStateSnapshot();
        }
        return;
      }
      case 'turn.started': {
        console.info('[codex] turn started', {
          sessionId: s.id,
          threadId: s.agentSessionId ?? null,
          turnIndex: this.currentTurnIndex(s.id),
        });
        return;
      }
      case 'item.started':
      case 'item.updated': {
        this.updateAssistantDelta(event.item, cb);
        this.updateReasoningDelta(event.item, cb);
        this.updateToolDelta(event.item, cb);
        this.updateCurrentTool(event.item, cb);
        return;
      }
      case 'item.completed': {
        // Clear the live preview slot for this item kind — the canonical
        // tool_use/tool_result/system message we're about to push takes over
        // rendering. Doing this BEFORE the message push prevents a one-frame
        // duplicate (live preview + final card both visible).
        if (
          event.item.type === 'command_execution' ||
          event.item.type === 'file_change' ||
          event.item.type === 'mcp_tool_call' ||
          event.item.type === 'web_search'
        ) {
          cb.emitToolDelta(null);
        } else if (event.item.type === 'reasoning') {
          cb.emitReasoningDelta('');
        }
        const messages = this.itemToMessages(s, event.item, now);
        if (messages.length > 0) {
          cb.pushMessages(messages);
          if (messages.some((m) => m.kind === 'assistant')) {
            cb.emitAssistantMessage(messages);
            cb.emitAssistantDelta('');
          } else {
            cb.emitToolEvent(messages);
          }
        }
        cb.setCurrentTool(null);
        cb.bumpActivity();
        cb.emitStateSnapshot();
        return;
      }
      case 'turn.completed': {
        // Belt-and-braces: clear any lingering live tool/reasoning preview.
        // item.completed normally clears these, but a parallel/aborted item
        // could leave one stuck.
        cb.emitToolDelta(null);
        cb.emitReasoningDelta('');
        const u = event.usage;
        const tokensIn = u.input_tokens + u.cached_input_tokens;
        const tokensOut = u.output_tokens + u.reasoning_output_tokens;
        cb.applyUsage({
          tokensIn,
          tokensOut,
          cacheCreationTokens: 0,
          cacheReadTokens: u.cached_input_tokens,
          costUsd: 0,
        });
        cb.emitTurnResult({
          subtype: 'success',
          totalCostUsd: 0,
          usage: {
            inputTokens: u.input_tokens,
            outputTokens: u.output_tokens,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: u.cached_input_tokens,
          },
          text: null,
        });
        cb.bumpActivity();
        cb.emitStateSnapshot();
        console.info('[codex] turn completed', {
          sessionId: s.id,
          threadId: s.agentSessionId ?? null,
          tokensIn,
          tokensOut,
        });
        return;
      }
      case 'turn.failed': {
        console.error('[codex] turn.failed event', {
          sessionId: s.id,
          threadId: s.agentSessionId ?? null,
          message: event.error.message,
        });
        throw new Error(event.error.message || 'Codex turn failed');
      }
      case 'error': {
        console.error('[codex] stream error event', {
          sessionId: s.id,
          threadId: s.agentSessionId ?? null,
          message: event.message,
        });
        throw new Error(event.message || 'Codex stream failed');
      }
      default:
        return;
    }
  }

  private updateAssistantDelta(item: ThreadItem, cb: AdapterCallbacks): void {
    if (item.type !== 'agent_message') return;
    cb.emitAssistantDelta(item.text);
    cb.bumpActivity();
  }

  // Live in-progress tool streaming. Codex emits item.updated as a tool's
  // aggregated_output grows (long-running shell commands, multi-file patches,
  // mcp tool calls, web searches). We forward each snapshot to the chat UI
  // so the user sees output land as it happens, instead of staring at a
  // "running…" spinner until the command finally exits.
  private updateToolDelta(item: ThreadItem, cb: AdapterCallbacks): void {
    let payload: ToolDeltaPayload | null = null;
    switch (item.type) {
      case 'command_execution': {
        payload = {
          toolName: 'Command',
          input: { command: item.command },
          output:
            item.aggregated_output ||
            (item.exit_code === undefined ? 'Running…' : `Exit code ${item.exit_code}`),
          isError: item.status === 'failed',
        };
        break;
      }
      case 'file_change': {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        payload = {
          toolName: 'Patch',
          input: { changes },
          output: changes.map((c) => `${c.kind}: ${c.path}`).join('\n') || 'Applying patch…',
          isError: item.status === 'failed',
        };
        break;
      }
      case 'mcp_tool_call': {
        const result =
          item.error?.message ?? (item.result ? JSON.stringify(item.result, null, 2) : 'Calling…');
        payload = {
          toolName: `${item.server}.${item.tool}`,
          input: item.arguments ?? {},
          output: result,
          isError: item.status === 'failed',
        };
        break;
      }
      case 'web_search': {
        payload = {
          toolName: 'WebSearch',
          input: { query: item.query },
          output: 'Searching…',
          isError: false,
        };
        break;
      }
      default:
        return;
    }
    cb.emitToolDelta(payload);
    cb.bumpActivity();
  }

  // Live reasoning text — model chain-of-thought streamed in. Rendered as
  // an italic preview that gets replaced by the canonical "Reasoning: …"
  // system message at item.completed.
  private updateReasoningDelta(item: ThreadItem, cb: AdapterCallbacks): void {
    if (item.type !== 'reasoning') return;
    cb.emitReasoningDelta(item.text);
    cb.bumpActivity();
  }

  private updateCurrentTool(item: ThreadItem, cb: AdapterCallbacks): void {
    let toolName: string | null = null;
    if (item.type === 'command_execution') toolName = 'Command';
    else if (item.type === 'file_change') toolName = 'Patch';
    else if (item.type === 'mcp_tool_call') toolName = `${item.server}.${item.tool}`;
    else if (item.type === 'web_search') toolName = 'WebSearch';
    if (!toolName) return;
    cb.setCurrentTool(toolName);
    cb.bumpActivity();
    cb.emitStateSnapshot();
  }

  // Mints canonical Message[] for one Codex item. The SDK's item.id (e.g.
  // `item_0`) is NOT used directly because it collides across turns; instead
  // we derive a `codex:{threadId}:t{turnIndex}:{kind}:{seq}` id that matches
  // exactly what `parseCodexFile` produces from the JSONL.
  //
  // Tool calls (command_execution, file_change, mcp_tool_call, web_search)
  // also use canonical ids — this keeps the adapter and parser perfectly
  // aligned even if a future SDK release changes how it derives item.id.
  private itemToMessages(s: AgentSession, item: ThreadItem, ts: number): Message[] {
    const turnIndex = this.currentTurnIndex(s.id);
    const threadId = s.agentSessionId;
    switch (item.type) {
      case 'agent_message': {
        const id = codexCanonicalId(threadId, turnIndex, 'msg', this.nextSeq(s.id, 'msg'));
        return [{ id, ts, kind: 'assistant', text: item.text, model: 'codex' }];
      }
      case 'reasoning': {
        if (!item.text.trim()) return [];
        const id = codexCanonicalId(threadId, turnIndex, 'reason', this.nextSeq(s.id, 'reason'));
        return [{ id, ts, kind: 'system', text: `Reasoning: ${item.text}` }];
      }
      case 'command_execution': {
        const callId = codexCanonicalId(threadId, turnIndex, 'exec', this.nextSeq(s.id, 'exec'));
        return [
          {
            id: `${callId}-use`,
            ts,
            kind: 'tool_use',
            parentId: callId,
            toolUseId: callId,
            toolName: 'Command',
            input: { command: item.command },
          },
          {
            id: `${callId}-result`,
            ts,
            kind: 'tool_result',
            toolUseId: callId,
            output:
              item.aggregated_output ||
              (item.exit_code === undefined ? 'Command started.' : `Exit code ${item.exit_code}`),
            isError: item.status === 'failed',
          },
        ];
      }
      case 'file_change': {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const callId = codexCanonicalId(threadId, turnIndex, 'patch', this.nextSeq(s.id, 'patch'));
        return [
          {
            id: `${callId}-use`,
            ts,
            kind: 'tool_use',
            parentId: callId,
            toolUseId: callId,
            toolName: 'Patch',
            input: { changes },
          },
          {
            id: `${callId}-result`,
            ts,
            kind: 'tool_result',
            toolUseId: callId,
            output: changes.map((c) => `${c.kind}: ${c.path}`).join('\n'),
            isError: item.status === 'failed',
          },
        ];
      }
      case 'mcp_tool_call': {
        const callId = codexCanonicalId(threadId, turnIndex, 'mcp', this.nextSeq(s.id, 'mcp'));
        const result = item.error?.message ?? (item.result ? JSON.stringify(item.result, null, 2) : '');
        return [
          {
            id: `${callId}-use`,
            ts,
            kind: 'tool_use',
            parentId: callId,
            toolUseId: callId,
            toolName: `${item.server}.${item.tool}`,
            input: item.arguments ?? {},
          },
          {
            id: `${callId}-result`,
            ts,
            kind: 'tool_result',
            toolUseId: callId,
            output: result,
            isError: item.status === 'failed',
          },
        ];
      }
      case 'web_search': {
        const callId = codexCanonicalId(threadId, turnIndex, 'search', this.nextSeq(s.id, 'search'));
        return [
          {
            id: `${callId}-use`,
            ts,
            kind: 'tool_use',
            parentId: callId,
            toolUseId: callId,
            toolName: 'WebSearch',
            input: { query: item.query },
          },
        ];
      }
      case 'todo_list': {
        const items = Array.isArray(item.items) ? item.items : [];
        const id = codexCanonicalId(threadId, turnIndex, 'todo', this.nextSeq(s.id, 'todo'));
        return [
          {
            id,
            ts,
            kind: 'system',
            text: items.map((todo) => `${todo.completed ? '[x]' : '[ ]'} ${todo.text}`).join('\n'),
          },
        ];
      }
      case 'error': {
        const id = codexCanonicalId(threadId, turnIndex, 'err', this.nextSeq(s.id, 'err'));
        return [{ id, ts, kind: 'system', text: item.message }];
      }
      default:
        return [];
    }
  }

  private describeEvent(event: ThreadEvent): Record<string, unknown> {
    if ('item' in event) {
      return {
        type: event.type,
        itemId: event.item.id,
        itemType: event.item.type,
      };
    }
    if (event.type === 'thread.started') return { type: event.type, threadId: event.thread_id };
    if (event.type === 'turn.failed') return { type: event.type, message: event.error.message };
    if (event.type === 'error') return { type: event.type, message: event.message };
    return { type: event.type };
  }
}
