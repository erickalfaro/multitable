import { homedir } from 'os';
import type { AgentSession } from '../types.js';
import type { Message } from '../../transcripts/parser.js';
import type { ProviderAdapter, ProviderCapabilities, AdapterCallbacks } from './types.js';
import {
  runCursor,
  buildCursorArgs,
  contentText,
  readToolCall,
  type CursorEvent,
  type CursorAssistantEvent,
  type CursorThinkingEvent,
  type CursorToolCallEvent,
  type CursorResultEvent,
  type CursorToolBody,
} from './cursor-cli/index.js';

// CursorAdapter — drives the Cursor CLI (`cursor-agent`) in headless
// `--print --output-format stream-json` mode. Unlike the ACP providers
// (Hermes/Grok) and Codex's app-server, Cursor has NO long-lived child: each
// turn is an independent `cursor-agent` process whose NDJSON stdout we parse to
// completion, resumed across turns by `--resume <session_id>`. See
// .claude/skills/cursor-cli/ for the wire contract and design rationale.
//
// Tool gating is mode/allowlist-based (OS/CLI-enforced), not interactive — like
// Codex's sandbox, NOT Claude/Grok's per-call approval callback. So there is no
// PermissionManager wiring here. Effort is encoded in the model id (no effort
// flag). Usage is tokens-only (no USD, no live limit feed).

interface ToolMeta {
  name: string;
  input: Record<string, unknown>;
}

export class CursorAdapter implements ProviderAdapter {
  readonly name = 'cursor' as const;

  readonly capabilities: ProviderCapabilities = {
    // result.usage has token counts only — no USD figure.
    costUsd: false,
    // No in-band rate-limit feed; Cursor enforces at the account/plan level
    // (cursor.com). See .claude/skills/cursor-cli/reference/usage-limits.md.
    usageLimits: false,
    // Real read-only planning via `--mode plan`.
    planMode: 'native',
    // Tools are gated by mode + the ~/.cursor allowlist (CLI/OS-enforced).
    // Headless mode cannot prompt per-call, so this is sandbox-style, not a
    // callback into PermissionManager.
    perCallApproval: 'sandbox',
    // No AskUserQuestion-style event in headless stream-json.
    userQuestion: 'unsupported',
    elicitation: false,
    subagents: 'none',
    // One-shot child per turn — no mid-stream steering.
    midTurnInput: false,
    // Machine-wide Cursor login / CURSOR_API_KEY — no per-session BYOK.
    byok: false,
    // `--sandbox` left at Cursor's default in v1.
    hardSandbox: false,
    hooks: 'none',
    // Assistant/thinking text streams as additive token pieces.
    streamingDeltaSemantics: 'additive',
    // Each turn is a fresh spawn, so --model can change between turns.
    modelSwitchScope: 'per-turn',
    // Mapped to cursor-agent flags in cursor-cli/args.ts. `force` is the
    // out-of-the-box default (see db/store.ts initialMode) — the other three
    // are read-only/gated.
    modes: [
      {
        value: 'force',
        label: 'Run everything',
        description: 'Cursor runs every tool (edits, shell) without prompting (cursor-agent --force).',
        tone: 'danger',
      },
      {
        value: 'default',
        label: 'Agent',
        description: 'Default permission mode — honors your ~/.cursor allowlist; other tools are blocked.',
        tone: 'standard',
      },
      {
        value: 'plan',
        label: 'Plan',
        description: 'Read-only planning — analyze and propose an approach, no edits (--mode plan).',
        tone: 'safe',
      },
      {
        value: 'ask',
        label: 'Ask',
        description: 'Read-only Q&A for explanations and questions (--mode ask).',
        tone: 'safe',
      },
    ],
    // Effort tiers are baked into Cursor model ids (e.g. gpt-5.5-high), not a
    // separate knob — so the cross-provider effort toggle does not apply.
    thinkingEffort: 'unsupported',
  };

  // No per-session resume bookkeeping beyond s.agentSessionId; reset is a no-op
  // hook for symmetry (the on-disk chat persists regardless).
  reset(_s: AgentSession): void {
    /* nothing cached daemon-side */
  }

