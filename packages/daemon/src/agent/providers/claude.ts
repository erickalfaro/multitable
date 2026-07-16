import { createRequire } from 'node:module';
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  OnElicitation,
  PermissionMode,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentSession, UsageLimitWindow, UsageLimitSnapshot } from '../types.js';
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
  ModeOption,
  ProviderAdapter,
  ProviderCapabilities,
} from './types.js';

// === Disable cache-diagnostics feature flag ================================
//
// The bundled `claude` CLI ships an internal experimental "prompt cache
// diagnostics" feature, gated by a GrowthBook A/B flag (default OFF, but
// some accounts/sessions get rolled in). When ON, the CLI appends a
// `diagnostics.previous_message_id` field to every `/v1/messages` request,
// computed by walking the JSONL backward for the most recent
// `assistant && requestId` row and reading its `message.id` — with NO
// validation that the id starts with `msg_…`.
//
// On a JSONL with a synthetic-tailed conversation (locally-generated
// assistant placeholders persisted during a 529 retry storm, or
// harness-emitted pseudo-system notices like the oversized-image warning),
// that `message.id` is a UUID, and the API responds with a permanent 400:
//
//   "diagnostics.previous_message_id: must be the `id` from a prior
//    /v1/messages response (starts with `msg_`)"
//
// See upstream issues #58427 and #59520 (open, unfixed as of CC 2.1.167).
//
// The minimum-impact workaround is to disable the GrowthBook lookup chain
// entirely: setting `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` makes the
// CLI's flag-fetch function return the default `false`, the cache-diagnostics
// path never activates, and `previous_message_id` is never built into the
// request body — for all sessions, not just corrupted ones. The env var is
// an Anthropic-documented supported control (it also disables `/feedback`
// and GrowthBook A/B telemetry; prompt caching itself is unaffected — that's
// a separate SDK option). See docs/skills/claude-agent-sdk/pitfalls.md §10.
if (!('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' in process.env)) {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
}

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

// The user's own auto-updating `claude` install, as opposed to the pinned
// SDK-bundled binary above. Model discovery probes both so the catalog is as
// fresh as whichever binary is newer — a new model reaches the picker as soon
// as the system CLI self-updates, without waiting for an SDK dep bump.
export function resolveSystemClaudeExecutable(): string | undefined {
  // Windows installs are PATH shims (.cmd/.exe) the probe can't spawn as-is;
  // bundled-only there.
  if (process.platform === 'win32') return undefined;
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = [
    ...pathDirs.map((dir) => join(dir, 'claude')),
    // Fallbacks for daemons launched with a trimmed PATH (systemd, launchd).
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
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
const CLAUDE_NATIVE_MODES: readonly ModeOption[] = [
  {
    value: 'default' as PermissionMode,
    label: 'Ask first',
    description: 'Prompts you before any risky or destructive action.',
    tone: 'standard',
  },
  {
    value: 'acceptEdits' as PermissionMode,
    label: 'Accept edits',
    description: 'Auto-accept file edit operations.',
    tone: 'elevated',
  },
  {
    value: 'bypassPermissions' as PermissionMode,
    label: 'Bypass permissions',
    description: 'Bypass all permission checks (requires allowDangerouslySkipPermissions).',
    tone: 'danger',
  },
  {
    value: 'plan' as PermissionMode,
    label: 'Plan',
    description: 'Planning mode, no actual tool execution.',
    tone: 'safe',
  },
  {
    value: 'dontAsk' as PermissionMode,
    label: 'Don’t ask',
    description: "Don't prompt for permissions, deny if not pre-approved.",
    tone: 'danger',
  },
  {
    value: 'auto' as PermissionMode,
    label: 'Auto (classifier)',
    description: 'Use a model classifier to approve/deny permission prompts.',
    tone: 'elevated',
  },
];

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

// Window key → the label `/usage` shows, a display rank (popover order), and the
// window length. Same keys are used by BOTH the in-band rate_limit_event
// (sdk.d.ts SDKRateLimitInfo.rateLimitType) and the out-of-band
// GET /api/oauth/usage response (snake_case top-level keys). `/usage` itself
// shows session + weekly (+ per-model weekly), so we surface those.
const CLAUDE_LIMIT_META: Record<string, { label: string; rank: number; windowMins?: number }> = {
  five_hour: { label: 'Current session', rank: 0, windowMins: 300 },
  seven_day: { label: 'Current week (all models)', rank: 1, windowMins: 10080 },
  seven_day_opus: { label: 'Current week (Opus)', rank: 2, windowMins: 10080 },
  seven_day_sonnet: { label: 'Current week (Sonnet)', rank: 3, windowMins: 10080 },
  overage: { label: 'Overage', rank: 4 },
};

// The Claude Code OAuth client User-Agent expected by /api/oauth/usage. We don't
// have the CLI version, so use codexbar's documented fallback.
const CLAUDE_USAGE_UA = 'claude-code/2.1.0';

// Read the Claude Code subscription OAuth access token the same way the CLI /
// codexbar do: env override first, then ~/.claude/.credentials.json
// (`claudeAiOauth.accessToken`). Returns null if the user authenticates with an
// API key only (no subscription usage to report) or the file is absent.
function readClaudeOAuthToken(): string | null {
  const envTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof envTok === 'string' && envTok.length > 0) return envTok;
  try {
    const raw = readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8');
    const tok = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } })?.claudeAiOauth
      ?.accessToken;
    return typeof tok === 'string' && tok.length > 0 ? tok : null;
  } catch {
    return null;
  }
}

