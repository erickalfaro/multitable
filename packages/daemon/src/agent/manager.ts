import { EventEmitter } from 'node:events';
import type {
  AgentSession,
  SendTurnInput,
  AlertSeverity,
  ThinkingEffort,
  UsageLimitSnapshot,
} from './types.js';
import type { ProcessState } from '../types.js';
import { parseCodexThread, listCodexThreads } from '../transcripts/codexParser.js';
import { parseHermesSession } from '../transcripts/hermesParser.js';
import { parseGrokSession } from '../transcripts/grokParser.js';
import { parseCursorSession } from '../transcripts/cursorParser.js';
import { parseCopilotSession } from '../transcripts/copilotParser.js';
import type { PermissionManager } from '../hooks/permissionManager.js';
import type { ElicitationManager } from '../hooks/elicitationManager.js';
import { createAlert } from './alerts.js';
import { updateSession, insertCostRecord, getSessionById } from '../db/store.js';
import { detectOptions } from '../hooks/optionDetector.js';
import { CodexAdapter } from './providers/codex.js';
import { ClaudeAdapter } from './providers/claude.js';
import { HermesAdapter } from './providers/hermes.js';
import { GrokAdapter } from './providers/grok.js';
import { CursorAdapter } from './providers/cursor.js';
import { CopilotAdapter } from './providers/copilot.js';
import { trackedTimeout, type TrackedTimer } from '../devLog.js';
import type {
  AdapterCallbacks,
  ProviderAdapter,
  ProviderCapabilities,
} from './providers/types.js';

// === AgentSessionManager: the middle layer ================================
//
// MultiTable's middle layer between the React/REST/WS app above and the
// per-provider adapters below. Owns:
//   - Session state machine (state, currentTurn, lastActivity)
//   - In-memory s.messages cache + DB writes (sessions, cost_records)
//   - WS event surface (every emit() here is rebroadcast by server.ts)
//   - Watchdog: WARN-ONLY, never kills. A silent handshake surfaces an
//     auth/network diagnostic warning; a long quiet stretch (extended thinking,
//     subagents) surfaces a soft warning. Live agent work is never thrown away
//     on a timer — only the user (clicking Stop) terminates a turn.
//   - Force-settle escape hatch: user-initiated Stop and /reset ALWAYS land,
//     even when an adapter's runTurn promise is wedged (dead child, missed
//     provider end-signal). See TurnForceSettledError + abortTurn.
//   - Cross-cutting side effects (auto-rename, option detection)
//   - Capability advertisement (UI gating via session:capabilities)
//
// Adapters know nothing about WS, the store, REST, or the DB. They speak only
// AdapterCallbacks upward and the SDK API downward. To add a new provider,
// drop a new file under agent/providers/, implement ProviderAdapter, and
// register it in the constructor.

const AGENT_DEFAULT_NAMES = new Set([
  'Claude Code',
  'Codex',
  'Gemini CLI',
  'Amp',
  'Aider',
  'Goose',
]);

function titleFromFirstPrompt(prompt: string, maxLen = 60): string {
  const firstLine = prompt.split('\n', 1)[0] ?? prompt;
  const cleaned = firstLine.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1).trimEnd() + '…';
}

// A turn ended by the manager's escape hatch instead of the adapter settling
// its own runTurn promise. Thrown through sendTurn's Promise.race so the
// try/catch/finally there — the ONLY code path that flips state back to
// stopped and emits turn-complete/idle — is guaranteed to run even when an
// adapter is wedged.
class TurnForceSettledError extends Error {
  constructor(readonly reason: 'stop-grace' | 'reset') {
    super(`turn force-settled (${reason})`);
    this.name = 'TurnForceSettledError';
  }
}

// How long Stop waits for the adapter to unwind runTurn on its own (the
// normal, graceful path) before force-settling the turn's bookkeeping.
const ABORT_GRACE_MS = 12_000;

type RegisterInput = Omit<
  AgentSession,
  | 'state'
  | 'currentTurn'
  | 'startedAt'
  | 'provider'
  | 'model'
  | 'mode'
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
  | 'currentToolStartedAt'
  | 'activeSubagents'
  | 'lastActivity'
  | 'usageLimits'
  | 'lastDetectedOptions'
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
      | 'mode'
      | 'thinkingEffort'
      | 'agentSessionId'
      | 'agentSessionIdHistory'
      | 'claudeSessionId'
      | 'claudeSessionIdHistory'
    >
  >;

