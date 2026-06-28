import { homedir } from 'os';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import envPaths from 'env-paths';
import type { AgentSession, UsageLimitSnapshot } from '../types.js';
import type { Message } from '../../transcripts/parser.js';
import type { ProviderAdapter, ProviderCapabilities, AdapterCallbacks } from './types.js';
import type { PermissionManager } from '../../hooks/permissionManager.js';
import { GrokAcpClient } from './grok-acp/index.js';
import { fetchGrokUsage } from './grok-usage.js';
import type {
  RpcNotification,
  GrokAuthState,
  NewSessionOptions,
  AcpPermissionRequest,
  AcpPermissionOutcome,
  AcpAskQuestionRequest,
  AcpAskQuestionOutcome,
  AcpExitPlanRequest,
  AcpExitPlanOutcome,
} from './grok-acp/index.js';

// GrokAdapter — driven by `grok agent stdio`, xAI's Grok Build CLI run as an
// Agent Client Protocol (ACP) agent over stdio. Architecturally a sibling of
// the Hermes adapter (both speak ACP) but a SEPARATE implementation — see
// .claude/skills/grok-build/.
//
// Auth: Grok reads ~/.grok/auth.json itself (the `cached_token` ACP auth method,
// written by `grok auth login` for SuperGrok / X-Premium subscribers). We don't
// pin an inference provider or wrap the child in a sandbox — Grok is a
// self-contained binary with its own `--sandbox` / workspace-trust model.
//
// Per turn:
//  1. clientFor(cwd, mode, effort, model) — Grok's mode/effort/model are
//     SPAWN-TIME flags on the `grok agent` child (verified: session/new ignores
//     them), so we pool one child per distinct config and key by it.
//  2. ensureSessionId() — `session/new` for a fresh session or `session/load`
//     to re-attach. The cache is keyed by {grokSessionId, mode, effort, model}
//     so a mode/effort/model flip re-resolves to a different child + reloads.
//  3. subscribe(grokSessionId, listener) — every ACP session/update carries
//     `sessionId` so multiplexing is just routing.
//  4. session/prompt with [{type:'text', text}]; drain session/update until the
//     prompt response returns with a stopReason + usage in `_meta`.
//  5. Emit the canonical assistant message from the accumulated chunks.
//
// Streaming model (verified v0.2.2):
//  - `agent_message_chunk` / `agent_thought_chunk` deltas are ADDITIVE — each
//    chunk is a fresh piece. We accumulate and emit cumulative text so the
//    StreamBuffer reducer gets the cumulative shape it expects.
//  - `tool_call` / `tool_call_update` carry per-call lifecycle; a
//    `tool_call_update` with status completed/failed is the canonical result.
//
// Permission scope: like every ACP agent, Grok self-gates — it only emits
// session/request_permission for calls it deems sensitive (driven by the
// session's permissionMode). The host cannot force-prompt every call. See
// .claude/skills/grok-build/multitable/permission-wiring.md.
//
// Modes (verified grok 0.2.2): there is NO per-session mode RPC and session/new
// ignores `permissionMode`. Mode is spawn-time only, so we expose 3 honest modes
// mapped to the `grok agent` flags that actually take effect:
//   default → (no flag)            prompts on sensitive tools
//   auto    → --always-approve     runs every tool without asking
//   plan    → --agent-profile <MT plan profile>  full-capability agent started
//             in permission_mode:plan. It plans first (read-only, writing only
//             its plan.md), then calls exit_plan_mode (an `_x.ai/exit_plan_mode`
//             server-request we gate via the approval UI). On approve it
//             EXECUTES the plan in the SAME session; on reject we abort the turn.
//             (The read-only bundled plan.md is NOT used — it has no edit tools,
//             so it could never execute. See handleExitPlanMode.)
// Effort → --reasoning-effort (max → xhigh; grok has no 'max'). Model → -m.

interface SessionCacheEntry {
  grokSessionId: string;
  mode: string;
  effort: string | null;
  model: string | null;
}