function parseIsoMs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// GET /api/oauth/usage response → normalized snapshot. Windows carry only a
// `utilization` percent + `resets_at` (no used/limit counts), exactly like
// `/usage`. `extra_usage` (overage spend) carries money in cents.
function normalizeClaudeUsage(body: unknown): UsageLimitSnapshot | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const windows: UsageLimitWindow[] = [];
  for (const [key, meta] of Object.entries(CLAUDE_LIMIT_META)) {
    const w = b[key] as { utilization?: unknown; resets_at?: unknown } | undefined;
    if (!w || typeof w !== 'object' || typeof w.utilization !== 'number') continue;
    windows.push({
      label: meta.label,
      usedPercent: Math.round(w.utilization),
      resetsAt: parseIsoMs(w.resets_at),
      windowDurationMins: meta.windowMins ?? null,
    });
  }
  let creditsRemaining: number | null = null;
  const extra = b.extra_usage as
    | { is_enabled?: unknown; utilization?: unknown; monthly_limit?: unknown; used_credits?: unknown }
    | undefined;
  if (extra && typeof extra === 'object' && extra.is_enabled === true) {
    if (typeof extra.utilization === 'number') {
      windows.push({ label: 'Extra usage', usedPercent: Math.round(extra.utilization), resetsAt: null });
    }
    if (typeof extra.monthly_limit === 'number' && typeof extra.used_credits === 'number') {
      creditsRemaining = (extra.monthly_limit - extra.used_credits) / 100; // cents → dollars
    }
  }
  if (windows.length === 0 && creditsRemaining == null) return null;
  return { status: 'live', source: 'claude', windows, creditsRemaining, capturedAt: Date.now() };
}

// Writable async queue of `SDKUserMessage`s feeding the SDK's streaming-input
// pump. The SDK internally calls `streamInput(prompt)` on whatever
// AsyncIterable we pass to `query({ prompt })`; calling `streamInput()`
// ourselves would close stdin to the CLI (see sdk.mjs — `endInput()` fires
// after the iterator returns). Instead we keep ONE long-lived iterable per
// live Claude session and push messages onto it. The SDK pulls them as it
// processes turns, in FIFO order.
class PromptQueue {
  private buffer: SDKUserMessage[] = [];
  private notify: (() => void) | null = null;
  private closed = false;

  push(text: string): void {
    if (this.closed) return;
    this.buffer.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.notify?.();
  }

  /** Close the queue. The iterator drains any remaining buffered messages then
   *  returns, signaling the SDK to wind down the input channel. */
  close(): void {
    this.closed = true;
    this.notify?.();
  }

  iter(): AsyncIterable<SDKUserMessage> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void> {
        while (true) {
          while (self.buffer.length > 0) {
            yield self.buffer.shift()!;
          }
          if (self.closed) return;
          await new Promise<void>((r) => {
            self.notify = r;
          });
          self.notify = null;
        }
      },
    };
  }
}