export class AgentSessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>();
  private adapters: Record<string, ProviderAdapter>;
  private permManager: PermissionManager;
  private elicitManager: ElicitationManager;
  // Out-of-band usage-limits refresh is EVENT-DRIVEN (on turn-complete + session
  // open), not polled — limits only move when work happens. Usage limits are
  // account-wide, so we fetch ONCE per provider (via a representative session)
  // and fan the snapshot to all that provider's sessions. This set guards
  // against overlapping in-flight fetches for the same provider (rapid turns).
  // See docs/reference/USAGE_LIMITS.md.
  private usageFetchInFlight = new Set<string>();

  constructor(permManager: PermissionManager, elicitManager: ElicitationManager) {
    super();
    this.permManager = permManager;
    this.elicitManager = elicitManager;
    this.adapters = {
      claude: new ClaudeAdapter(permManager, elicitManager),
      codex: new CodexAdapter(),
      hermes: new HermesAdapter(permManager),
      grok: new GrokAdapter(permManager),
      cursor: new CursorAdapter(),
      copilot: new CopilotAdapter(permManager, elicitManager),
    };

    // Authoritative plan→execute mode flip. When the user approves an
    // ExitPlanMode prompt (and picks auto-accept vs manual), the permission
    // manager emits this so we persist the session mode out of `plan` and
    // broadcast the badge change. Provider-agnostic (Claude + Grok both raise
    // ExitPlanMode prompts) and channel-agnostic (web + Telegram). setMode
    // validates the target against the adapter's capabilities.modes.
    this.permManager.on(
      'permission:exit-plan-approved',
      ({ sessionId, mode }: { sessionId: string; mode: string }) => {
        try {
          // The target may be a wrong-provider value (Telegram approvals fall
          // back to Claude's 'default', which e.g. Copilot doesn't declare).
          // Coerce to the adapter's first non-plan mode instead of throwing.
          const s = this.sessions.get(sessionId);
          const modes = s ? (this.adapters[s.provider]?.capabilities.modes ?? []) : [];
          const valid = modes.some((m) => m.value === mode);
          const fallback = modes.find((m) => m.value !== 'plan')?.value ?? mode;
          this.setMode(sessionId, valid ? mode : fallback);
        } catch (err) {
          console.error('[agent] exit-plan mode flip failed:', err);
        }
      },
    );
  }

  /**
   * Warm every adapter that implements `warmup()`. Called from the daemon
   * entrypoint after `server.listen` so cold-start costs (codex app-server
   * spawn + handshake) are paid in the background before any session uses
   * them. Errors per adapter are isolated.
   */
  async warmupAll(): Promise<void> {
    await Promise.all(
      Object.entries(this.adapters).map(async ([name, adapter]) => {
        if (!adapter.warmup) return;
        try {
          await adapter.warmup();
        } catch (err) {
          console.error(`[agent] warmup failed for ${name}`, err);
        }
      }),
    );
  }

  /** Register a session in memory. Pure bookkeeping. */
  register(input: RegisterInput): AgentSession {
    const existing = this.sessions.get(input.id);
    if (existing) return existing;
    const provider = input.provider ?? 'claude';
    // Mode resolution: the input may carry a legacy or wrong-provider value
    // (e.g. the DB schema default `'default'` on a freshly-created Codex
    // session). Validate against the adapter's native list and fall back to
    // the adapter's first declared mode if the value isn't honest. We also
    // persist the corrected value so the row converges on something the
    // adapter will accept.
    const adapter = this.adapters[provider];
    const validModes = adapter?.capabilities.modes.map((m) => m.value) ?? [];
    const adapterDefault = adapter?.capabilities.modes[0]?.value ?? 'default';
    const requested = input.mode;
    const resolvedMode =
      requested && validModes.includes(requested) ? requested : adapterDefault;
    if (requested && requested !== resolvedMode) {
      // Coerce the persisted value so the next boot doesn't repeat this dance.
      try {
        updateSession(input.id, { mode: resolvedMode });
      } catch (err) {
        console.error('[agent] failed to coerce stale mode on register:', err);
      }
    }
    const session: AgentSession = {
      id: input.id,
      projectId: input.projectId,
      name: input.name,
      workingDir: input.workingDir,
      provider,
      model: input.model ?? null,
      mode: resolvedMode,
      thinkingEffort: input.thinkingEffort ?? null,
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
      currentToolStartedAt: null,
      activeSubagents: 0,
      lastActivity: 0,
      usageLimits: null,
      lastDetectedOptions: null,
      userMessages: [],
      messages: [],
      streamingText: '',
      streamingBlockIndex: null,
    };
    this.sessions.set(session.id, session);
    // Codex hydration from on-disk JSONL — codex CLI is the source of truth.
    if (session.provider === 'codex') {
      // Recovery path: codex sessions created during the brief window where
      // the new app-server adapter wasn't persisting `agentSessionId` ended
      // up with null thread ids in the DB. The conversation IS still on disk
      // (codex app-server writes rollouts regardless), but we need a way to
      // locate the right rollout file. If a single rollout matches the
      // session's cwd + multitable's originator and isn't already claimed
      // by another session row, adopt it now and persist for next boot.
      if (!session.agentSessionId && session.workingDir) {
        const adopted = this.tryAdoptOrphanedCodexRollout(session);
        if (adopted) {
          session.agentSessionId = adopted;
          session.agentSessionIdHistory = [];
          session.claudeSessionId = adopted;
          session.claudeSessionIdHistory = [];
          try {
            updateSession(session.id, {
              agentSessionId: adopted,
              agentSessionIdHistory: [],
              claudeSessionId: adopted,
              claudeSessionIdHistory: [],
            });
          } catch (err) {
            console.error('[agent] failed to persist adopted codex thread:', err);
          }
        }
      }
      if (session.agentSessionId) {
        try {
          const hydrated = parseCodexThread(session.agentSessionId);
          if (hydrated.length > 0) session.messages = hydrated;
        } catch (err) {
          console.error('[agent] codex hydration failed for', session.id, err);
        }
      }
    }
    // Hermes hydration from on-disk session JSON — Hermes' ACP server is the
    // source of truth (~/.hermes/sessions/session_<id>.json).
    if (session.provider === 'hermes' && session.agentSessionId) {
      try {
        const hydrated = parseHermesSession(session.agentSessionId);
        if (hydrated.length > 0) session.messages = hydrated;
      } catch (err) {
        console.error('[agent] hermes hydration failed for', session.id, err);
      }
    }
    // Grok hydration from on-disk session updates log — Grok Build's ACP child
    // is the source of truth (~/.grok/sessions/<enc-cwd>/<id>/updates.jsonl).
    if (session.provider === 'grok' && session.agentSessionId) {
      try {
        const hydrated = parseGrokSession(session.agentSessionId, session.workingDir);
        if (hydrated.length > 0) session.messages = hydrated;
      } catch (err) {
        console.error('[agent] grok hydration failed for', session.id, err);
      }
    }
    // Cursor hydration from on-disk transcript — the Cursor CLI is the source
    // of truth (~/.cursor/projects/<enc-cwd>/agent-transcripts/<id>/<id>.jsonl).
    if (session.provider === 'cursor' && session.agentSessionId) {
      try {
        const hydrated = parseCursorSession(session.agentSessionId, session.workingDir);
        if (hydrated.length > 0) session.messages = hydrated;
      } catch (err) {
        console.error('[agent] cursor hydration failed for', session.id, err);
      }
    }
    // Copilot hydration from the on-disk event log — the Copilot CLI runtime is
    // the source of truth (~/.copilot/session-state/<id>/events.jsonl).
    if (session.provider === 'copilot' && session.agentSessionId) {
      try {
        const hydrated = parseCopilotSession(session.agentSessionId);
        if (hydrated.length > 0) session.messages = hydrated;
      } catch (err) {
        console.error('[agent] copilot hydration failed for', session.id, err);
      }
    }
    return session;
  }

  /**
   * Find a rollout file for a codex session whose `agentSessionId` is null.
   * Returns the threadId to adopt, or null if there's no unambiguous match.
   * Conservative: only adopts when exactly ONE rollout matches the session's
   * cwd + multitable's originator and isn't already claimed by another
   * session row in this manager (claim = same threadId in agentSessionId).
   */
  private tryAdoptOrphanedCodexRollout(session: AgentSession): string | null {
    try {
      const candidates = listCodexThreads({ cwd: session.workingDir }).filter(
        (h) => h.originator === 'multitable-daemon',
      );
      if (candidates.length === 0) return null;
      const claimed = new Set<string>();
      for (const other of this.sessions.values()) {
        if (other.id === session.id) continue;
        if (other.agentSessionId) claimed.add(other.agentSessionId);
        for (const id of other.agentSessionIdHistory) claimed.add(id);
      }
      const unclaimed = candidates.filter((h) => !claimed.has(h.threadId));
      // Single-match rule: if there's exactly one unclaimed rollout for this
      // cwd, take it. If multiple, we can't disambiguate safely — skip.
      if (unclaimed.length !== 1) return null;
      console.info('[agent] adopting orphaned codex rollout', {
        sessionId: session.id,
        threadId: unclaimed[0].threadId,
      });
      return unclaimed[0].threadId;
    } catch (err) {
      console.error('[agent] orphan-rollout adoption failed:', err);
      return null;
    }
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  getAll(): AgentSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Get the capability bag for the adapter handling the given session.
   * Used by the API/sessions response so the web UI knows what to render.
   */
  getCapabilities(sessionId: string): ProviderCapabilities | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return this.adapters[s.provider]?.capabilities ?? null;
  }

  /**
   * Get the capability bag for a provider by name, without needing a session
   * to exist yet. Used by the AddAgentModal so the creation-time mode picker
   * can render the right options and gate creation-bound providers.
   */
  getProviderCapabilities(provider: string): ProviderCapabilities | null {
    return this.adapters[provider]?.capabilities ?? null;
  }

  /**
   * Update the operating mode for a session. The change takes effect on the
   * next turn (modes drive provider option assembly inside runTurn). Emits
   * `mode-changed` so the UI can refresh the badge.
   */
  setMode(sessionId: string, mode: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.mode === mode) return;
    const adapter = this.adapters[s.provider];
    if (adapter && !adapter.capabilities.modes.some((o) => o.value === mode)) {
      const supported = adapter.capabilities.modes.map((o) => o.value).join(', ');
      throw new Error(
        `Provider ${s.provider} does not support mode '${mode}'. Supported: ${supported}`,
      );
    }
    // Providers whose mode is creation-bound (Grok: session/load rehydrates the
    // agent the session was created with) reject post-creation flips. The UI's
    // ModeBadge renders these as read-only, but the API still validates so a
    // raw curl can't bypass.
    if (adapter && adapter.capabilities.modeSwitchScope === 'creation') {
      throw new Error(
        `Provider ${s.provider} mode is set at session creation and cannot be changed afterward.`,
      );
    }
    s.mode = mode;
    // Will we flip the mode on a live, in-flight turn below? (Claude via
    // streaming-input Query.setPermissionMode.) Accepting a plan flips
    // plan→acceptEdits mid-turn and hits exactly this path.
    const willFlipLive = Boolean(
      s.state === 'running' && s.currentTurn && adapter?.applyModeChangeLive,
    );
    // Some adapters cache provider state that's tied to mode (Codex caches a
    // Thread with a fixed sandboxMode; Copilot will likely cache a Session
    // with fixed system prompt). Reset the adapter cache so the NEXT turn
    // picks up the new mode. BUT NOT when we're about to flip a live turn:
    // ClaudeAdapter.reset() is the /clear teardown — it aborts the session
    // AbortController and closes the prompt queue, which kills the in-flight
    // turn with "Claude session ended". When idle, reset→rebuild is correct.
    if (!willFlipLive) {
      try {
        adapter?.reset?.(s);
      } catch (err) {
        console.error('[agent] adapter.reset on mode change failed:', err);
      }
    }
    try {
      updateSession(sessionId, { mode });
    } catch (err) {
      console.error('[agent] failed to persist mode:', err);
    }
    this.emit('mode-changed', { sessionId, mode });

    // If a turn is currently in flight and the adapter supports live mid-turn
    // mode flips, apply the change to the running SDK so the user doesn't have
    // to wait for the next turn. Fire-and-forget — `s.mode` is already updated,
    // so the next turn picks up the new mode regardless of whether this lands.
    if (willFlipLive) {
      adapter!.applyModeChangeLive!(s, mode).catch((err) => {
        console.error('[agent] live mode change failed:', err);
      });
    }
  }

  /**
   * Update the reasoning-effort level for a session. The change takes effect on
   * the next turn — Claude adapters read s.thinkingEffort when assembling
   * query() options; Codex passes it on turn/start. Future providers may
   * the field (capability flag advertises 'unsupported'; UI disables the
   * badge). Emits `thinking-effort-changed` so the UI refreshes the badge.
   */
  setThinkingEffort(sessionId: string, effort: ThinkingEffort): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.thinkingEffort === effort) return;
    s.thinkingEffort = effort;
    try {
      updateSession(sessionId, { thinkingEffort: effort });
    } catch (err) {
      console.error('[agent] failed to persist thinking effort:', err);
    }
    this.emit('thinking-effort-changed', { sessionId, thinkingEffort: effort });
  }

  /**
   * Mint a provider-side session id without running a turn. Called by the
   * session-creation route right after register() so the on-disk transcript
   * file exists and the chat is "live" the moment the user clicks Start.
   *
   * Fire-and-forget from the caller's perspective — errors are logged, never
   * thrown. The new id arrives at the UI via the existing `session-updated`
   * WS event when onSessionIdAssigned fires.
   */
  async provisionSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    // One-shot usage-limits refresh on session open so the badge isn't blank
    // until the first turn (event-driven, not a poll). Fires for every provider.
    void this.refreshUsageLimits(s.provider);
    if (s.agentSessionId) return;
    const adapter = this.adapters[s.provider];
    if (!adapter?.provisionSession) return;

    // Reuse the standard callback bag so onSessionIdAssigned takes the same
    // DB-persist + WS-broadcast path as a real turn. Other callbacks should
    // never fire during provisioning — wrap them in a Proxy that warns if an
    // adapter accidentally pushes messages / usage / a turn-result here.
    const baseCb = this.makeAdapterCallbacks(sessionId);
    const allowed = new Set(['onSessionIdAssigned']);
    const cb: AdapterCallbacks = new Proxy(baseCb, {
      get: (target, prop, receiver) => {
        const fn = Reflect.get(target, prop, receiver);
        if (typeof fn !== 'function') return fn;
        if (allowed.has(String(prop))) return fn;
        return (...args: unknown[]) => {
          console.warn(
            `[agent] adapter.provisionSession called ${String(prop)}() — ignored`,
            { sessionId, provider: s.provider },
          );
          // Defensive: do not invoke the real callback. The contract is that
          // provisioning stays side-effect-free aside from id assignment.
          void args;
          return undefined as unknown;
        };
      },
    });

    const ctrl = new AbortController();
    try {
      await adapter.provisionSession(s, ctrl, cb);
    } catch (err) {
      console.error('[agent] provisionSession failed', {
        sessionId,
        provider: s.provider,
        error: err instanceof Error ? err.stack ?? err.message : String(err),
      });
    }
  }

  /**
   * Drive one user turn through the configured adapter. Serialized per session.
   */
  async sendTurn({ sessionId, text }: SendTurnInput): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);

    const adapter = this.adapters[s.provider];
    if (!adapter) throw new Error(`no adapter registered for provider '${s.provider}'`);

    // Mid-turn injection ("send while thinking"). If a turn is already running
    // AND the adapter advertises midTurnInput AND has an enqueueMessage
    // implementation, push the new message onto the SDK's input stream so the
    // agent receives it without waiting for the current turn to complete.
    // Matches Claude Code TUI's behavior. For providers without this capability,
    // fall through to the original guard (caller falls back to client-side
    // queue).
    //
    // Order matters: do the SDK call FIRST, then emit the optimistic
    // user-message only on success. Emitting first then rolling back on a
    // throw would leave a phantom user message in the UI (the WS event has
    // already been broadcast and the web store doesn't observe rollbacks).
    if (s.currentTurn) {
      if (adapter.capabilities.midTurnInput && adapter.enqueueMessage) {
        const ok = await adapter.enqueueMessage(s, text);
        if (!ok) throw new Error('adapter rejected mid-turn enqueue');
        const injectedAt = Date.now();
        const injectedId = `inject-${injectedAt}-${Math.random().toString(36).slice(2, 8)}`;
        s.userMessages.push(text);
        s.lastActivity = injectedAt;
        const userMsg: import('../transcripts/parser.js').Message = {
          id: injectedId,
          ts: injectedAt,
          kind: 'user',
          text,
        };
        s.messages.push(userMsg);
        this.emit('user-message', { sessionId, messages: [userMsg] });
        return;
      }
      throw new Error('turn already in flight');
    }

    const ctrl = new AbortController();
    const turnStartedAt = Date.now();
    const userMessageId = `turn-${turnStartedAt}-${Math.random().toString(36).slice(2, 8)}`;
    // Manager-owned escape hatch. adapter.runTurn below is raced against this
    // deferred so a wedged adapter (dead child, missed provider end-signal)
    // can never pin the session on "running" — abortTurn's grace timer and
    // resetSession reject it, which lands in the same catch/finally as a
    // normal adapter failure.
    let forceSettleReject: (err: TurnForceSettledError) => void = () => {};
    const forcePromise = new Promise<never>((_, reject) => {
      forceSettleReject = reject;
    });
    // The race below is this promise's real consumer; this no-op branch just
    // guards against an unhandled rejection if runTurn throws synchronously.
    forcePromise.catch(() => {});
    s.currentTurn = {
      abortController: ctrl,
      startedAt: turnStartedAt,
      promptPreview: text.slice(0, 80),
      userMessageId,
      forceSettle: (reason) => forceSettleReject(new TurnForceSettledError(reason)),
      graceTimer: null,
    };
    const turn = s.currentTurn;
    s.state = 'running';
    s.lastActivity = Date.now();
    s.userMessages.push(text);
    // A new turn supersedes any options detected from the previous one.
    s.lastDetectedOptions = null;
    if (!s.startedAt) s.startedAt = new Date();

    try {
      updateSession(sessionId, { lastActiveAt: s.lastActivity });
    } catch {
      /* don't let a DB hiccup block the turn */
    }

    this.emit('state-changed', { sessionId, state: 'running' as ProcessState });

    // Always surface the submitted prompt immediately. Adapters dedup their
    // own SDK echoes against this optimistic id.
    const userMsg: import('../transcripts/parser.js').Message = {
      id: userMessageId,
      ts: turnStartedAt,
      kind: 'user',
      text,
    };
    s.messages.push(userMsg);
    this.emit('user-message', { sessionId, messages: [userMsg] });

    // Two-phase watchdog. WARN-ONLY in both phases — it never terminates a
    // turn. The whole point: never throw away live agent work the user can't
    // recover. The user can always click Stop themselves (and Stop is
    // guaranteed to land via the force-settle grace timer in abortTurn, even
    // when the adapter is wedged).
    //
    //   Phase 1 — HANDSHAKE (before any SDK message has arrived):
    //     If the daemon sees zero bytes from the SDK/RPC after HANDSHAKE_MS,
    //     surface an auth/network/CA diagnostic warning — a bad
    //     ANTHROPIC_API_KEY, missing NODE_EXTRA_CA_CERTS, dead DNS,
    //     unreachable codex app-server, etc. all manifest as "iterator opens
    //     and silently never yields." Without the warning the session pins on
    //     "Running…" with no signal that creds are wrong.
    //
    //   Phase 2 — STEADY STATE (after the first SDK message):
    //     The connection works. A long extended-thinking turn, a subagent
    //     thinking after its last tool returned, or a Hermes terminal tool
    //     that emits nothing mid-stream are all legitimate work, and
    //     indistinguishable from a hang at any timer boundary we pick. We
    //     emit a single soft warning alert once the quiet window stretches
    //     past WARN_MS, so the user knows the watchdog noticed — and can
    //     choose to Stop.
    //
    // Re-arm conditions skip the kill even in phase 1: permission/elicitation
    // pending (legitimately waiting on the human) and currentTool in flight
    // (a long-running tool started recently — TOOL_GRACE_MS ceiling). Note
    // tool re-arm only protects the parent's currentTool; a subagent's tool
    // calls fire PreToolUse/PostToolUse on the parent too, so by the time a
    // subagent goes quiet mid-think, currentTool is already null. That's
    // exactly why phase 2 is warn-only.
    const HANDSHAKE_MS = 180_000;
    const WARN_MS = 90_000;
    const TOOL_GRACE_MS = 10 * 60_000;
    let stuckTimer: TrackedTimer | null = null;
    let sawAnyMessage = false;
    let warnedThisQuietStretch = false;
    const armStuckTimer = () => {
      if (stuckTimer) stuckTimer.cancel();
      const handshake = !sawAnyMessage;
      const ms = handshake ? HANDSHAKE_MS : WARN_MS;
      stuckTimer = trackedTimeout(
        () => {
          // Re-arm while the agent is legitimately blocked on the human or
          // on a tool the parent knows is running.
          const toolInFlight =
            s.currentTool != null &&
            s.currentToolStartedAt != null &&
            Date.now() - s.currentToolStartedAt < TOOL_GRACE_MS;
          if (
            this.permManager.hasPending(sessionId) ||
            this.elicitManager.hasPending(sessionId) ||
            toolInFlight
          ) {
            armStuckTimer();
            return;
          }
          // Warn-only — the watchdog NEVER force-terminates a turn. Even a
          // silent handshake (likely an auth/network/CA problem) just surfaces
          // a diagnostic warning; the user clicks Stop if they want to cancel.
          // We never throw away live agent work on a timer.
          if (!warnedThisQuietStretch) {
            warnedThisQuietStretch = true;
            this.emitAlert({
              sessionId,
              category: 'turn',
              severity: 'warning',
              title: handshake
                ? `No response from ${s.provider} in ${HANDSHAKE_MS / 1000}s`
                : `${s.provider} quiet for ${WARN_MS / 1000}s`,
              body: handshake
                ? 'No bytes received yet — check NODE_EXTRA_CA_CERTS, credentials, or network. Click Stop to cancel.'
                : 'Still waiting — the agent may be thinking, in a subagent, or stuck. Click Stop to cancel.',
            });
          }
          armStuckTimer();
        },
        {
          label: handshake ? 'turn handshake watchdog' : 'turn quiet warning',
          ms,
          category: 'watchdog',
          detail: `session ${sessionId.slice(0, 8)}`,
          logFire: true,
        },
      );
    };

    // Wrap adapter callbacks to also bump activity / re-arm the stuck timer
    // on every emit, so the watchdog tracks "real" SDK progress. Each SDK
    // message both clears `warnedThisQuietStretch` (so the next quiet stretch
    // can warn again) and re-arms the timer (so a warning fires only after
    // WARN_MS of true silence, not on first byte after a long quiet).
    //
    // Once the turn's bookkeeping has settled (`turnSettled`, set first thing
    // in the finally — including after a force-settle), the wrapper turns
    // sticky-terminal: late emissions must not restart the UI's live
    // indicators or re-arm the (already cancelled) watchdog. Only NON-CLEARING
    // preview payloads are dropped; canonical messages, rekeys, reconciles and
    // usage keep flowing — Codex legitimately reconciles from disk ~250ms
    // after runTurn returns and blanket-dropping would break it.
    let turnSettled = false;
    const baseCb = this.makeAdapterCallbacks(sessionId);
    const cb: AdapterCallbacks = new Proxy(baseCb, {
      get: (target, prop, receiver) => {
        const fn = Reflect.get(target, prop, receiver);
        if (typeof fn !== 'function') return fn;
        return (...args: unknown[]) => {
          if (turnSettled) {
            const restartsSpinner =
              (prop === 'emitAssistantDelta' && Boolean(args[0])) ||
              (prop === 'emitReasoningDelta' && Boolean(args[0])) ||
              (prop === 'emitToolDelta' && args[0] != null) ||
              (prop === 'setCurrentTool' && args[0] != null);
            if (restartsSpinner) return undefined;
            return (fn as (...a: unknown[]) => unknown).apply(target, args);
          }
          sawAnyMessage = true;
          warnedThisQuietStretch = false;
          armStuckTimer();
          return (fn as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });

    armStuckTimer();
    try {
      // Race the adapter against the manager's force-settle deferred. The
      // race keeps a handler attached to the real runTurn promise, so a
      // late settlement after a force-settle is observed (and ignored), not
      // an unhandled rejection.
      await Promise.race([adapter.runTurn(s, text, ctrl, cb), forcePromise]);
    } catch (err: unknown) {
      const baseMessage = err instanceof Error ? err.message : String(err);

      // Two termination causes — different UX:
      //   1. User-initiated abort (clicked Stop) — NOT an error. Soft cancel.
      //   2. SDK/network/auth/etc. — IS an error.
      // The watchdog never aborts (warn-only), so a set abort signal always
      // means the user clicked Stop.
      const isUserAbort = ctrl.signal.aborted;
      // Force-settled turns (Stop grace-timeout, /reset) arrive here with the
      // signal already aborted, so they ride the soft-cancel branch below.
      const forcedReason = err instanceof TurnForceSettledError ? err.reason : null;

      // Adapter-specific recovery: only on real errors. A user cancel doesn't
      // need a thread reset (codex thread is still resumable for the next turn).
      if (!isUserAbort) adapter.reset?.(s);

      if (isUserAbort) {
        // Soft cancel — push a small system note so the chat shows what
        // happened, transition back to stopped (NOT errored), and skip the
        // error alert. The session:idle event with outcome='aborted' (fired
        // in the finally block) is the canonical signal for the UI.
        // Exception: a /reset force-settle wipes the conversation in the same
        // tick — don't push a "Turn cancelled." note into the fresh session.
        if (forcedReason !== 'reset') {
          const cancelMsg: import('../transcripts/parser.js').Message = {
            id: `turn-cancelled:${sessionId}:${turnStartedAt}`,
            ts: Date.now(),
            kind: 'system',
            text: 'Turn cancelled.',
          };
          s.messages.push(cancelMsg);
          this.emit('tool-event', { sessionId, messages: [cancelMsg] });
        }
        s.state = 'stopped';
        this.emit('state-changed', { sessionId, state: 'stopped' as ProcessState });
        // No alert — the user *initiated* the cancel; toasting them about it
        // would be noise. The composer can react to session:idle if needed.
      } else {
        // Real error path — SDK/network/auth/etc. Surface the underlying error
        // verbatim so the user always sees what actually went wrong.
        const message = baseMessage;

        console.error(`[agent] ${s.provider} turn failed`, {
          sessionId,
          agentSessionId: s.agentSessionId,
          error: err instanceof Error ? err.stack ?? err.message : String(err),
        });

        const errorId =
          s.provider === 'codex'
            ? `codex:${s.agentSessionId ?? 'pending'}:turn-error:${turnStartedAt}`
            : `turn-error:${sessionId}:${turnStartedAt}`;
        const errorMsg: import('../transcripts/parser.js').Message = {
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
      }
    } finally {
      // Flip the cb proxy to sticky-terminal FIRST — anything a late-settling
      // adapter emits from here on must not restart spinners or re-arm the
      // watchdog (see the proxy above).
      turnSettled = true;
      // Cast: TS narrows `stuckTimer` to `null` here because all reassignments
      // happen inside closures (armStuckTimer + the proxy handler). The actual
      // runtime value is TrackedTimer | null.
      (stuckTimer as TrackedTimer | null)?.cancel();
      turn.graceTimer?.cancel();
      if (s.currentTurn === turn) s.currentTurn = null;
      // Belt-and-braces: clear any lingering streaming preview the adapter
      // might have left around (success path normally clears it itself).
      if (s.streamingText !== '' || s.streamingBlockIndex !== null) {
        s.streamingText = '';
        s.streamingBlockIndex = null;
        this.emit('assistant-delta', { sessionId, text: '' });
      }
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
      // Refresh usage limits the moment a turn ends — this is when they change.
      // Account-wide fetch, fanned to all the provider's sessions. Event-driven,
      // not polled. See docs/reference/USAGE_LIMITS.md.
      void this.refreshUsageLimits(s.provider);
      // session:idle — the universal "agent loop is done, ready for the next
      // user turn" signal. Distinct from turn-complete in that it ALSO fires
      // after errors and aborts (turn-complete fires for every termination
      // including errored, but consumers like the chat composer want a
      // dedicated "you can type again" signal).
      this.emit('idle', {
        sessionId,
        state: s.state,
        // Inform the UI whether the loop ended cleanly, with an error, or via
        // user abort, so it can render the right re-engage prompt.
        outcome: ctrl.signal.aborted
          ? 'aborted'
          : s.state === 'errored'
            ? 'error'
            : 'completed',
      });
      // Stop work fire-and-forget (option detection from JSONL) for Claude.
      if (s.provider === 'claude' && s.claudeSessionId) {
        void this.runStopWork(sessionId);
      }
    }
  }

  /** Build the AdapterCallbacks bag for a session id. */
  private makeAdapterCallbacks(sessionId: string): AdapterCallbacks {
    return {
      emitAssistantMessage: (messages) =>
        this.emit('assistant-message', { sessionId, messages }),
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
      applyUsageLimits: (snapshot) => this.setSessionUsageLimits(sessionId, snapshot),
      emitTurnResult: (input) => this.emit('turn-result', { sessionId, ...input }),
      setCurrentTool: (name) => {
        const s = this.sessions.get(sessionId);
        if (!s) return;
        // Stamp the start time on a transition INTO a tool (or to a different
        // tool); clear it when the tool finishes. The watchdog uses this to
        // grant an in-flight tool a longer quiet window than a silent SDK.
        if (name) {
          if (s.currentTool !== name) s.currentToolStartedAt = Date.now();
        } else {
          s.currentToolStartedAt = null;
        }
        s.currentTool = name;
      },
      bumpActivity: () => {
        const s = this.sessions.get(sessionId);
        if (s) s.lastActivity = Date.now();
      },
      maybeRenameFromFirstPrompt: (prompt) =>
        this.maybeRenameFromFirstPrompt(sessionId, prompt),
      emitReconciled: (addedMessageIds) =>
        this.emit('reconciled', { sessionId, addedMessageIds }),
      emitTaskEvent: (subtype, payload) =>
        this.emit('task-event', { sessionId, subtype, payload }),
      emitToolDelta: (payload) => this.emit('tool-delta', { sessionId, payload }),
      emitReasoningDelta: (text) => this.emit('reasoning-delta', { sessionId, text }),
      emitMessageRekey: (oldId, newId) =>
        this.emit('message-rekeyed', { sessionId, oldId, newId }),
      emitAlert: (input) =>
        this.emitAlert({
          sessionId,
          category: input.category,
          severity: input.severity,
          title: input.title,
          body: input.body,
          needsAttention: input.needsAttention,
          persistent: input.persistent,
          ttlMs: input.ttlMs,
          metadata: input.metadata,
        }),
      incrementToolCount: () => {
        const s = this.sessions.get(sessionId);
        if (s) s.toolCount += 1;
      },
      incrementSubagents: (delta) => {
        const s = this.sessions.get(sessionId);
        if (s) s.activeSubagents = Math.max(0, s.activeSubagents + delta);
      },
      emitNotification: (payload) => this.emit('notification', { sessionId, payload }),
      emitSessionEnded: () => this.emit('session-ended', { sessionId }),
    };
  }

  /**
   * Abort an in-flight turn. The adapter's runTurn loop unwinds and the
   * `finally` block in sendTurn handles state cleanup + turn-complete + idle.
   *
   * Belt-and-braces: a healthy adapter settles runTurn within moments of the
   * abort, but a wedged one (dead child, missed provider end-signal) never
   * will — so Stop also arms a one-shot grace timer that force-settles the
   * turn's bookkeeping and drops the adapter's cached child/session. Stop
   * ALWAYS lands; the user is never left with a spinner they can't clear.
   */
  abortTurn(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const turn = s.currentTurn;
    if (!turn) return;
    try {
      turn.abortController.abort();
    } catch (err) {
      console.error('[agent] abortTurn failed:', err);
    }
    if (turn.graceTimer) return; // second Stop while already counting down
    turn.graceTimer = trackedTimeout(
      () => {
        const current = this.sessions.get(sessionId);
        // Settled on its own (the normal path) or the session is gone.
        if (!current || current.currentTurn !== turn) return;
        console.warn(
          `[agent] turn did not unwind within ${ABORT_GRACE_MS / 1000}s of Stop — force-settling`,
          { sessionId, provider: current.provider },
        );
        const adapter = this.adapters[current.provider];
        try {
          // Drop the wedged child/session cache so the NEXT turn starts from
          // a clean resume instead of re-hitting the same dead transport.
          adapter?.reset?.(current);
        } catch (err) {
          console.error('[agent] force-settle adapter.reset failed:', err);
        }
        turn.forceSettle('stop-grace');
      },
      {
        label: 'stop grace force-settle',
        ms: ABORT_GRACE_MS,
        category: 'watchdog',
        detail: `session ${sessionId.slice(0, 8)}`,
        logFire: true,
      },
    );
  }

  /** Remove a session entirely. Aborts any in-flight turn, clears prompts. */
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
    if (s) {
      const adapter = this.adapters[s.provider];
      try {
        adapter?.destroy?.(s);
      } catch (err) {
        console.error('[agent] adapter.destroy failed:', err);
      }
      adapter?.reset?.(s);
    }
    this.sessions.delete(sessionId);
  }

  /** Set + broadcast a session's usage-limit snapshot. Used by both the
   * per-turn adapter callback and the out-of-band poll loop. */
  private setSessionUsageLimits(sessionId: string, snapshot: UsageLimitSnapshot): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.usageLimits = snapshot;
    this.emit('usage-limits-changed', { sessionId, snapshot });
  }

  /**
   * Refresh one provider's usage limits out-of-band, then fan the snapshot to
   * all that provider's sessions. Event-driven: called after every turn
   * completes (the moment limits actually change) and once when a session opens.
   * Fetches ONCE per provider (limits are account-wide); a per-provider in-flight
   * guard collapses overlapping calls from rapid turns. No-ops for providers
   * whose adapter doesn't implement `fetchUsageLimits`.
   */
  async refreshUsageLimits(provider: string): Promise<void> {
    const adapter = this.adapters[provider];
    if (!adapter?.fetchUsageLimits) return;
    if (this.usageFetchInFlight.has(provider)) return;
    // Any session of this provider works as the fetch context (creds are
    // machine-wide); skip if the provider has no live sessions.
    const rep = [...this.sessions.values()].find((s) => s.provider === provider);
    if (!rep) return;
    this.usageFetchInFlight.add(provider);
    try {
      const snapshot = await adapter.fetchUsageLimits(rep);
      if (!snapshot) return;
      for (const s of this.sessions.values()) {
        if (s.provider === provider) this.setSessionUsageLimits(s.id, snapshot);
      }
    } catch (err) {
      console.warn(`[agent] fetchUsageLimits failed for ${provider}:`, err);
    } finally {
      this.usageFetchInFlight.delete(provider);
    }
  }

  /**
   * One-shot refresh of every provider that has live sessions. Called once from
   * the daemon entrypoint after boot so re-opening the app shows current usage
   * without waiting for the first turn. NOT a recurring poll.
   */
  refreshAllUsageLimits(): void {
    const providers = new Set([...this.sessions.values()].map((s) => s.provider));
    for (const p of providers) void this.refreshUsageLimits(p);
  }

  /**
   * Daemon-shutdown hook. Tears down every adapter's long-lived resources
   * (e.g. the codex app-server child). Idempotent.
   */
  async shutdown(): Promise<void> {
    for (const adapter of Object.values(this.adapters)) {
      try {
        await adapter.shutdown?.();
      } catch (err) {
        console.error('[agent] adapter.shutdown failed:', err);
      }
    }
  }

  resetSession(sessionId: string): void {
    // The user asked for a wipe — don't wait out the Stop grace window. Abort
    // first (healthy adapters unwind from that alone), then force-settle so a
    // wedged turn's bookkeeping (currentTurn, state, turn-complete, idle)
    // unwinds immediately and the next send can never hit "turn already in
    // flight" on a session the user just reset.
    const wedged = this.sessions.get(sessionId)?.currentTurn ?? null;
    this.abortTurn(sessionId);
    wedged?.forceSettle('reset');
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const adapter = this.adapters[s.provider];
    adapter?.reset?.(s);
    s.agentSessionId = null;
    s.agentSessionIdHistory = [];
    s.claudeSessionId = null;
    s.claudeSessionIdHistory = [];
    s.userMessages = [];
    s.messages = [];
    s.toolCount = 0;
    s.currentTool = null;
    s.currentToolStartedAt = null;
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

  private emitAlert(input: Parameters<typeof createAlert>[0]): void {
    this.emit('alert', { alert: createAlert(input) });
  }

  // === Internal helpers ===================================================

  private snapshotStats(s: AgentSession): Record<string, unknown> {
    return {
      provider: s.provider,
      agentProvider: s.provider,
      agentSessionId: s.agentSessionId,
      claudeSessionId: s.claudeSessionId,
      mode: s.mode,
      thinkingEffort: s.thinkingEffort,
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

  private maybeRenameFromFirstPrompt(sessionId: string, prompt: string): void {
    const row = getSessionById(sessionId);
    if (!row) return;
    if (!AGENT_DEFAULT_NAMES.has(row.name)) return;
    const title = titleFromFirstPrompt(prompt);
    if (!title) return;
    try {
      const updated = updateSession(sessionId, { name: title });
      if (updated) this.emit('session-renamed', { sessionId });
    } catch (err) {
      console.error('[agent] maybeRenameFromFirstPrompt failed:', err);
    }
  }

  /** Fire-and-forget: option detection from the JSONL flushed at Stop. */
  private async runStopWork(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s || !s.claudeSessionId) return;
    try {
      const result = await detectOptions(s.workingDir, s.claudeSessionId);
      if (result) {
        s.lastDetectedOptions = { question: result.question, options: result.options };
        this.emit('options-detected', {
          sessionId,
          options: result.options,
          question: result.question,
        });
      }
    } catch {
      // best-effort — JSONL may not have flushed yet
    }
  }

  /**
   * Snapshot of every session's currently-held detected options. Served by
   * GET /api/pending-prompts so a browser refresh can recover the option
   * selector for sessions whose last turn ended on a numbered-list question.
   */
  getDetectedOptions(): Array<{ sessionId: string; question: string; options: string[] }> {
    const out: Array<{ sessionId: string; question: string; options: string[] }> = [];
    for (const s of this.sessions.values()) {
      if (s.lastDetectedOptions) {
        out.push({
          sessionId: s.id,
          question: s.lastDetectedOptions.question,
          options: s.lastDetectedOptions.options,
        });
      }
    }
    return out;
  }

  /** Drop detected options for a session (user dismissed the selector). */
  clearDetectedOptions(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.lastDetectedOptions = null;
  }
}

// Re-export AlertSeverity for downstream imports that rely on it through
// manager.ts (kept for backwards compatibility with existing imports).
export type { AlertSeverity };