interface ToolCallMeta {
  toolName: string;
  input: Record<string, unknown>;
}

interface TurnBuffers {
  assistantText: string;
  reasoningText: string;
  toolCalls: Map<string, ToolCallMeta>;
}

function makeBuffers(): TurnBuffers {
  return { assistantText: '', reasoningText: '', toolCalls: new Map() };
}

// Extract plain text from an ACP content block.
function extractText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as Record<string, unknown>;
  if (typeof c.text === 'string') return c.text;
  if (c.type === 'text' && typeof c.text === 'string') return c.text;
  return '';
}

// Render a tool_call_update's content + rawOutput into a human-readable string.
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
        typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput),
      );
    } catch {
      parts.push(String(update.rawOutput));
    }
  }
  return parts.join('\n');
}

export class GrokAdapter implements ProviderAdapter {
  readonly name = 'grok' as const;

  readonly capabilities: ProviderCapabilities = {
    // Grok exposes account usage via x.ai/billing, but it's TUI-only over
    // agent-stdio and isn't a per-turn USD figure. Hide the dollar row.
    costUsd: false,
    // No limit feed over agent-stdio, but we fetch SuperGrok usage OUT-OF-BAND
    // from xAI's gRPC-web billing RPC (codexbar pattern) via fetchUsageLimits.
    // See grok-usage.ts + .claude/skills/grok-build/reference/usage-limits.md.
    usageLimits: true,
    // Grok has a real `plan` permission-mode (shows diffs, requires approval).
    planMode: 'native',
    // ACP session/request_permission → PermissionManager (same flow as Claude).
    perCallApproval: 'callback',
    // Grok's `ask_user_question` tool delegates to the client via the
    // `_x.ai/ask_user_question` server-request; we route it through the same
    // interactive question UI Claude's AskUserQuestion uses.
    userQuestion: 'tool',
    elicitation: false,
    // Grok runs up to 8 parallel subagents, but we don't surface subagent
    // lifecycle events yet — keep 'none' until the session/update kinds are
    // wired into emitTaskEvent/incrementSubagents.
    subagents: 'none',
    midTurnInput: false,
    // Machine-wide ~/.grok/auth.json (or GROK_CODE_XAI_API_KEY) — no per-session BYOK.
    byok: false,
    // v1 leaves `--sandbox` at Grok's default and gates via permission-mode;
    // we don't enforce an OS sandbox ourselves.
    hardSandbox: false,
    hooks: 'none',
    // ACP chunk semantics are additive (each chunk is a piece).
    streamingDeltaSemantics: 'additive',
    modelSwitchScope: 'per-session',
    // Grok mode is creation-bound: `session/load` rehydrates the agent the
    // session was created with, so flipping the mode selector post-creation
    // doesn't reliably change capability (plan↔editable is silently no-op'd at
    // the wire). Plan→execute within a single session is handled by Grok's
    // native exit_plan_mode flow, not the selector. See reference/modes.md.
    modeSwitchScope: 'creation',
    // Mode is a SPAWN-TIME lever on `grok agent` (no per-session ACP set-mode;
    // session/new ignores permissionMode — verified 0.2.2). Only these 3 map to
    // distinct, real grok-agent flags (see buildAgentArgs); the other Claude
    // permission-modes have no separate stdio behavior so we don't pretend to.
    modes: [
      {
        value: 'default',
        label: 'Ask first',
        description: 'Standard — Grok prompts before running sensitive tools.',
        tone: 'standard',
      },
      {
        value: 'auto',
        label: 'Auto-approve',
        description: 'Grok runs every tool without asking (grok --always-approve).',
        tone: 'danger',
      },
      {
        value: 'plan',
        label: 'Plan',
        description: 'Plan first — Grok designs an approach, then implements it once you approve.',
        tone: 'safe',
      },
    ],
    // Grok takes --reasoning-effort none|minimal|low|medium|high|xhigh as a
    // spawn flag (NOT a session/new param). MultiTable 'max' → 'xhigh' (grok has
    // no 'max'). See buildAgentArgs / mapEffortToGrok.
    thinkingEffort: 'native',
  };