// Per-AgentSession live state owned by ClaudeAdapter. We hold ONE Query per
// session and reuse it across turns (matches Claude Code TUI). Each runTurn
// pushes a message onto the queue and registers a waiter for the next
// `result` event; the pump shifts waiters off the FIFO as results arrive.
interface ClaudeLiveSession {
  queue: PromptQueue;
  query: Query;
  /** Session-scoped abort. Aborting this kills the Query entirely (destroy /
   *  reset / shutdown). Per-turn aborts from the manager translate to
   *  `query.interrupt()` instead so other queued turns survive. */
  ctrl: AbortController;
  /** FIFO of resolvers awaiting the next `result` SDK message. */
  resultWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
}


export class ClaudeAdapter implements ProviderAdapter {
  readonly name = 'claude' as const;

  readonly capabilities: ProviderCapabilities = {
    costUsd: true,
    usageLimits: true, // rate_limit_info rides the SDK message stream
    planMode: 'native',
    perCallApproval: 'callback',
    userQuestion: 'tool', // AskUserQuestion built-in tool
    elicitation: true,
    subagents: 'manual',
    midTurnInput: true, // streaming-input mode keeps the Query handle alive for setPermissionMode mid-turn
    byok: false,
    hardSandbox: false,
    hooks: 'rich',
    streamingDeltaSemantics: 'additive',
    modelSwitchScope: 'per-turn',
    modeSwitchScope: 'live',
    modes: CLAUDE_NATIVE_MODES.map((m) => ({ ...m })),
    thinkingEffort: 'native',
  };

  // Per-session live state the adapter needs to track within a single turn.
  // Cleared at turn end via the reset() helper.
  private streamBuffers = new Map<string, StreamBuffer>();
  private streamingBlockIndex = new Map<string, number | null>();
  // Long-lived per-session Query state. The Query is created on the FIRST
  // runTurn for the session and survives across subsequent turns until
  // destroy / reset / shutdown. Subsequent turns push onto the queue and
  // await a `result` message via the FIFO `resultWaiters` registry.
  //
  // This shape is what unlocks Claude Code TUI behavior: a continuous
  // streaming-input channel that the SDK pumps, with mid-turn pushes landing
  // in the model's input stream while it's still mid-response. It's also
  // what enables `Query.setPermissionMode()` mid-turn — those control methods
  // are SDK-gated to streaming-input mode (sdk.d.ts:2255-2266).
  private liveSessions = new Map<string, ClaudeLiveSession>();
  // Per-session accumulator of the latest usage-limit window keyed by
  // rateLimitType. Each rate_limit_event reports ONE window; `/usage` shows all
  // of them, so we merge (latest-wins per type) and emit the union rather than
  // replacing the snapshot with a single window.
  private limitWindows = new Map<string, Map<string, UsageLimitWindow>>();

  constructor(
    private permManager: PermissionManager,
    private elicitManager: ElicitationManager,
  ) {}

  reset(s: AgentSession): void {
    // /clear: drop the live Query so the next turn starts fresh (no `resume:`
    // tied to the old claudeSessionId). The pump task's finally clause will
    // remove the entry from liveSessions; we don't need to delete it here.
    this.closeLiveSession(s.id);
    this.streamBuffers.delete(s.id);
    this.streamingBlockIndex.delete(s.id);
    // NOTE: limitWindows is deliberately NOT cleared — usage limits are
    // account-wide, not conversation-scoped, so /clear must not blank the badge.
  }

  /** Tear down per-session adapter resources entirely. Called when the user
   *  deletes the session. Closes the live Query and clears all per-session
   *  caches. The pump task drains and removes itself from liveSessions. */
  destroy(s: AgentSession): void {
    this.closeLiveSession(s.id);
    this.streamBuffers.delete(s.id);
    this.streamingBlockIndex.delete(s.id);
    this.limitWindows.delete(s.id);
  }

  /** Daemon-wide teardown: close every live Claude session. SIGTERM path. */
  async shutdown(): Promise<void> {
    for (const id of [...this.liveSessions.keys()]) {
      this.closeLiveSession(id);
    }
  }

