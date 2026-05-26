import { GrokAcpTransport, RpcNotification, GrokTransportOptions } from './transport.js';

// GrokAcpClient — wrapper over a long-lived `grok agent stdio` child. One per
// project cwd (see GrokAdapter.clientFor). Lazy-spawned on first use.
//
// Per-session notification fan-out: each session registers a listener via
// `subscribe(sessionId, listener)`. The dispatcher reads `params.sessionId` off
// every notification (every ACP `session/update` is session-scoped) and routes
// to the matching listener.
//
// Server-requests (ACP-side):
//   - `session/request_permission` — if a permissionHandler is wired (the
//     normal MultiTable wiring, see GrokAdapter), the handler routes the
//     request through PermissionManager so the user sees a prompt in the UI.
//     Without a handler (standalone client / tests) we fall back to the
//     auto-allow policy below.
//   - `fs/*` / `terminal/*` — we don't advertise these client capabilities, so
//     Grok shouldn't send them. Reject defensively if it does.

const GROK_ACP_PROTOCOL_VERSION = 1;

// === Auth result =========================================================
//
// On `ensureReady`, the client inspects the auth methods Grok advertises during
// `initialize`. Verified on grok v0.2.2:
//   - `cached_token` — "Cached token from ~/.grok/auth.json" (the authed path
//     for SuperGrok/X-Premium subscribers who ran `grok auth login`).
//   - `grok.com` — interactive "Sign in with Grok" (browser); means no usable
//     on-disk credentials yet.
//
// We accept `cached_token` (or any non-interactive method) as the working auth
// path. If only the interactive `grok.com` method is offered — or authenticate
// fails — we report `needsSetup` so the adapter can surface a sign-in alert.
export type GrokAuthState =
  | { kind: 'ready'; methodId: string }
  | { kind: 'needsSetup'; methodIds: string[] };

interface AuthMethod {
  id: string;
  name?: string;
  description?: string;
}

interface InitializeResult {
  protocolVersion?: number;
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: Record<string, unknown>;
  authMethods?: AuthMethod[];
}

// Per-session config Grok accepts on `session/new` (and we re-send on
// `session/load` so a mode/effort/model change re-applies). Verified: grok
// honors `model`, `permissionMode`, `effort` here.
export interface NewSessionOptions {
  cwd: string;
  model?: string | null;
  permissionMode?: string;
  effort?: string | null;
}

export interface PromptOptions {
  sessionId: string;
  text: string;
}

// Grok returns usage in the `session/prompt` response `_meta` (no USD).
export interface PromptResult {
  stopReason: string;
  _meta?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cacheCreationTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
    modelId?: string;
  };
}

export type SessionListener = (n: RpcNotification) => void;

// Subset of the ACP request_permission payload we surface. The agent may send
// more fields; we ignore what we don't use.
export interface AcpToolCall {
  toolCallId?: string;
  title?: string;
  kind?: string;
  rawInput?: Record<string, unknown>;
  locations?: Array<{ path?: string }>;
}

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall?: AcpToolCall;
  options: AcpPermissionOption[];
}

// ACP RequestPermissionResponse shape. The inner `outcome` field is the
// discriminator — the values are LITERALS, "selected" / "cancelled", not
// "allowed" / "denied". Returning the wrong shape silently coerces every
// approval to a deny on the agent side.
export type AcpPermissionOutcome =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } };

export type AcpPermissionHandler = (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome>;

// === ask_user_question (the `_x.ai/ask_user_question` server-request) ========
//
// Grok's `ask_user_question` tool sends this server-request to the client to
// present a structured question with options and get the user's answer back.
// Wire shape verified against grok v0.2.2:
//   request:  { sessionId, toolCallId?, questions: [{ question, options:
//              [{ label, description?, preview? }], multiSelect: bool|null }],
//              mode? }
//   response: { outcome: 'accepted', answers: { "<questionIndex>": [label…] } }
//          |  { outcome: 'cancelled' }    (variants also: skip_interview,
//                                          chat_about_this — unused by us)
// The `outcome` is a STRING tag (not the nested object permission uses); the
// answers map is keyed by question index (stringified) → selected labels.
export interface AcpAskOption {
  label: string;
  description?: string;
  preview?: string;
}
export interface AcpAskQuestion {
  question: string;
  header?: string;
  options: AcpAskOption[];
  multiSelect?: boolean | null;
}
export interface AcpAskQuestionRequest {
  sessionId: string;
  toolCallId?: string;
  questions: AcpAskQuestion[];
}
export type AcpAskQuestionOutcome =
  | { outcome: 'accepted'; answers: Record<string, string[]> }
  | { outcome: 'cancelled' };

export type AcpAskQuestionHandler = (
  req: AcpAskQuestionRequest,
) => Promise<AcpAskQuestionOutcome>;

export interface GrokClientOptions extends GrokTransportOptions {
  // Fallback policy used only when no permissionHandler is supplied. Kept for
  // standalone-client / test usage; the normal MultiTable wiring always
  // supplies a handler and this is unused.
  permissionPolicy?: 'allow_session' | 'allow_once' | 'deny';
  // When set, every ACP `session/request_permission` is routed here.
  permissionHandler?: AcpPermissionHandler;
  // When set, every `_x.ai/ask_user_question` server-request is routed here.
  askQuestionHandler?: AcpAskQuestionHandler;
}

// Grok's interactive (browser) auth method. Its presence alone doesn't mean
// authenticated — we need a non-interactive method (e.g. cached_token).
const INTERACTIVE_AUTH_METHOD_ID = 'grok.com';

export class GrokAcpClient {
  private transport: GrokAcpTransport | null = null;
  private starting: Promise<void> | null = null;
  private listeners = new Map<string, SessionListener>();
  private authState: GrokAuthState | null = null;
  private permissionPolicy: 'allow_session' | 'allow_once' | 'deny';
  private permissionHandler: AcpPermissionHandler | null;
  private askQuestionHandler: AcpAskQuestionHandler | null;

  constructor(private readonly options: GrokClientOptions = {}) {
    this.permissionPolicy = options.permissionPolicy ?? 'allow_session';
    this.permissionHandler = options.permissionHandler ?? null;
    this.askQuestionHandler = options.askQuestionHandler ?? null;
  }

  /**
   * Lazy-spawn the child, initialize, and authenticate. Idempotent — multiple
   * concurrent callers share one in-flight promise. Resolves with the auth
   * state (the adapter surfaces a typed alert on `needsSetup`).
   */
  async ensureReady(): Promise<GrokAuthState> {
    if (this.transport && this.transport.isAlive() && this.authState) {
      return this.authState;
    }
    if (this.starting) {
      await this.starting;
      if (!this.authState) throw new Error('grok agent stdio init finished without auth state');
      return this.authState;
    }
    this.starting = this.spawnAndInitialize().finally(() => {
      this.starting = null;
    });
    await this.starting;
    if (!this.authState) throw new Error('grok agent stdio init finished without auth state');
    return this.authState;
  }

  private async spawnAndInitialize(): Promise<void> {
    const transport = new GrokAcpTransport(this.options);
    this.transport = transport;

    transport.on('exit', () => this.onTransportExit());
    transport.on('error', (err) => console.error('[grok] transport error', err));
    transport.on('notification', (n) => this.dispatchNotification(n));

    this.registerServerRequestHandlers(transport);

    transport.start();

    // ACP `initialize` handshake. Grok returns its auth method list here.
    // ClientCapabilities advertise what server-requests we accept — we refuse
    // fs and terminal so Grok's tool surface stays self-contained (Grok runs
    // its own tools under its own workspace-trust/sandbox).
    const init = await transport.request<InitializeResult>('initialize', {
      protocolVersion: GROK_ACP_PROTOCOL_VERSION,
      clientInfo: {
        name: 'multitable-daemon',
        title: 'MultiTable',
        version: '0.8.0',
      },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });

    const methods = Array.isArray(init.authMethods) ? init.authMethods : [];
    // Prefer the on-disk cached token; otherwise any non-interactive method.
    const provider =
      methods.find((m) => m && m.id === 'cached_token') ??
      methods.find(
        (m) => m && typeof m.id === 'string' && m.id !== INTERACTIVE_AUTH_METHOD_ID,
      );

    if (!provider || typeof provider.id !== 'string') {
      this.authState = {
        kind: 'needsSetup',
        methodIds: methods.map((m) => m.id).filter((id): id is string => typeof id === 'string'),
      };
      console.info('[grok] acp initialized without usable credentials', {
        authMethods: methods.map((m) => m.id),
      });
      return;
    }

    try {
      await transport.request('authenticate', { methodId: provider.id });
      this.authState = { kind: 'ready', methodId: provider.id };
      console.info('[grok] acp initialized', {
        authMethod: provider.id,
        agentVersion: init.agentInfo?.version,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[grok] authenticate rejected', { methodId: provider.id, error: message });
      this.authState = {
        kind: 'needsSetup',
        methodIds: methods.map((m) => m.id).filter((id): id is string => typeof id === 'string'),
      };
    }
  }

  private onTransportExit(): void {
    this.transport = null;
    this.authState = null;
  }

  private dispatchNotification(n: RpcNotification): void {
    const params = n.params as { sessionId?: string } | null | undefined;
    const sessionId = params && typeof params.sessionId === 'string' ? params.sessionId : null;
    if (!sessionId) return;
    const listener = this.listeners.get(sessionId);
    if (!listener) return;
    try {
      listener(n);
    } catch (err) {
      console.error('[grok] session listener threw for', sessionId, err);
    }
  }

  private registerServerRequestHandlers(transport: GrokAcpTransport): void {
    transport.onRequest('session/request_permission', async (params) => {
      const req = (params ?? null) as Partial<AcpPermissionRequest> | null;
      const options = Array.isArray(req?.options)
        ? (req!.options as AcpPermissionOption[]).filter((o) => o && typeof o.optionId === 'string')
        : [];

      if (this.permissionHandler && req && typeof req.sessionId === 'string') {
        try {
          return await this.permissionHandler({
            sessionId: req.sessionId,
            toolCall: req.toolCall,
            options,
          });
        } catch (err) {
          console.warn('[grok] permission handler threw, denying', err);
          return { outcome: { outcome: 'cancelled' } };
        }
      }

      const candidate = pickPermissionOption(options, this.permissionPolicy);
      if (!candidate) {
        return { outcome: { outcome: 'cancelled' } };
      }
      return { outcome: { outcome: 'selected', optionId: candidate } };
    });

    // Grok's `ask_user_question` tool delegates to the client via this
    // server-request. Route it to the handler (the adapter presents the
    // question through PermissionManager, same UI as Claude's AskUserQuestion)
    // and return the selected answer. Without a handler, cancel so the tool
    // resolves cleanly instead of hanging.
    transport.onRequest('_x.ai/ask_user_question', async (params) => {
      const req = (params ?? null) as Partial<AcpAskQuestionRequest> | null;
      if (this.askQuestionHandler && req && typeof req.sessionId === 'string') {
        try {
          return await this.askQuestionHandler({
            sessionId: req.sessionId,
            toolCallId: req.toolCallId,
            questions: Array.isArray(req.questions) ? req.questions : [],
          });
        } catch (err) {
          console.warn('[grok] ask-question handler threw, cancelling', err);
          return { outcome: 'cancelled' };
        }
      }
      return { outcome: 'cancelled' };
    });

    // We do NOT advertise fs/terminal capabilities. Reject if the agent ever
    // sends one anyway — keeps the surface honest (Grok runs its own tools).
    transport.onRequest('fs/read_text_file', () => {
      throw new Error('multitable did not advertise fs capability');
    });
    transport.onRequest('fs/write_text_file', () => {
      throw new Error('multitable did not advertise fs capability');
    });
    transport.onRequest('terminal/create', () => {
      throw new Error('multitable did not advertise terminal capability');
    });
  }

  /**
   * Create a new ACP session. Returns the new sessionId. Grok honors
   * `model` / `permissionMode` / `effort` here (verified v0.2.2). MCP wiring
   * lives on the Grok side via project `.grok/settings.json`, so we always send
   * an empty mcpServers list.
   */
  async newSession(opts: NewSessionOptions): Promise<string> {
    await this.ensureReady();
    const transport = this.requireTransport();
    const res = await transport.request<{ sessionId?: string }>(
      'session/new',
      this.sessionParams(opts),
    );
    if (!res || typeof res.sessionId !== 'string') {
      throw new Error('grok session/new returned no sessionId');
    }
    return res.sessionId;
  }

  /**
   * Re-attach to an existing Grok ACP session (agentCapabilities.loadSession is
   * true on v0.2.2). We re-send the per-session config so a mode/effort/model
   * change re-applies on resume; Grok ignores params it doesn't honor on load.
   */
  async loadSession(sessionId: string, opts: NewSessionOptions): Promise<string> {
    await this.ensureReady();
    const transport = this.requireTransport();
    await transport.request('session/load', { sessionId, ...this.sessionParams(opts) });
    return sessionId;
  }

  private sessionParams(opts: NewSessionOptions): Record<string, unknown> {
    const params: Record<string, unknown> = { cwd: opts.cwd, mcpServers: [] };
    if (opts.model) params.model = opts.model;
    if (opts.permissionMode) params.permissionMode = opts.permissionMode;
    if (opts.effort) params.effort = opts.effort;
    return params;
  }

  /**
   * Send a turn. Resolves when the agent emits `session/prompt`'s response with
   * a stopReason — until then `session/update` notifications flow to the
   * subscribed session listener.
   */
  async prompt(opts: PromptOptions): Promise<PromptResult> {
    const transport = this.requireTransport();
    const res = await transport.request<PromptResult>('session/prompt', {
      sessionId: opts.sessionId,
      prompt: [{ type: 'text', text: opts.text }],
    });
    return res;
  }

  /**
   * Best-effort cancel. ACP's session/cancel is a notification (no response),
   * so we don't await — Grok flips its cancel flag and the pending
   * `session/prompt` resolves with `stopReason: 'cancelled'`.
   */
  cancel(sessionId: string): void {
    if (!this.transport || !this.transport.isAlive()) return;
    try {
      this.transport.notify('session/cancel', { sessionId });
    } catch (err) {
      console.warn('[grok] cancel notify failed', err);
    }
  }

  /**
   * Register a listener for notifications scoped to one session. Returns an
   * unsubscribe function. Calling subscribe again for the same sessionId
   * replaces the previous listener.
   */
  subscribe(sessionId: string, listener: SessionListener): () => void {
    this.listeners.set(sessionId, listener);
    return () => {
      const current = this.listeners.get(sessionId);
      if (current === listener) this.listeners.delete(sessionId);
    };
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
    this.authState = null;
  }

  private requireTransport(): GrokAcpTransport {
    if (!this.transport || !this.transport.isAlive()) {
      throw new Error('grok agent stdio transport is not running');
    }
    return this.transport;
  }
}

const PREFERRED_OPTION_BY_POLICY: Record<string, string[]> = {
  allow_session: ['allow_session', 'allow_once', 'allow_always'],
  allow_once: ['allow_once', 'allow_session'],
  deny: ['deny'],
};

function pickPermissionOption(
  options: Array<{ optionId?: string }>,
  policy: 'allow_session' | 'allow_once' | 'deny',
): string | null {
  const candidates = PREFERRED_OPTION_BY_POLICY[policy] ?? ['allow_once'];
  const offered = new Set(
    options
      .map((o) => (typeof o?.optionId === 'string' ? o.optionId : null))
      .filter(Boolean) as string[],
  );
  for (const id of candidates) {
    if (offered.has(id)) return id;
  }
  for (const o of options) {
    if (typeof o.optionId === 'string' && o.optionId !== 'deny') return o.optionId;
  }
  return null;
}