  private permManager: PermissionManager;
  // Per-project-cwd pool of `grok agent stdio` children. Empty when an injected
  // client is supplied for tests.
  private clients = new Map<string, GrokAcpClient>();
  private injectedClient: GrokAcpClient | null = null;
  private sessions = new Map<string, SessionCacheEntry>();
  // Reverse map (Grok ACP session id → MultiTable session id) so the permission
  // handler — which only knows the ACP id — can resolve back to the host session.
  private acpToMt = new Map<string, string>();
  // Per-MT-session prior ACP `plan` snapshot, used to diff successive plan
  // session/update notifications into synthetic Tasks-panel events.
  private planState = new Map<
    string,
    { turnSeq: number; entries: Array<{ status: string }>; logged: boolean }
  >();
  // In-flight turn AbortControllers keyed by Grok ACP session id, so the
  // exit_plan_mode handler can abort the turn when the user rejects a plan
  // (Grok proceeds to execute on any reply, so cancellation is the real gate).
  private activeTurnCtrls = new Map<string, AbortController>();

  constructor(permManager: PermissionManager, client?: GrokAcpClient) {
    this.permManager = permManager;
    this.injectedClient = client ?? null;
  }

  // Grok's mode/effort/model are spawn-time flags on the `grok agent` child, so
  // a child is bound to one config for its lifetime. We therefore pool one child
  // per distinct {cwd, mode, effort, model} (keyed by the resolved spawn args) —
  // a mode/effort flip routes to a different child, the same way Codex discards
  // its cached thread when its immutable options change.
  private clientFor(
    cwd: string,
    mode: string,
    effort: string | null,
    model: string | null,
  ): GrokAcpClient {
    if (this.injectedClient) return this.injectedClient;
    const agentArgs = this.buildAgentArgs(mode, effort, model);
    const key = JSON.stringify([cwd, agentArgs]);
    const existing = this.clients.get(key);
    if (existing) return existing;
    const created = new GrokAcpClient({
      permissionHandler: (req) => this.handleAcpPermission(req),
      askQuestionHandler: (req) => this.handleAskQuestion(req),
      exitPlanHandler: (req) => this.handleExitPlanMode(req),
      cwd,
      agentArgs,
    });
    this.clients.set(key, created);
    return created;
  }

  // Map a session's mode/effort/model onto `grok agent` spawn flags (placed
  // before `stdio`). This is the ONLY thing that actually changes Grok's
  // permission behavior over agent-stdio — session/new params are ignored.
  private buildAgentArgs(mode: string, effort: string | null, model: string | null): string[] {
    const args: string[] = [];
    if (mode === 'auto') {
      // Runs every tool without a permission prompt.
      args.push('--always-approve');
    } else if (mode === 'plan') {
      // Full-capability agent started in permission_mode:plan — plans first,
      // then executes in the same session after the user approves exit_plan_mode
      // (see handleExitPlanMode). We ship our OWN profile rather than Grok's
      // bundled plan.md (a read-only architect with no edit tools, which could
      // never execute). If the profile can't be written, fall back to default
      // prompting rather than silently degrading.
      const profile = ensurePlanProfilePath();
      if (profile) args.push('--agent-profile', profile);
      else
        console.warn('[grok] no plan profile available; plan mode falls back to default prompting');
    }
    // mode === 'default': no approval flag — Grok prompts via session/request_permission.
    if (effort) args.push('--reasoning-effort', mapEffortToGrok(effort));
    if (model) args.push('-m', model);
    return args;
  }

  reset(s: AgentSession): void {
    const existing = this.sessions.get(s.id);
    if (existing) this.acpToMt.delete(existing.grokSessionId);
    this.sessions.delete(s.id);
    this.planState.delete(s.id);
  }

  /** Daemon shutdown hook. Closes every per-project grok child. */
  shutdown(): void {
    if (this.injectedClient) this.injectedClient.close();
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }

  /**
   * Out-of-band usage-limits fetch (manager poll loop). Reads ~/.grok/auth.json
   * and queries xAI's gRPC-web billing RPC — agent-stdio carries no limit feed,
   * so this is the only path (codexbar pattern). Account-wide; the manager fans
   * the result to all Grok sessions. Null on missing creds / auth / parse miss.
   */
  async fetchUsageLimits(_s: AgentSession): Promise<UsageLimitSnapshot | null> {
    return fetchGrokUsage();
  }

  async runTurn(
    s: AgentSession,
    text: string,
    ctrl: AbortController,
    cb: AdapterCallbacks,
  ): Promise<void> {
    if (s.userMessages.length === 1) cb.maybeRenameFromFirstPrompt(text);

    const cwd = this.resolveCwd(s);
    const client = this.clientFor(cwd, s.mode, s.thinkingEffort ?? null, s.model ?? null);

    // 1. Make sure the long-lived child is up and authenticated.
    let authState: GrokAuthState;
    try {
      authState = await client.ensureReady();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cb.emitAlert({
        category: 'auth',
        severity: 'error',
        title: 'Could not start grok agent stdio',
        body:
          `Failed to spawn or initialise \`grok agent stdio\`. Is Grok Build installed and on PATH? ` +
          `Install: curl -fsSL https://x.ai/cli/install.sh | bash` +
          `\n\nUnderlying error: ${message}`,
        persistent: true,
      });
      throw err;
    }

    if (authState.kind === 'needsSetup') {
      cb.emitAlert({
        category: 'auth',
        severity: 'error',
        title: 'Sign in to Grok',
        body:
          'No usable Grok credentials found. Run `grok auth login` (SuperGrok / X Premium+ ' +
          'required) or set GROK_CODE_XAI_API_KEY, then retry.',
        persistent: true,
      });
      throw new Error('grok agent stdio: no provider credentials configured');
    }

    // 2. Mint or load the ACP session id.
    const grokSessionId = await this.ensureSessionId(s, cb, client, cwd);

    // 3. Wire streaming. Subscribe BEFORE prompt so we can't miss early chunks.
    const buffers = makeBuffers();

    const prevPlan = this.planState.get(s.id);
    if (prevPlan) {
      prevPlan.turnSeq += 1;
      prevPlan.entries = [];
    } else {
      this.planState.set(s.id, { turnSeq: 0, entries: [], logged: false });
    }

    const off = client.subscribe(grokSessionId, (n) => {
      try {
        this.handleNotification(s, n, cb, buffers);
      } catch (err) {
        console.error('[grok] notification handler threw', {
          sessionId: s.id,
          grokSessionId,
          method: n.method,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    const onAbort = () => client.cancel(grokSessionId);
    ctrl.signal.addEventListener('abort', onAbort, { once: true });
    // Expose this turn's controller so handleExitPlanMode can abort it if the
    // user rejects the plan (Grok executes on any exit_plan_mode reply).
    this.activeTurnCtrls.set(grokSessionId, ctrl);

    console.info('[grok] starting turn', {
      sessionId: s.id,
      grokSessionId,
      promptLength: text.length,
    });

    try {
      const result = await client.prompt({ sessionId: grokSessionId, text });

      console.info('[grok] turn completed', {
        sessionId: s.id,
        grokSessionId,
        stopReason: result.stopReason,
      });

      // Finalize the turn's messages. The reasoning + assistant text streamed
      // live as previews (emitReasoningDelta / emitAssistantDelta); turn-complete
      // clears those previews, so we MUST emit canonical messages to replace
      // them or the thinking + answer vanish. Reasoning first so it renders
      // above the answer (matches grokParser's on-disk ordering). Emitting both
      // in one assistant-message broadcast keeps the swap atomic on the client.
      const now = Date.now();
      const finalMessages: Message[] = [];

      if (buffers.reasoningText.trim().length > 0) {
        finalMessages.push({
          id: `grok:${grokSessionId}:reasoning:${now}`,
          ts: now,
          kind: 'reasoning',
          text: buffers.reasoningText,
        });
        cb.emitReasoningDelta('');
      }

      if (buffers.assistantText.trim().length > 0) {
        finalMessages.push({
          id: `grok:${grokSessionId}:assistant:${now}`,
          ts: now + 1,
          kind: 'assistant',
          text: buffers.assistantText,
          model: s.model ?? 'grok-build',
        });
        cb.emitAssistantDelta('');
      }

      if (finalMessages.length > 0) {
        cb.pushMessages(finalMessages);
        cb.emitAssistantMessage(finalMessages);
      }

      // Usage comes back in the prompt response `_meta` (no USD).
      const meta = result._meta ?? {};
      const tokensIn = numberOr(meta.inputTokens, 0);
      const tokensOut = numberOr(meta.outputTokens, 0);
      const cacheReadTokens = numberOr(meta.cachedReadTokens, 0);
      const cacheCreationTokens = numberOr(meta.cacheCreationTokens, 0);

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

      // ACP stopReasons per the spec: end_turn | max_tokens |
      // max_turn_requests | refusal | cancelled. Only end_turn (clean
      // completion) and cancelled (user-initiated) are quiet outcomes;
      // everything else is a model-side failure that MUST reach the user.
      // Without this branch a `refusal` or `max_tokens` turn looks
      // indistinguishable from a clean turn-end with no assistant text.
      const reason = result.stopReason ?? '';
      if (reason && reason !== 'end_turn' && reason !== 'cancelled') {
        const errMsg: Message = {
          id: `grok:${grokSessionId}:stop-error:${Date.now()}`,
          ts: Date.now(),
          kind: 'system',
          text: `Grok turn ended with stopReason="${reason}".`,
        };
        cb.pushMessages([errMsg]);
        cb.emitToolEvent([errMsg]);
        cb.emitAlert({
          category: 'turn',
          severity: 'error',
          title: `Grok turn ended: ${reason}`,
          body:
            reason === 'refusal'
              ? 'The model refused to respond. Try rephrasing or relaxing the prompt.'
              : reason === 'max_tokens'
                ? 'The response was cut off at the model output-token ceiling.'
                : reason === 'max_turn_requests'
                  ? 'The agent hit the maximum number of internal tool-call iterations for this turn.'
                  : `Unrecognized stopReason — see grok agent stdio logs.`,
        });
      }
    } catch (err) {
      console.error('[grok] turn failed', {
        sessionId: s.id,
        grokSessionId,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      // Drop the cached session so the next turn re-loads. The ACP session
      // persists in ~/.grok regardless.
      this.acpToMt.delete(grokSessionId);
      this.sessions.delete(s.id);
      throw err;
    } finally {
      ctrl.signal.removeEventListener('abort', onAbort);
      this.activeTurnCtrls.delete(grokSessionId);
      off();
    }
  }

  // Resolve a session's project cwd, never empty.
  private resolveCwd(s: AgentSession): string {
    if (!s.workingDir) {
      console.warn('[grok] session has empty workingDir; falling back to homedir', {
        sessionId: s.id,
        projectId: s.projectId,
      });
      return homedir();
    }
    return s.workingDir;
  }

  private async ensureSessionId(
    s: AgentSession,
    cb: AdapterCallbacks,
    client: GrokAcpClient,
    cwd: string,
  ): Promise<string> {
    const effort = s.thinkingEffort ?? null;
    const model = s.model ?? null;
    const existing = this.sessions.get(s.id);
    if (
      existing &&
      existing.mode === s.mode &&
      existing.effort === effort &&
      existing.model === model
    ) {
      return existing.grokSessionId;
    }

    // mode/effort/model are spawn-time on the child this session was routed to
    // (see clientFor) — session/new only needs the cwd.
    const opts: NewSessionOptions = { cwd };

    let grokSessionId: string;
    let loaded = false;
    if (s.agentSessionId) {
      try {
        grokSessionId = await client.loadSession(s.agentSessionId, opts);
        loaded = true;
      } catch (err) {
        console.warn('[grok] session/load failed, creating fresh', {
          sessionId: s.id,
          grokSessionId: s.agentSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        grokSessionId = await client.newSession(opts);
      }
    } else {
      grokSessionId = await client.newSession(opts);
    }

    // If Grok replays history as session/update after load (Zed-style), it would
    // duplicate what we already hydrated from disk. Wait briefly before the
    // caller subscribes so most replay lands with no listener; tool-id dedup in
    // handleNotification catches the tail.
    if (loaded) await new Promise<void>((r) => setTimeout(r, 500));

    if (grokSessionId !== s.agentSessionId) {
      const previous = s.agentSessionId;
      const nextHistory =
        previous && !s.agentSessionIdHistory.includes(previous)
          ? [...s.agentSessionIdHistory, previous]
          : s.agentSessionIdHistory;
      cb.onSessionIdAssigned(grokSessionId, nextHistory);
      cb.emitStateSnapshot();
    }

    this.sessions.set(s.id, { grokSessionId, mode: s.mode, effort, model });
    this.acpToMt.set(grokSessionId, s.id);
    return grokSessionId;
  }

  // ACP session/request_permission → PermissionManager. Same prompt card Claude
  // tool calls use; the user's Allow/Deny becomes the optionId we return.
  // "Always Allow" is handled inside PermissionManager (sessionAllowList), so we
  // always return `allow_once` to Grok.
  private async handleAcpPermission(req: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    const mtSessionId = this.acpToMt.get(req.sessionId);
    if (!mtSessionId) {
      console.warn('[grok] permission request for unknown acp session', req.sessionId);
      return { outcome: { outcome: 'cancelled' } };
    }

    const tc = req.toolCall ?? {};
    const toolName =
      (typeof tc.kind === 'string' && tc.kind) ||
      (typeof tc.title === 'string' && tc.title) ||
      'grok_tool';
    const toolInput =
      tc.rawInput && typeof tc.rawInput === 'object'
        ? (tc.rawInput as Record<string, unknown>)
        : {};
    const firstLoc =
      Array.isArray(tc.locations) && tc.locations[0]?.path ? String(tc.locations[0].path) : undefined;

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

  // Grok's `ask_user_question` tool → MultiTable's interactive question UI.
  // Bridges the ACP `_x.ai/ask_user_question` request to
  // PermissionManager.requestFromSdk with toolName 'AskUserQuestion' (the exact
  // path Claude's AskUserQuestion uses, rendered by PermissionBar), then maps
  // the user's selections back into Grok's answers-by-index response shape.
  private async handleAskQuestion(req: AcpAskQuestionRequest): Promise<AcpAskQuestionOutcome> {
    const mtSessionId = this.acpToMt.get(req.sessionId);
    if (!mtSessionId) {
      console.warn('[grok] ask_user_question for unknown acp session', req.sessionId);
      return { outcome: 'cancelled' };
    }

    const controller = new AbortController();
    const result = await this.permManager.requestFromSdk(
      mtSessionId,
      '',
      'AskUserQuestion',
      { questions: req.questions },
      controller.signal,
    );

    // AskUserQuestion answers come back as a 'deny' whose message is JSON:
    // { questions: [{ question, header, answer: string[] }] } (the Claude
    // convention PermissionManager reuses). A 'Cancelled' / 'Session cleared'
    // message (or any non-answer) maps to cancelled.
    if (result.behavior !== 'deny' || !result.message) {
      return { outcome: 'cancelled' };
    }
    let parsed: { questions?: Array<{ answer?: unknown }> };
    try {
      parsed = JSON.parse(result.message);
    } catch {
      return { outcome: 'cancelled' };
    }
    const qs = Array.isArray(parsed.questions) ? parsed.questions : [];
    const answers: Record<string, string[]> = {};
    let anyPicked = false;
    qs.forEach((q, i) => {
      const picked = Array.isArray(q.answer)
        ? q.answer.filter((a): a is string => typeof a === 'string')
        : [];
      answers[String(i)] = picked;
      if (picked.length > 0) anyPicked = true;
    });
    // Empty selection across all questions = the user cancelled the picker.
    if (!anyPicked) return { outcome: 'cancelled' };
    return { outcome: 'accepted', answers };
  }

  // `_x.ai/exit_plan_mode` server-request — a plan-mode session has finished
  // planning and is asking to proceed. Grok BLOCKS on this request, then (on
  // any reply) flips to `default` and executes, so this is the plan→execute
  // gate. We surface the plan for approval; `allow` lets execution proceed in
  // the same session, `deny` aborts the turn so nothing is executed (the user
  // can revise with a follow-up message). `auto` mode skips the prompt.
  private async handleExitPlanMode(req: AcpExitPlanRequest): Promise<AcpExitPlanOutcome> {
    const mtSessionId = this.acpToMt.get(req.sessionId);
    if (!mtSessionId) {
      console.warn('[grok] exit_plan_mode for unknown acp session', req.sessionId);
      return { outcome: 'approved' };
    }
    // Auto-approve mode = no prompts: let the plan flow straight into execution.
    if (this.sessions.get(mtSessionId)?.mode === 'auto') return { outcome: 'approved' };

    const plan = req.planContent ?? '';
    const controller = new AbortController();
    const result = await this.permManager.requestFromSdk(
      mtSessionId,
      '',
      'ExitPlanMode',
      { plan },
      controller.signal,
      { title: 'Review plan & execute', displayName: 'exit_plan_mode' },
    );
    if (result.behavior === 'allow') return { outcome: 'approved' };
    // Rejected: Grok proceeds on any reply, so abort the turn to actually stop
    // before execution starts (sends session/cancel via the runTurn abort wire).
    this.activeTurnCtrls.get(req.sessionId)?.abort();
    return { outcome: 'rejected' };
  }

  private handleNotification(
    s: AgentSession,
    n: RpcNotification,
    cb: AdapterCallbacks,
    buffers: TurnBuffers,
  ): void {
    // Grok pushes everything through `session/update`. Other notification
    // methods (available_commands, x.ai-namespaced extensions) are ignored.
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
        // Fired during session/load history replay — manager already has it.
        return;
      }

      case 'tool_call': {
        const toolUseId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
        if (!toolUseId) return;
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
          id: `grok:${s.agentSessionId ?? 'pending'}:tool_use:${toolUseId}`,
          ts: Date.now(),
          kind: 'tool_use',
          parentId: `grok:${s.agentSessionId ?? 'pending'}:assistant:pending`,
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
        if (isHistoricalToolId(s, toolUseId)) return;
        const meta = buffers.toolCalls.get(toolUseId);
        const status = typeof update.status === 'string' ? update.status : '';
        const finished = status === 'completed' || status === 'failed';
        if (finished) {
          const output = renderToolOutput(update);
          const msg: Message = {
            id: `grok:${s.agentSessionId ?? 'pending'}:tool_result:${toolUseId}`,
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

      // ACP `plan`: Grok maps todo/plan-tool results here. Each entry is a step
      // `{ content, status }` with status pending|in_progress|completed. Diff
      // against the prior snapshot and normalize into the Claude-shaped
      // task_started/task_updated events the frontend reducer consumes.
      case 'plan': {
        const entries = Array.isArray(update.entries)
          ? (update.entries as Array<Record<string, unknown>>)
          : [];
        let st = this.planState.get(s.id);
        if (!st) {
          st = { turnSeq: 0, entries: [], logged: false };
          this.planState.set(s.id, st);
        }
        if (!st.logged) {
          st.logged = true;
          console.info('[grok] plan update (shape probe)', JSON.stringify(update).slice(0, 500));
        }
        const turnSeq = st.turnSeq;
        const prior = st.entries;
        const next: Array<{ status: string }> = [];
        entries.forEach((e, i) => {
          const content = typeof e.content === 'string' && e.content ? e.content : `Step ${i + 1}`;
          const status = mapAcpPlanStatus(e.status);
          const taskId = `grok-plan-t${turnSeq}-${i}`;
          next.push({ status });
          const before = prior[i];
          if (!before) {
            cb.emitTaskEvent('task_started', {
              task_id: taskId,
              description: content,
              task_type: 'plan',
              skip_transcript: true,
            });
            if (status !== 'pending') {
              cb.emitTaskEvent('task_updated', {
                task_id: taskId,
                patch: { status, description: content },
              });
            }
          } else if (before.status !== status) {
            cb.emitTaskEvent('task_updated', {
              task_id: taskId,
              patch: { status, description: content },
            });
          }
        });
        st.entries = next;
        cb.bumpActivity();
        return;
      }

      case 'current_mode_update': {
        // Grok changes mode within a turn (enter_plan_mode → 'plan',
        // exit_plan_mode → 'default'). Grok sends the new id as `currentModeId`
        // (NOT `modeId`, which the ACP spec uses — verified on 0.2.2). Our mode
        // is spawn-fixed per child, so this is informational — log for now.
        const modeId =
          (typeof update.currentModeId === 'string' && update.currentModeId) ||
          (typeof update.modeId === 'string' && update.modeId) ||
          '';
        if (modeId) console.info('[grok] current_mode_update', { sessionId: s.id, modeId });
        return;
      }

      case 'available_commands_update':
      case 'config_option_update':
      case 'usage_update':
      default:
        return;
    }
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// MultiTable's own Grok plan-mode agent profile. The ONLY thing it changes is
// `permission_mode: plan` (the lever that starts the session in plan mode over
// agent-stdio — no flag/session param does it). `prompt_mode: full` keeps Grok's
// complete, well-tuned default coding+plan-mode system prompt; the body is
// deliberately MINIMAL and NEUTRAL.
//
// History: an earlier version appended a prescriptive "design a plan, then
// implement it faithfully — make the edits, run the commands" body on top of the
// full default prompt. That biased the agent to barrel from plan straight into
// building code for ANY input — e.g. "plan a joke" turned into editing the repo
// to add a /joke command (and breaking lint). Keep this body neutral: defer to
// Grok's own plan-mode judgment, scale effort to the task, and stress that
// nothing is changed until the user approves exit_plan_mode.
const PLAN_PROFILE_CONTENT = `---
name: multitable-plan
description: Starts in plan mode — proposes a plan, then implements only after the user approves.
prompt_mode: full
model: inherit
permission_mode: plan
agents_md: true
---

Follow your standard plan-mode workflow: explore read-only, then propose a plan
via exit_plan_mode and wait for the user's approval before making any changes.
Scale the effort to the request — do not over-plan or start building for trivial
or non-code requests; for those, just answer directly.
`;

// Written once per process to the MultiTable data dir (idempotent; rewritten if
// missing). Returns '' if it can't be written, so the caller can fall back.
let planProfilePath: string | null = null;
function ensurePlanProfilePath(): string {
  if (planProfilePath && existsSync(planProfilePath)) return planProfilePath;
  try {
    const dir = envPaths('multitable', { suffix: '' }).data;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'grok-plan-profile.md');
    writeFileSync(file, PLAN_PROFILE_CONTENT, 'utf8');
    planProfilePath = file;
    return file;
  } catch (err) {
    console.warn('[grok] failed to write plan profile', err);
    return '';
  }
}

// `grok agent --reasoning-effort` accepts none|minimal|low|medium|high|xhigh —
// there is NO 'max'. MultiTable's top tier 'max' maps to Grok's top tier xhigh;
// the others pass through unchanged.
function mapEffortToGrok(effort: string): string {
  return effort === 'max' ? 'xhigh' : effort;
}

function mapAcpPlanStatus(s: unknown): 'pending' | 'running' | 'completed' {
  if (s === 'in_progress') return 'running';
  if (s === 'completed') return 'completed';
  return 'pending';
}

function isHistoricalToolId(s: AgentSession, toolUseId: string): boolean {
  if (!toolUseId) return false;
  for (const m of s.messages) {
    if (m.kind === 'tool_use' && m.toolUseId === toolUseId) return true;
  }
  return false;
}