  async runTurn(
    s: AgentSession,
    text: string,
    ctrl: AbortController,
    cb: AdapterCallbacks,
  ): Promise<void> {
    if (s.userMessages.length === 1) cb.maybeRenameFromFirstPrompt(text);

    const cwd = s.workingDir || homedir();
    const args = buildCursorArgs({
      mode: s.mode,
      model: s.model ?? null,
      resumeId: s.agentSessionId ?? null,
      prompt: text,
    });

    // Per-turn accumulation.
    let assistantText = '';
    let reasoningText = '';
    let learnedSessionId: string | null = null;
    let resultEvent: CursorResultEvent | null = null;
    const toolCalls = new Map<string, ToolMeta>();
    const sid = () => learnedSessionId ?? s.agentSessionId ?? 'pending';

    const onEvent = (raw: CursorEvent) => {
      const type = (raw as { type?: string }).type;
      switch (type) {
        case 'system': {
          const init = raw as { subtype?: string; session_id?: string };
          if (init.subtype !== 'init' || !init.session_id) return;
          learnedSessionId = init.session_id;
          if (init.session_id !== s.agentSessionId) {
            const prev = s.agentSessionId;
            const nextHistory =
              prev && !s.agentSessionIdHistory.includes(prev)
                ? [...s.agentSessionIdHistory, prev]
                : s.agentSessionIdHistory;
            cb.onSessionIdAssigned(init.session_id, nextHistory);
            cb.emitStateSnapshot();
          }
          cb.bumpActivity();
          return;
        }
        case 'thinking': {
          const ev = raw as CursorThinkingEvent;
          if (ev.subtype !== 'delta') return;
          const t = typeof ev.text === 'string' ? ev.text : '';
          if (!t) return;
          reasoningText += t;
          cb.emitReasoningDelta(reasoningText);
          cb.bumpActivity();
          return;
        }
        case 'assistant': {
          const ev = raw as CursorAssistantEvent;
          // Only ADDITIVE token pieces drive the live preview. Cursor also
          // emits CONSOLIDATED full-segment lines (carry model_call_id, or lack
          // timestamp_ms) which would double-count — skip those here; the
          // canonical text comes from the terminal `result` event. See
          // .claude/skills/cursor-cli/pitfalls.md #2.
          const isAdditive = ev.model_call_id == null && ev.timestamp_ms != null;
          if (!isAdditive) return;
          const t = contentText(ev.message?.content);
          if (!t) return;
          assistantText += t;
          cb.emitAssistantDelta(assistantText);
          cb.bumpActivity();
          return;
        }
        case 'tool_call': {
          const ev = raw as CursorToolCallEvent;
          const callId = typeof ev.call_id === 'string' ? ev.call_id : '';
          const parsed = readToolCall(ev);
          if (!callId || !parsed) return;
          if (ev.subtype === 'started') {
            const input = parsed.body.args ?? {};
            toolCalls.set(callId, { name: parsed.name, input });
            const msg: Message = {
              id: `cursor:${sid()}:tool_use:${callId}`,
              ts: Date.now(),
              kind: 'tool_use',
              parentId: `cursor:${sid()}:assistant:pending`,
              toolUseId: callId,
              toolName: parsed.name,
              input,
            };
            cb.pushMessages([msg]);
            cb.emitToolEvent([msg]);
            cb.setCurrentTool(parsed.name);
            cb.bumpActivity();
          } else if (ev.subtype === 'completed') {
            const { output, isError } = renderToolResult(parsed.body);
            const msg: Message = {
              id: `cursor:${sid()}:tool_result:${callId}`,
              ts: Date.now(),
              kind: 'tool_result',
              toolUseId: callId,
              output,
              isError,
            };
            cb.pushMessages([msg]);
            cb.emitToolEvent([msg]);
            cb.incrementToolCount();
            cb.setCurrentTool(null);
            cb.emitToolDelta(null);
            toolCalls.delete(callId);
            cb.bumpActivity();
          }
          return;
        }
        case 'result': {
          resultEvent = raw as CursorResultEvent;
          return;
        }
        default:
          return;
      }
    };

    const run = await runCursor({ args, cwd, signal: ctrl.signal, onEvent }).catch((err) => {
      // Spawn failure (ENOENT) or transport error — almost always "cursor-agent
      // not installed / not on PATH".
      const message = err instanceof Error ? err.message : String(err);
      cb.emitAlert({
        category: 'auth',
        severity: 'error',
        title: 'Could not start cursor-agent',
        body:
          'Failed to launch the Cursor CLI. Is it installed and on PATH? ' +
          'Install from https://cursor.com/cli, then sign in with `cursor-agent login`.' +
          `\n\nUnderlying error: ${message}`,
        persistent: true,
      });
      throw err;
    });

    // Aborted mid-turn: the child was killed. Not a failure — let the manager
    // settle the turn (it owns the abort → idle transition).
    if (ctrl.signal.aborted) return;

    const result = resultEvent as CursorResultEvent | null;
    if (!run.sawResult || !result || result.is_error || (result.subtype && result.subtype !== 'success')) {
      const detail = run.stderr.trim();
      if (/log\s?in|sign\s?in|unauthor|api[_\s-]?key|credential/i.test(detail)) {
        cb.emitAlert({
          category: 'auth',
          severity: 'error',
          title: 'Sign in to Cursor',
          body:
            'cursor-agent has no usable credentials. Run `cursor-agent login` or set ' +
            'CURSOR_API_KEY, then retry.',
          persistent: true,
        });
      }
      throw new Error(
        `cursor-agent turn failed (exit ${run.exitCode}${detail ? `: ${detail.slice(0, 500)}` : ''})`,
      );
    }

    // Finalize. The reasoning + assistant text streamed live as previews
    // (emitReasoningDelta / emitAssistantDelta); turn-complete clears those, so
    // we MUST emit canonical messages to replace them. Reasoning first so it
    // renders above the answer. Prefer the canonical result text over the
    // accumulated additive pieces.
    const now = Date.now();
    const finalMessages: Message[] = [];
    const finalAssistant =
      typeof result.result === 'string' && result.result.trim().length > 0
        ? result.result
        : assistantText;

    if (reasoningText.trim().length > 0) {
      finalMessages.push({
        id: `cursor:${sid()}:reasoning:${now}`,
        ts: now,
        kind: 'reasoning',
        text: reasoningText,
      });
      cb.emitReasoningDelta('');
    }
    if (finalAssistant.trim().length > 0) {
      finalMessages.push({
        id: `cursor:${sid()}:assistant:${now}`,
        ts: now + 1,
        kind: 'assistant',
        text: finalAssistant,
        model: s.model ?? 'cursor',
      });
      cb.emitAssistantDelta('');
    }
    if (finalMessages.length > 0) {
      cb.pushMessages(finalMessages);
      cb.emitAssistantMessage(finalMessages);
    }

    const u = result.usage ?? {};
    const tokensIn = numberOr(u.inputTokens, 0);
    const tokensOut = numberOr(u.outputTokens, 0);
    const cacheReadTokens = numberOr(u.cacheReadTokens, 0);
    const cacheCreationTokens = numberOr(u.cacheWriteTokens, 0);
    cb.applyUsage({
      tokensIn,
      tokensOut,
      cacheCreationTokens,
      cacheReadTokens,
      costUsd: 0,
    });
    cb.emitTurnResult({
      subtype: result.subtype ?? 'success',
      totalCostUsd: 0,
      usage: {
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        cacheCreationInputTokens: cacheCreationTokens,
        cacheReadInputTokens: cacheReadTokens,
      },
      text: finalAssistant || null,
    });
    cb.emitStateSnapshot();
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Render a completed tool_call's result into display text. Read-only modes
// surface `rejected` (expected gating, not a turn failure).
function renderToolResult(body: CursorToolBody): { output: string; isError: boolean } {
  const result = body.result;
  if (result?.rejected) {
    const r = result.rejected;
    const reason = r.reason && r.reason.trim() ? `: ${r.reason}` : '';
    return { output: `⊘ Rejected${reason} (not permitted in this mode)`, isError: true };
  }
  if (result?.success != null) {
    const s = result.success;
    if (typeof s === 'string') return { output: s, isError: false };
    try {
      return { output: JSON.stringify(s, null, 2), isError: false };
    } catch {
      return { output: String(s), isError: false };
    }
  }
  return { output: '', isError: false };
}
