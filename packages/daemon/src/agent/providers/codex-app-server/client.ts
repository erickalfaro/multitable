import { CodexAppServerTransport, RpcNotification, TransportOptions } from './transport.js';
import { CODEX_CLI_VERSION } from '../codex-protocol/_codex-cli-version.js';
import type { ClientInfo } from '../codex-protocol/ClientInfo.js';
import type { InitializeCapabilities } from '../codex-protocol/InitializeCapabilities.js';
import type { InitializeResponse } from '../codex-protocol/InitializeResponse.js';
import type { ThreadStartParams } from '../codex-protocol/v2/ThreadStartParams.js';
import type { ThreadStartResponse } from '../codex-protocol/v2/ThreadStartResponse.js';
import type { ThreadResumeParams } from '../codex-protocol/v2/ThreadResumeParams.js';
import type { ThreadResumeResponse } from '../codex-protocol/v2/ThreadResumeResponse.js';
import type { TurnStartParams } from '../codex-protocol/v2/TurnStartParams.js';
import type { TurnStartResponse } from '../codex-protocol/v2/TurnStartResponse.js';
import type { TurnInterruptParams } from '../codex-protocol/v2/TurnInterruptParams.js';
import type { SandboxMode } from '../codex-protocol/v2/SandboxMode.js';
import type { AskForApproval } from '../codex-protocol/v2/AskForApproval.js';
import type { ReasoningEffort } from '../codex-protocol/ReasoningEffort.js';
import type { GetAccountRateLimitsResponse } from '../codex-protocol/v2/GetAccountRateLimitsResponse.js';

// CodexAppServerClient — singleton wrapper over a long-lived `codex app-server`
// child. One per daemon. Lazy-spawned on first use so daemons that never use
// Codex don't pay the startup cost.
//
// Per-thread notification fan-out: each thread registers a listener via
// `subscribe(threadId, listener)`. The dispatcher reads `params.threadId` off
// every notification and routes to the matching listener; non-thread-scoped
// notifications (account/*, app/list/*, configWarning, etc.) are dropped with
// a debug log.
//
// ServerRequests (approval prompts and the like) are auto-denied. We send
// `approvalPolicy: "never"` on every thread create/resume so these requests
// SHOULDN'T fire — the auto-deny is defense-in-depth in case a future Codex
// version routes a prompt through anyway.

export type ThreadListener = (n: RpcNotification) => void;

export interface CreateThreadOptions {
  cwd: string;
  sandbox: SandboxMode;
  model?: string | null;
}

export interface ResumeThreadOptions {
  threadId: string;
  cwd: string;
  sandbox: SandboxMode;
  model?: string | null;
}

export interface StartTurnOptions {
  threadId: string;
  prompt: string;
  /**
   * Override the reasoning effort for this turn (and subsequent turns on the
   * same thread). Codex's TurnStartParams.effort docs spell this out — it's a
   * per-turn override, not a thread-immutable option, so we don't have to
   * rebuild the thread when the user flips the badge.
   */
  effort?: ReasoningEffort | null;
}

export interface CodexClientOptions extends TransportOptions {
  // Maximum number of unexpected child crashes within `crashWindowMs` before
  // the client refuses to respawn. Defaults match the migration plan: 4 in
  // 60s.
  maxCrashesPerWindow?: number;
  crashWindowMs?: number;
}

interface KnownThread {
  options: CreateThreadOptions | ResumeThreadOptions;
  isResumable: boolean;
}

const APPROVAL_POLICY_NEVER: AskForApproval = 'never';

export class CodexAppServerClient {
  private transport: CodexAppServerTransport | null = null;
  private starting: Promise<void> | null = null;
  private listeners = new Map<string, ThreadListener>();
  // Account-scoped notification listeners (account/*). These notifications
  // carry NO threadId, so the per-thread `listeners` map can never deliver
  // them — they get their own fan-out. Used for `account/rateLimits/updated`.
  private accountListeners = new Set<ThreadListener>();
  private exitListeners = new Set<() => void>();
  private knownThreads = new Map<string, KnownThread>();
  private crashTimes: number[] = [];
  private permanentlyDead = false;
  // Set briefly after a respawn so the next `runTurn` can surface a
  // user-facing "codex restarted; resuming" alert (one alert per crash event,
  // not per thread).
  private respawnFlag = false;

  constructor(private readonly options: CodexClientOptions = {}) {}

