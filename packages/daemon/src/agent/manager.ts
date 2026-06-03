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
import type { PermissionManager } from '../hooks/permissionManager.js';
import type { ElicitationManager } from '../hooks/elicitationManager.js';
import { createAlert } from './alerts.js';
import { updateSession, insertCostRecord, getSessionById } from '../db/store.js';
import { detectOptions } from '../hooks/optionDetector.js';
import { CodexAdapter } from './providers/codex.js';
import { ClaudeAdapter } from './providers/claude.js';
import { HermesAdapter } from './providers/hermes.js';
import { GrokAdapter } from './providers/grok.js';
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
//   - Two-phase watchdog: hard-kill ONLY before the first SDK byte arrives
//     (handshake — surfaces auth/network failures with a real error); after
//     that, the watchdog only WARNS and never kills (long thinks / subagents
//     are legitimate work and the user can always click Stop).
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
          this.setMode(sessionId, mode);
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
    s.mode = mode;
    // Some adapters cache provider state that's tied to mode (Codex caches a
    // Thread with a fixed sandboxMode; Copilot will likely cache a Session
    // with fixed system prompt). Reset the adapter cache so the NEXT turn
    // picks up the new mode. ClaudeAdapter's reset is a no-op for this case
    // since Claude assembles options per-turn — safe to call uniformly.
    try {
      adapter?.reset?.(s);
    } catch (err) {
      console.error('[agent] adapter.reset on mode change failed:', err);
    }
    try {
      updateSession(sessionId, { mode });
    } catch (err) {
      console.error('[agent] failed to persist mode:', err);
    }
    this.emit('mode-changed', { sessionId, mode });
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
    if (s.currentTurn) throw new Error('turn already in flight');

    const adapter = this.adapters[s.provider];
    if (!adapter) throw new Error(`no adapter registered for provider '${s.provider}'`);

    const ctrl = new AbortController();
    const turnStartedAt = Date.now();
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

    // Two-phase watchdog. The whole point: never throw away live agent work
    // the user can't recover. The user can always click Stop themselves.
    //
    //   Phase 1 — HANDSHAKE (before any SDK message has arrived):
    //     If the daemon sees zero bytes from the SDK/RPC after HANDSHAKE_MS,
    //     hard-kill the turn. This is the auth/network/CA diagnostic path —
    //     a bad ANTHROPIC_API_KEY, missing NODE_EXTRA_CA_CERTS, dead DNS,
    //     unreachable codex app-server, etc. all manifest as "iterator opens
    //     and silently never yields." Without this kill the session pins on
    //     "Running…" forever and the user has no signal that creds are wrong.
    //
    //   Phase 2 — STEADY STATE (after the first SDK message):
    //     The connection works. From here on the watchdog NEVER aborts. A
    //     long extended-thinking turn, a subagent thinking after its last
    //     tool returned, or a Hermes terminal tool that emits nothing mid-
    //     stream are all legitimate work, and indistinguishable from a hang
    //     at any timer boundary we pick. Instead we emit a single soft
    //     warning alert once the quiet window stretches past WARN_MS, so
    //     the user knows the watchdog noticed — and can choose to Stop.
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
    let abortedDueToStuck = false;
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
          if (handshake) {
            // Phase 1 — hard kill so the catch block can surface the
            // "check NODE_EXTRA_CA_CERTS / credentials / network" diagnostic.
            abortedDueToStuck = true;
            try {
              ctrl.abort();
            } catch {
              /* ignore */
            }
            return;
          }
          // Phase 2 — warn once per quiet stretch and re-arm. Stays alive
          // until the SDK speaks again (which resets warnedThisQuietStretch
          // via the callback proxy below) or the user clicks Stop.
          if (!warnedThisQuietStretch) {
            warnedThisQuietStretch = true;
            this.emitAlert({
              sessionId,
              category: 'turn',
              severity: 'warning',
              title: `${s.provider} quiet for ${WARN_MS / 1000}s`,
              body: 'Still waiting — the agent may be thinking, in a subagent, or stuck. Click Stop to cancel.',
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
    const baseCb = this.makeAdapterCallbacks(sessionId);
    const cb: AdapterCallbacks = new Proxy(baseCb, {
      get: (target, prop, receiver) => {
        const fn = Reflect.get(target, prop, receiver);
        if (typeof fn !== 'function') return fn;
        return (...args: unknown[]) => {
          sawAnyMessage = true;
          warnedThisQuietStretch = false;
          armStuckTimer();
          return (fn as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });

    armStuckTimer();
    try {
      await adapter.runTurn(s, text, ctrl, cb);
      if (abortedDueToStuck) {
        // Handshake watchdog only — see HANDSHAKE_MS comment above. Phase 2
        // never aborts, so reaching here always means we saw zero bytes from
        // the SDK/RPC and want to surface the auth/network diagnostic.
        throw new Error(
          `No response from ${s.provider} in ${HANDSHAKE_MS / 1000}s. ` +
            `Check NODE_EXTRA_CA_CERTS, credentials, or network connection.`,
        );
      }
    } catch (err: unknown) {
      const baseMessage = err instanceof Error ? err.message : String(err);

      // Distinguish three termination causes — they have very different UX:
      //   1. User-initiated abort (clicked Stop) — NOT an error. Soft cancel.
      //   2. Watchdog abort (no progress for NO_PROGRESS_MS) — IS an error.
      //   3. SDK/network/auth/etc. — IS an error.
      // The signal-aborted check distinguishes (1) from (3); abortedDueToStuck
      // distinguishes (2). Watchdog ALSO aborts the controller, so check it
      // first to avoid misclassifying as user-initiated.
      const isWatchdog = abortedDueToStuck;
      const isUserAbort = !isWatchdog && ctrl.signal.aborted;

      // Adapter-specific recovery: only on real errors. A user cancel doesn't
      // need a thread reset (codex thread is still resumable for the next turn).
      if (!isUserAbort) adapter.reset?.(s);

      if (isUserAbort) {
        // Soft cancel — push a small system note so the chat shows what
        // happened, transition back to stopped (NOT errored), and skip the
        // error alert. The session:idle event with outcome='aborted' (fired
        // in the finally block) is the canonical signal for the UI.
        const cancelMsg: import('../transcripts/parser.js').Message = {
          id: `turn-cancelled:${sessionId}:${turnStartedAt}`,
          ts: Date.now(),
          kind: 'system',
          text: 'Turn cancelled.',
        };
        s.messages.push(cancelMsg);
        this.emit('tool-event', { sessionId, messages: [cancelMsg] });
        s.state = 'stopped';
        this.emit('state-changed', { sessionId, state: 'stopped' as ProcessState });
        // No alert — the user *initiated* the cancel; toasting them about it
        // would be noise. The composer can react to session:idle if needed.
      } else {
        // Real error path — handshake watchdog or SDK/network/auth/etc.
        // Watchdog throws its own self-explanatory message above; for every
        // other error path, surface the underlying error verbatim so the
        // user always sees what actually went wrong.
        const message =
          isWatchdog && !new RegExp(s.provider, 'i').test(baseMessage)
            ? `No response from ${s.provider} in ${HANDSHAKE_MS / 1000}s. ` +
              `Check NODE_EXTRA_CA_CERTS, credentials, or network. (${baseMessage})`
            : baseMessage;

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
      // Cast: TS narrows `stuckTimer` to `null` here because all reassignments
      // happen inside closures (armStuckTimer + the proxy handler). The actual
      // runtime value is TrackedTimer | null.
      (stuckTimer as TrackedTimer | null)?.cancel();
      s.currentTurn = null;
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
        outcome: abortedDueToStuck
          ? 'watchdog'
          : ctrl.signal.aborted
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
    this.abortTurn(sessionId);
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
