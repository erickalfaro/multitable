import {
  HermesAcpTransport,
  RpcNotification,
  HermesTransportOptions,
} from './transport.js';

// HermesAcpClient — singleton wrapper over a long-lived `hermes acp` child.
// One per daemon. Lazy-spawned on first use so daemons that never use Hermes
// don't pay the Python startup cost.
//
// Per-session notification fan-out: each session registers a listener via
// `subscribe(sessionId, listener)`. The dispatcher reads `params.sessionId` off
// every notification (every ACP `session/update` is session-scoped) and routes
// to the matching listener.
//
// Server-requests (ACP-side):
//   - `session/request_permission` — if a permissionHandler is wired (the
//     normal MultiTable wiring, see HermesAdapter), the handler routes the
//     request through PermissionManager so the user sees a prompt in the UI.
//     If no handler is wired (standalone client / tests) we fall back to the
//     auto-allow policy below.
//   - `fs/read_text_file` / `fs/write_text_file` — we don't advertise the
//     filesystem client capability, so Hermes shouldn't send these. Reject
//     defensively if it does.
//   - `terminal/*` — same: not advertised, error if sent.

const HERMES_ACP_PROTOCOL_VERSION = 1;

// === Auth result =========================================================
//
// On `ensureReady`, the client picks one of the agent-side auth methods
// advertised by Hermes during `initialize`. Hermes advertises:
//   - `<provider>` (e.g. "xai-oauth") — agent already has runtime credentials
//     configured (per acp_adapter/auth.py:build_auth_methods)
//   - `hermes-setup` — terminal setup method (no credentials yet)
//
// We accept the first non-`hermes-setup` method as the working auth path.
// `hermes-setup` is a "go run `hermes model` in a terminal" signal — for the
// daemon's purposes that's the same as "no credentials configured".
export type HermesAuthState =
  | { kind: 'ready'; methodId: string }
  | { kind: 'needsSetup'; methodIds: string[] };

interface AuthMethod {
  id: string;
  name?: string;
  description?: string;
  // Hermes encodes its terminal-setup option with `type: 'terminal'`.
  type?: string;
}

interface InitializeResult {
  protocolVersion?: number;
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: Record<string, unknown>;
  authMethods?: AuthMethod[];
}

export interface NewSessionOptions {
  cwd: string;
}

export interface PromptOptions {
  sessionId: string;
  text: string;
}

export interface PromptResult {
  stopReason: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
}

export type SessionListener = (n: RpcNotification) => void;

// Subset of the ACP request_permission payload we care about. The agent may
// send more fields; we ignore what we don't surface.
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
// discriminator in the agent-side Pydantic union (DeniedOutcome vs
// AllowedOutcome) — the values are LITERALS, "selected" / "cancelled", not
// "allowed" / "denied". Returning the wrong shape silently coerces every
// approval to a deny on the agent side.
export type AcpPermissionOutcome =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } };

export type AcpPermissionHandler = (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome>;

export interface HermesClientOptions extends HermesTransportOptions {
  // Fallback policy used only when no permissionHandler is supplied. Kept for
  // standalone-client / test usage; the normal MultiTable wiring always
  // supplies a handler and this is unused.
  permissionPolicy?: 'allow_session' | 'allow_once' | 'deny';
  // When set, every ACP `session/request_permission` is routed here. The
  // handler decides which optionId to pick (typically by routing through
  // PermissionManager and waiting for the UI).
  permissionHandler?: AcpPermissionHandler;
}

const TERMINAL_SETUP_AUTH_METHOD_ID = 'hermes-setup';

export class HermesAcpClient {
  private transport: HermesAcpTransport | null = null;
  private starting: Promise<void> | null = null;
  private listeners = new Map<string, SessionListener>();
  private authState: HermesAuthState | null = null;
  private permissionPolicy: 'allow_session' | 'allow_once' | 'deny';
  private permissionHandler: AcpPermissionHandler | null;

  constructor(private readonly options: HermesClientOptions = {}) {
    this.permissionPolicy = options.permissionPolicy ?? 'allow_session';
    this.permissionHandler = options.permissionHandler ?? null;
  }

  /**
   * Lazy-spawn the child, initialize, and authenticate. Idempotent — multiple
   * concurrent callers share one in-flight promise. Throws if no usable auth
   * method is configured (so the adapter can surface a typed alert).
   */
  async ensureReady(): Promise<HermesAuthState> {
    if (this.transport && this.transport.isAlive() && this.authState) {
      return this.authState;
    }
    if (this.starting) {
      await this.starting;
      if (!this.authState) throw new Error('hermes acp init finished without auth state');
      return this.authState;
    }
    this.starting = this.spawnAndInitialize().finally(() => {
      this.starting = null;
    });
    await this.starting;
    if (!this.authState) throw new Error('hermes acp init finished without auth state');
    return this.authState;
  }

  private async spawnAndInitialize(): Promise<void> {
    const transport = new HermesAcpTransport(this.options);
    this.transport = transport;

    transport.on('exit', () => this.onTransportExit());
    transport.on('error', (err) => console.error('[hermes] transport error', err));
    transport.on('notification', (n) => this.dispatchNotification(n));

    this.registerServerRequestHandlers(transport);

    transport.start();

    // ACP `initialize` handshake. Hermes returns its auth method list here.
    // ClientCapabilities advertise what server-requests we'll accept — we
    // explicitly refuse fs and terminal so Hermes's tool surface stays
    // self-contained (Hermes' own sandbox enforces; we don't need to broker).
    const init = await transport.request<InitializeResult>('initialize', {
      protocolVersion: HERMES_ACP_PROTOCOL_VERSION,
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
    const provider = methods.find(
      (m) => m && typeof m.id === 'string' && m.id !== TERMINAL_SETUP_AUTH_METHOD_ID,
    );

    if (!provider || typeof provider.id !== 'string') {
      this.authState = {
        kind: 'needsSetup',
        methodIds: methods.map((m) => m.id).filter((id): id is string => typeof id === 'string'),
      };
      console.info('[hermes] acp initialized without provider credentials', {
        authMethods: methods.map((m) => m.id),
      });
      return;
    }

    try {
      await transport.request('authenticate', { methodId: provider.id });
      this.authState = { kind: 'ready', methodId: provider.id };
      console.info('[hermes] acp initialized', {
        authMethod: provider.id,
        agentVersion: init.agentInfo?.version,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[hermes] authenticate rejected', { methodId: provider.id, error: message });
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
      console.error('[hermes] session listener threw for', sessionId, err);
    }
  }

  private registerServerRequestHandlers(transport: HermesAcpTransport): void {
    // Permission requests. Normal wiring (HermesAdapter) supplies a handler
    // that routes through PermissionManager so the UI prompts the user.
    // Without a handler (standalone client / tests) we fall back to the
    // configured auto-allow policy so Hermes doesn't block mid-turn.
    transport.onRequest('session/request_permission', async (params) => {
      const req = (params ?? null) as Partial<AcpPermissionRequest> | null;
      const options = Array.isArray(req?.options)
        ? (req!.options as AcpPermissionOption[]).filter(
            (o) => o && typeof o.optionId === 'string',
          )
        : [];

      if (this.permissionHandler && req && typeof req.sessionId === 'string') {
        try {
          return await this.permissionHandler({
            sessionId: req.sessionId,
            toolCall: req.toolCall,
            options,
          });
        } catch (err) {
          console.warn('[hermes] permission handler threw, denying', err);
          return { outcome: { outcome: 'cancelled' } };
        }
      }

      // Map the daemon's intent to whatever option ids the agent actually
      // offered. Hermes' canonical ids are allow_once / allow_session /
      // allow_always / deny (see acp_adapter/permissions.py).
      const candidate = pickPermissionOption(options, this.permissionPolicy);
      if (!candidate) {
        return { outcome: { outcome: 'cancelled' } };
      }
      return { outcome: { outcome: 'selected', optionId: candidate } };
    });

    // We do NOT advertise fs/terminal capabilities. Reject if the agent ever
    // sends one anyway — keeps the surface honest.
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
   * Create a new ACP session. Returns the new sessionId. Always send an empty
   * mcpServers list — MCP wiring lives on the Hermes side via `hermes tools`,
   * not on the daemon's side.
   */
  async newSession(opts: NewSessionOptions): Promise<string> {
    await this.ensureReady();
    const transport = this.requireTransport();
    const res = await transport.request<{ sessionId?: string }>('session/new', {
      cwd: opts.cwd,
      mcpServers: [],
    });
    if (!res || typeof res.sessionId !== 'string') {
      throw new Error('hermes session/new returned no sessionId');
    }
    return res.sessionId;
  }

  /**
   * Re-attach to an existing Hermes ACP session. Returns the sessionId for
   * symmetry. Hermes implements both `session/load` and `session/resume`; load
   * is the universally-supported one (resume is part of ACP's unstable session
   * capabilities). We use load.
   */
  async loadSession(sessionId: string, cwd: string): Promise<string> {
    await this.ensureReady();
    const transport = this.requireTransport();
    await transport.request('session/load', {
      sessionId,
      cwd,
      mcpServers: [],
    });
    return sessionId;
  }

  /**
   * Send a turn. The promise resolves when the agent emits `session/prompt`'s
   * response with a stopReason — until then `session/update` notifications
   * flow to the subscribed session listener.
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
   * so we don't await anything — Hermes flips its internal cancel flag and the
   * pending `session/prompt` resolves with `stopReason: 'cancelled'`.
   */
  cancel(sessionId: string): void {
    if (!this.transport || !this.transport.isAlive()) return;
    try {
      this.transport.notify('session/cancel', { sessionId });
    } catch (err) {
      console.warn('[hermes] cancel notify failed', err);
    }
  }

  /**
   * Register a listener for notifications scoped to one session. Returns an
   * unsubscribe function. Calling subscribe a second time for the same
   * sessionId replaces the previous listener.
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

  private requireTransport(): HermesAcpTransport {
    if (!this.transport || !this.transport.isAlive()) {
      throw new Error('hermes acp transport is not running');
    }
    return this.transport;
  }
}

// Hermes maps these option ids in acp_adapter/permissions.py:_OPTION_ID_TO_HERMES.
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
    options.map((o) => (typeof o?.optionId === 'string' ? o.optionId : null)).filter(Boolean) as string[],
  );
  for (const id of candidates) {
    if (offered.has(id)) return id;
  }
  // Fall through: take the first non-deny option the agent offered, or null.
  for (const o of options) {
    if (typeof o.optionId === 'string' && o.optionId !== 'deny') return o.optionId;
  }
  return null;
}