  /**
   * Lazy-spawn the child + run the initialize handshake. Idempotent — multiple
   * concurrent callers share one in-flight promise.
   */
  async ensureReady(): Promise<void> {
    if (this.permanentlyDead) {
      throw new Error(
        'codex app-server crashed too many times in the recent window. ' +
          'Manual daemon restart required.',
      );
    }
    if (this.transport && this.transport.isAlive()) return;
    if (this.starting) return this.starting;
    this.starting = this.spawnAndInitialize().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async spawnAndInitialize(): Promise<void> {
    const transport = new CodexAppServerTransport(this.options);
    this.transport = transport;

    transport.on('exit', () => this.onTransportExit());
    transport.on('error', (err) =>
      // Missing binary (codex not installed / not on PATH) is expected for an
      // optional provider — one concise line, no stack spam.
      (err as NodeJS.ErrnoException)?.code === 'ENOENT'
        ? console.warn('[codex] codex CLI not found on PATH (app-server unavailable)')
        : console.error('[codex] transport error', err),
    );
    transport.on('notification', (n) => this.dispatchNotification(n));

    this.registerAutoDenyHandlers(transport);

    transport.start();

    const clientInfo: ClientInfo = {
      name: 'multitable-daemon',
      title: 'MultiTable',
      version: CODEX_CLI_VERSION,
    };
    const capabilities: InitializeCapabilities = {
      experimentalApi: false,
      optOutNotificationMethods: null,
    };
    await transport.request<InitializeResponse>('initialize', { clientInfo, capabilities });
    console.info('[codex] app-server initialized', { codexCliVersion: CODEX_CLI_VERSION });
  }

  private onTransportExit(): void {
    const now = Date.now();
    const window = this.options.crashWindowMs ?? 60_000;
    const max = this.options.maxCrashesPerWindow ?? 4;
    this.crashTimes = this.crashTimes.filter((t) => now - t < window);
    this.crashTimes.push(now);
    this.respawnFlag = true;
    if (this.crashTimes.length >= max) {
      this.permanentlyDead = true;
      console.error('[codex] app-server crashed too many times — refusing to respawn');
    }
    // Mark every known thread as needing re-resume on next use.
    for (const [, t] of this.knownThreads) {
      t.isResumable = true;
    }
    this.transport = null;
    // Wake anything blocked on the child (in-flight turn completions). The
    // transport only rejects pending RPC *requests*; a turn waiting on a
    // `turn/completed` notification would otherwise hang forever.
    for (const listener of this.exitListeners) {
      try {
        listener();
      } catch (err) {
        console.error('[codex] exit listener threw', err);
      }
    }
  }

  /**
   * Returns true exactly once after a crash-respawn so the adapter can surface
   * a single "Codex restarted" alert. Resets to false after read.
   */
  consumeRespawnFlag(): boolean {
    if (!this.respawnFlag) return false;
    this.respawnFlag = false;
    return true;
  }

  private dispatchNotification(n: RpcNotification): void {
    const params = n.params as { threadId?: string } | null | undefined;
    const threadId = params && typeof params.threadId === 'string' ? params.threadId : null;
    if (!threadId) {
      // Account-scoped notifications (account/rateLimits/updated, account/updated,
      // …) carry no threadId. Fan them out to account listeners instead of
      // dropping — this is the only delivery path for usage limits.
      if (typeof n.method === 'string' && n.method.startsWith('account/')) {
        for (const listener of this.accountListeners) {
          try {
            listener(n);
          } catch (err) {
            console.error('[codex] account listener threw for', n.method, err);
          }
        }
      }
      // Other non-thread-scoped notifications (configWarning, app/list/*, etc.)
      // are not load-bearing; drop them.
      return;
    }
    const listener = this.listeners.get(threadId);
    if (!listener) return;
    try {
      listener(n);
    } catch (err) {
      console.error('[codex] thread listener threw for', threadId, err);
    }
  }

  private registerAutoDenyHandlers(transport: CodexAppServerTransport): void {
    // Legacy approvals (kept by the protocol for compat).
    transport.onRequest('applyPatchApproval', () => ({ decision: 'denied' }));
    transport.onRequest('execCommandApproval', () => ({ decision: 'denied' }));
    // v2 approval requests.
    transport.onRequest('item/commandExecution/requestApproval', () => ({ decision: 'decline' }));
    transport.onRequest('item/fileChange/requestApproval', () => ({ decision: 'decline' }));
    transport.onRequest('item/permissions/requestApproval', () => ({
      // Empty grant — equivalent to a decline since no permissions are added.
      permissions: {},
      scope: 'turn',
      strictAutoReview: false,
    }));
    transport.onRequest('item/tool/requestUserInput', () => ({ answers: {} }));
    transport.onRequest('mcpServer/elicitation/request', () => ({
      action: 'cancel',
      content: null,
      _meta: null,
    }));
    // The dynamic tool call hook is a server-request; auto-respond with
    // empty content (the codex protocol expects we always respond — null isn't
    // accepted by all variants, so we go minimal).
    transport.onRequest('item/tool/call', () => ({ contentItems: [], success: false }));
    // Misc account-side hook the server may call into. We don't auth-cycle
    // tokens; reject and let the existing `~/.codex/auth.json` path handle it.
    transport.onRequest('account/chatgptAuthTokens/refresh', () => {
      throw new Error('multitable does not refresh codex auth tokens; rely on `codex login`');
    });
  }

  /**
   * Create a fresh thread. Returns the new threadId.
   */
  async createThread(opts: CreateThreadOptions): Promise<string> {
    await this.ensureReady();
    const transport = this.requireTransport();
    const params: ThreadStartParams = {
      cwd: opts.cwd,
      sandbox: opts.sandbox,
      approvalPolicy: APPROVAL_POLICY_NEVER,
      ...(opts.model ? { model: opts.model } : {}),
    };
    const res = await transport.request<ThreadStartResponse>('thread/start', params);
    const threadId = res.thread.id;
    this.knownThreads.set(threadId, { options: opts, isResumable: true });
    return threadId;
  }

  /**
   * Resume an existing thread by id. Returns the same threadId for symmetry.
   */
  async resumeThread(opts: ResumeThreadOptions): Promise<string> {
    await this.ensureReady();
    const transport = this.requireTransport();
    const params: ThreadResumeParams = {
      threadId: opts.threadId,
      cwd: opts.cwd,
      sandbox: opts.sandbox,
      approvalPolicy: APPROVAL_POLICY_NEVER,
      excludeTurns: true,
      ...(opts.model ? { model: opts.model } : {}),
    };
    await transport.request<ThreadResumeResponse>('thread/resume', params);
    this.knownThreads.set(opts.threadId, { options: opts, isResumable: true });
    return opts.threadId;
  }

  async startTurn(opts: StartTurnOptions): Promise<{ turnId: string }> {
    const transport = this.requireTransport();
    const params: TurnStartParams = {
      threadId: opts.threadId,
      input: [{ type: 'text', text: opts.prompt, text_elements: [] }],
      ...(opts.effort ? { effort: opts.effort } : {}),
    };
    const res = await transport.request<TurnStartResponse>('turn/start', params);
    return { turnId: res.turn.id };
  }

  async interruptTurn(params: TurnInterruptParams): Promise<void> {
    const transport = this.transport;
    if (!transport || !transport.isAlive()) return;
    try {
      await transport.request('turn/interrupt', params);
    } catch (err) {
      // Best-effort. If the turn already completed the server may 404 the id;
      // not actionable.
      console.warn('[codex] turn/interrupt rejected', err);
    }
  }

  /**
   * Register a listener for notifications scoped to one thread. Returns an
   * unsubscribe function. Calling subscribe a second time for the same
   * threadId replaces the previous listener.
   */
  subscribe(threadId: string, listener: ThreadListener): () => void {
    this.listeners.set(threadId, listener);
    return () => {
      const current = this.listeners.get(threadId);
      if (current === listener) this.listeners.delete(threadId);
    };
  }

  /**
   * Register a listener for account-scoped notifications (account/*). These
   * have no threadId, so they're delivered here rather than via `subscribe`.
   * Used by the adapter for `account/rateLimits/updated`. Returns an
   * unsubscribe function.
   */
  subscribeAccount(listener: ThreadListener): () => void {
    this.accountListeners.add(listener);
    return () => {
      this.accountListeners.delete(listener);
    };
  }

  /**
   * Register a listener fired when the app-server child exits (crash or
   * shutdown). Used by the adapter to fail an in-flight turn immediately —
   * the turn's completion is settled by a notification, not an RPC response,
   * so transport-level request rejection alone can't unblock it. Returns an
   * unsubscribe function.
   */
  subscribeExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /**
   * Pull the current account rate-limit snapshot on demand (vs. waiting for the
   * next `account/rateLimits/updated` push). Used on session provision so the
   * usage-limits indicator has data before the first turn.
   */
  async getAccountRateLimits(): Promise<GetAccountRateLimitsResponse> {
    await this.ensureReady();
    const transport = this.requireTransport();
    return transport.request<GetAccountRateLimitsResponse>('account/rateLimits/read', undefined);
  }

  close(): void {
    if (!this.transport) return;
    try {
      this.transport.close();
    } catch {
      /* ignore */
    }
    this.transport = null;
    this.listeners.clear();
    this.accountListeners.clear();
    this.exitListeners.clear();
    this.knownThreads.clear();
  }

  private requireTransport(): CodexAppServerTransport {
    if (!this.transport || !this.transport.isAlive()) {
      throw new Error('codex app-server transport is not running');
    }
    return this.transport;
  }
}