  /** Close the live Query for a session if one exists. Aborts the session-
   *  scoped controller (signals the SDK to wind down) AND closes the prompt
   *  queue so the iterator returns. Either signal alone usually works; we do
   *  both for robustness. The pump's finally clause removes the map entry. */
  private closeLiveSession(sessionId: string): void {
    const sess = this.liveSessions.get(sessionId);
    if (!sess) return;
    sess.queue.close();
    if (!sess.ctrl.signal.aborted) sess.ctrl.abort();
  }

  /**
   * Out-of-band usage-limits fetch (called by the manager's poll loop on a
   * cadence). Replicates exactly what `/usage` shows for Claude Code
   * subscription users: GET https://api.anthropic.com/api/oauth/usage with the
   * OAuth token from ~/.claude/.credentials.json → the 5-hour session window +
   * weekly window(s). Account-wide, so the manager fans the result to all Claude
   * sessions. Returns null silently (API-key-only auth, expired/again-refreshed
   * token, network, 401/403) so the poll never spams logs. See
   * .claude/skills/claude-agent-sdk/reference/usage-limits.md.
   */
  async fetchUsageLimits(_s: AgentSession): Promise<UsageLimitSnapshot | null> {
    const token = readClaudeOAuthToken();
    if (!token) return null;
    try {
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'anthropic-beta': 'oauth-2025-04-20', // required by the OAuth usage endpoint
          'User-Agent': CLAUDE_USAGE_UA,
        },
      });
      if (!res.ok) return null; // 401 (re-auth) / 403 (scope) / 5xx — handled by next poll
      return normalizeClaudeUsage(await res.json());
    } catch {
      return null;
    }
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

    // Lazy-init the per-session live query on first turn. Subsequent runTurn
    // calls just push onto the queue and await the next `result` from the FIFO.
    let sess = this.liveSessions.get(s.id);
    if (!sess) sess = this.startLiveSession(s, cb);

    // Per-turn AbortController from the manager. We do NOT pass it to the SDK
    // (the SDK only has one abortController per query and it's session-scoped
    // — see startLiveSession). Instead, on abort we send a SDK `interrupt`
    // which signals the CLI to wrap up the current turn gracefully. The pump
    // sees the resulting `result` event and resolves the waiter. Other queued
    // turns survive.
    let waiterEntry: { resolve: () => void; reject: (err: Error) => void } | null = null;
    const waiter = new Promise<void>((resolve, reject) => {
      waiterEntry = { resolve, reject };
      sess!.resultWaiters.push(waiterEntry);
    });

    const onAbort = () => {
      // Best-effort interrupt; ignore errors (e.g., already finishing).
      sess!.query.interrupt().catch(() => {});
    };
    if (ctrl.signal.aborted) onAbort();
    else ctrl.signal.addEventListener('abort', onAbort, { once: true });

    sess.queue.push(text);

    try {
      await waiter;
    } finally {
      ctrl.signal.removeEventListener('abort', onAbort);
      // If the waiter was never satisfied (e.g., pump rejected it on error
      // before we resolved), make sure it's no longer in the FIFO so a future
      // result message doesn't accidentally resolve a stale entry.
      if (waiterEntry !== null) {
        const idx = sess.resultWaiters.indexOf(waiterEntry);
        if (idx !== -1) sess.resultWaiters.splice(idx, 1);
      }
      // Belt-and-braces: clear any lingering streaming preview the SDK left
      // behind. handleSdkMessage normally clears at message_stop, but a
      // network drop / abort can leave a partial buffer.
      const buf = this.streamBuffers.get(s.id);
      if (buf && !buf.isEmpty) {
        cb.emitAssistantDelta('');
        buf.reset();
      }
      this.streamingBlockIndex.set(s.id, null);
    }
  }

  /**
   * Open a long-lived streaming-input Query for this session. Called lazily
   * from runTurn on the first turn. The pump task in here runs for the
   * lifetime of the session, dispatching every SDK message and shifting
   * `resultWaiters` off the FIFO as `result` events arrive.
   */
  private startLiveSession(s: AgentSession, cb: AdapterCallbacks): ClaudeLiveSession {
    const pathToClaudeCodeExecutable = resolveClaudeCodeExecutable();

    // Per-session streaming-preview state. Reset by handleSdkMessage at each
    // text-block boundary; cleared on session destroy.
    this.streamBuffers.set(s.id, new StreamBuffer('additive'));
    this.streamingBlockIndex.set(s.id, null);

    const queue = new PromptQueue();
    const sessCtrl = new AbortController();
    const it = query({
      prompt: queue.iter(),
      options: {
        cwd: s.workingDir,
        ...(s.claudeSessionId ? { resume: s.claudeSessionId } : {}),
        ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
        ...(s.model ? { model: s.model } : {}),
        ...(s.thinkingEffort ? { effort: s.thinkingEffort } : {}),
        settingSources: ['project', 'user'],
        // Mode passthrough. Mid-session flips ride applyModeChangeLive via
        // Query.setPermissionMode against this same handle.
        permissionMode: s.mode as PermissionMode,
        ...(s.mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
        canUseTool: this.makeCanUseTool(s),
        onElicitation: this.makeOnElicitation(s, cb),
        hooks: this.makeHooks(s, cb),
        includePartialMessages: true,
        // Session-scoped abort. Per-turn cancels use query.interrupt() instead
        // so they don't kill the whole channel.
        abortController: sessCtrl,
      },
    });

    const sess: ClaudeLiveSession = {
      queue,
      query: it,
      ctrl: sessCtrl,
      resultWaiters: [],
    };
    this.liveSessions.set(s.id, sess);

    // Long-running pump. Dispatches every SDK message and resolves waiters in
    // FIFO order as `result` events arrive. On terminal error / abort, fails
    // all pending waiters and removes the session from the map so the next
    // runTurn rebuilds it cleanly.
    void (async () => {
      try {
        for await (const msg of it) {
          try {
            this.handleSdkMessage(s, msg, cb);
            if ((msg as { type?: string })?.type === 'result') {
              const w = sess.resultWaiters.shift();
              w?.resolve();
            }
          } catch (handlerErr) {
            console.error('[claude-adapter] handler error:', handlerErr);
            const detail =
              handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
            cb.emitAlert({
              category: 'turn',
              severity: 'warning',
              title: 'Claude SDK handler error',
              body: detail,
            });
          }
        }
        // Iterator returned cleanly (queue closed). Any remaining waiters
        // were expecting more results that won't arrive — reject them.
        const err = new Error('Claude session ended');
        for (const w of sess.resultWaiters) w.reject(err);
        sess.resultWaiters.length = 0;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        for (const w of sess.resultWaiters) w.reject(e);
        sess.resultWaiters.length = 0;
        // Surface SDK-side pump errors. The current waiter's reject already
        // bubbles up to manager.sendTurn's error path; this is for failures
        // that fire between turns (no waiter to reject).
        console.error('[claude-adapter] pump error:', err);
      } finally {
        // Drop from the map so the next runTurn rebuilds. Don't clear
        // streamBuffers here — destroy() / reset() own that cleanup.
        if (this.liveSessions.get(s.id) === sess) {
          this.liveSessions.delete(s.id);
        }
      }
    })();

    return sess;
  }

  /**
   * Apply a mode flip to the in-flight live session via the SDK's
   * Query.setPermissionMode (streaming-input-mode only). Returns false when
   * no live session exists (manager falls back to per-turn pickup, which is
   * a no-op for Claude since the next turn reuses the same Query). The session
   * field `s.mode` has already been updated by the manager, so even if this
   * fails the change persists across daemon restart.
   */
  async applyModeChangeLive(s: AgentSession, mode: string): Promise<boolean> {
    const sess = this.liveSessions.get(s.id);
    if (!sess) return false;
    await sess.query.setPermissionMode(mode as PermissionMode);
    return true;
  }

  /**
   * Inject a user message mid-turn ("send while thinking"). Pushes onto the
   * same PromptQueue the SDK is already pumping, so the message is picked up
   * naturally on the SDK's next iterator pull. The agent receives it after
   * the current turn's `result` (FIFO), or sooner if the model supports
   * mid-stream message handling.
   *
   * Returns false if no live session exists yet (caller starts a fresh turn).
   *
   * IMPORTANT: this also pushes a no-op waiter onto the FIFO so the result
   * event for this injected message lands on a real entry instead of
   * mismatching the next runTurn's waiter. The injected message's lifecycle
   * is fire-and-forget from manager.sendTurn's perspective — its turn-end
   * arrival is observed by the WS event stream, not by an awaited Promise.
   */
  async enqueueMessage(s: AgentSession, text: string): Promise<boolean> {
    const sess = this.liveSessions.get(s.id);
    if (!sess) return false;
    sess.resultWaiters.push({ resolve: () => {}, reject: () => {} });
    sess.queue.push(text);
    return true;
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
        this.handleRateLimitEvent(s, msg, cb);
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
        // Model-side failures must ALWAYS reach the user. The SDK's
        // SDKResultError carries an `errors: string[]` payload that we
        // surface as a visible system message in the chat (and as a
        // severity:error alert). Without this, an `error_during_execution`
        // result silently looked like a clean turn-end with no assistant
        // text — the user sees nothing.
        if (info.isError) {
          const errText = info.errors.length > 0 ? info.errors.join('\n') : info.subtype;
          const sysMsg: Message = {
            id: `claude-result-error:${s.id}:${Date.now()}`,
            ts: Date.now(),
            kind: 'system',
            text: `Claude turn ended in error (${info.subtype}): ${errText}`,
          };
          cb.pushMessages([sysMsg]);
          cb.emitToolEvent([sysMsg]);
        }
        this.maybeEmitResultAlert(info.subtype, info.totalCostUsd, info.errors, cb);
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

  private handleRateLimitEvent(s: AgentSession, msg: unknown, cb: AdapterCallbacks): void {
    const m = (msg ?? {}) as { rate_limit_info?: unknown };
    const info = (m.rate_limit_info ?? {}) as Record<string, unknown>;
    const status =
      info.status === 'allowed' || info.status === 'allowed_warning' || info.status === 'rejected'
        ? (info.status as 'allowed' | 'allowed_warning' | 'rejected')
        : 'allowed';
    const utilization = typeof info.utilization === 'number' ? info.utilization : null;
    const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt : null;
    // rateLimitType is the WINDOW this event describes (five_hour / seven_day /
    // …). Each event reports ONE window; `/usage` shows all of them, so we
    // accumulate latest-per-type and emit the union (not a single window).
    const limitType = typeof info.rateLimitType === 'string' ? info.rateLimitType : 'limit';
    const meta = CLAUDE_LIMIT_META[limitType];

    // Merge this window into the per-session accumulator (only when we have a
    // utilization to show — a window with no number isn't worth a row).
    if (utilization !== null) {
      let windows = this.limitWindows.get(s.id);
      if (!windows) {
        windows = new Map();
        this.limitWindows.set(s.id, windows);
      }
      windows.set(limitType, {
        label: meta?.label ?? limitType,
        usedPercent: Math.round(utilization * 100),
        resetsAt,
      });
      // Emit the union of all known windows, ordered like the TUI's /usage.
      const snapshotWindows = [...windows.entries()]
        .sort(([a], [b]) => (CLAUDE_LIMIT_META[a]?.rank ?? 99) - (CLAUDE_LIMIT_META[b]?.rank ?? 99))
        .map(([, w]) => w);
      cb.applyUsageLimits({
        status: 'live',
        source: 'claude',
        windows: snapshotWindows,
        capturedAt: Date.now(),
      });
    }

    // Alert only when near/over the limit — never on the healthy 'allowed' path.
    if (status === 'allowed') return;
    const label = meta?.label ?? limitType;
    const severity = status === 'rejected' ? 'error' : 'warning';
    const title =
      status === 'rejected'
        ? `Rate limit hit (${label})`
        : `Approaching rate limit (${label})`;
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

  private maybeEmitResultAlert(
    subtype: string,
    totalCostUsd: number,
    errors: string[],
    cb: AdapterCallbacks,
  ): void {
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
    } else if (subtype === 'error_during_execution') {
      // The SDK's catch-all internal failure (network drop after some
      // bytes, malformed stream, server-side 5xx mid-turn, tool runner
      // crash, etc.). Surface the SDK's `errors` array verbatim so the
      // user always knows what actually failed.
      cb.emitAlert({
        category: 'turn',
        severity: 'error',
        title: 'Claude turn failed mid-execution',
        body: errors.length > 0 ? errors.join('\n') : 'No further detail provided by the SDK.',
      });
    }
  }
}
