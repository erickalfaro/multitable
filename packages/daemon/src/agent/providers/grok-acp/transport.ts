import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, Interface } from 'readline';
import { EventEmitter } from 'events';

// Line-delimited JSON-RPC 2.0 transport for `grok agent stdio` — xAI's Grok
// Build CLI run as an Agent Client Protocol (ACP) agent over stdio. One JSON
// object per line on both stdin and stdout.
//
// Three frame kinds we receive from the agent:
//   - response:           {jsonrpc, id, result | error}
//   - notification:       {jsonrpc, method, params}    (no id)
//   - server-request:     {jsonrpc, method, id, params} (we must respond)
//
// Grok pushes all user-relevant work through `session/update` notifications
// (assistant chunks, reasoning chunks, tool calls) and a single `session/prompt`
// response that closes the turn. Server-requests cover permission prompts; the
// filesystem / terminal surface is NOT advertised so it shouldn't be sent.
//
// Unlike the Hermes adapter, Grok needs NO bwrap sandbox: it's a self-contained
// binary with its own `--sandbox` / workspace-trust model, so we spawn it
// directly. The wire mechanics (id correlation, frame dispatch) are otherwise
// the standard ACP shape — higher-level routing lives in client.ts.

export type RpcId = number;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcNotification {
  method: string;
  params: unknown;
}

export interface RpcServerRequest {
  id: RpcId;
  method: string;
  params: unknown;
}

export type NotificationHandler = (params: unknown) => void;
export type ServerRequestHandler = (params: unknown) => Promise<unknown> | unknown;

export interface GrokTransportOptions {
  // Path to the grok binary. Defaults to 'grok' on PATH.
  grokPath?: string;
  // CLI args injected on the `grok agent` parent command, BEFORE `stdio`. This
  // is where Grok's spawn-time config lives: `--always-approve` (auto mode),
  // `--agent-profile <md>` (plan / read-only mode), `--reasoning-effort`, `-m`.
  // Grok 0.2.2 ignores model/permissionMode/effort on `session/new` (verified),
  // so these MUST be spawn flags — which is why the child pool is keyed by the
  // full config, not just cwd (see GrokAdapter.clientFor / buildAgentArgs).
  agentArgs?: string[];
  // Extra CLI args injected after `agent … stdio`. Mostly for testing / version
  // pinning.
  extraArgs?: string[];
  // Working directory for the child. Defaults to process.cwd(). ACP sessions
  // also carry their own per-session cwd via `session/new`.
  cwd?: string;
  // Extra env overlays on top of process.env (e.g. a GROK_* override). Empty in
  // normal MultiTable wiring — grok reads ~/.grok/auth.json itself.
  envOverlay?: Record<string, string>;
}

export class GrokAcpTransport extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, PendingRequest>();
  private notifHandlers = new Map<string, NotificationHandler>();
  private requestHandlers = new Map<string, ServerRequestHandler>();
  private closed = false;
  private exited = false;

  constructor(private readonly options: GrokTransportOptions = {}) {
    super();
  }

  start(): void {
    if (this.child) return;
    const grok = this.options.grokPath ?? 'grok';
    // `grok agent <agentArgs…> stdio <extraArgs…>` — spawn-time mode/effort/model
    // flags belong on the `agent` parent, before the `stdio` subcommand.
    const args = [
      'agent',
      ...(this.options.agentArgs ?? []),
      'stdio',
      ...(this.options.extraArgs ?? []),
    ];
    const env = { ...process.env, ...(this.options.envOverlay ?? {}) };
    const projectDir = this.options.cwd ?? process.cwd();

    const child = spawn(grok, args, {
      cwd: projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    this.child = child;
    this.exited = false;

    child.on('error', (err) => {
      this.failAllPending(err);
      this.emit('error', err);
    });

    child.on('exit', (code, signal) => {
      this.exited = true;
      this.failAllPending(new Error(`grok agent stdio exited (code=${code} signal=${signal})`));
      this.emit('exit', { code, signal });
    });

    this.rl = createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.onLine(line));

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      // Grok routes diagnostics to stderr; stdout is reserved for JSON-RPC
      // frames. Surface as warnings — useful for operator debugging, never
      // load-bearing.
      for (const line of text.split('\n')) {
        if (line.trim().length > 0) console.warn('[grok-acp]', line);
      }
    });
  }

  isAlive(): boolean {
    return this.child !== null && !this.exited;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      console.warn('[grok-acp] non-JSON stdout line dropped:', trimmed.slice(0, 200));
      return;
    }

    const hasId = 'id' in frame && (typeof frame.id === 'number' || typeof frame.id === 'string');
    const hasMethod = typeof frame.method === 'string';

    if (hasMethod && hasId) {
      void this.handleServerRequest(frame as unknown as RpcServerRequest);
      return;
    }
    if (hasMethod) {
      this.handleNotification(frame as unknown as RpcNotification);
      return;
    }
    if (hasId) {
      this.handleResponse(frame);
      return;
    }
    console.warn('[grok-acp] unrecognized frame dropped:', trimmed.slice(0, 200));
  }

  private handleResponse(frame: Record<string, unknown>): void {
    const id = frame.id as RpcId;
    const pending = this.pending.get(id);
    if (!pending) {
      // Grok occasionally emits response frames with string ids it didn't
      // receive from us (e.g. `skills-reload` self-RPCs). Harmless — drop.
      return;
    }
    this.pending.delete(id);
    if ('error' in frame && frame.error) {
      const err = frame.error as RpcError;
      const error = new Error(`${pending.method} failed: ${err.message ?? 'unknown error'}`);
      (error as Error & { code?: number; data?: unknown }).code = err.code;
      (error as Error & { code?: number; data?: unknown }).data = err.data;
      pending.reject(error);
      return;
    }
    pending.resolve(frame.result);
  }

  private handleNotification(frame: RpcNotification): void {
    const handler = this.notifHandlers.get(frame.method);
    if (handler) {
      try {
        handler(frame.params);
      } catch (err) {
        console.error('[grok-acp] notification handler threw:', frame.method, err);
      }
    }
    this.emit('notification', frame);
  }

  private async handleServerRequest(frame: RpcServerRequest): Promise<void> {
    const handler = this.requestHandlers.get(frame.method);
    if (!handler) {
      // ACP -32601: method_not_found. The agent logs but accepts our response
      // and continues for unknown methods.
      this.respond(frame.id, undefined, {
        code: -32601,
        message: `multitable has no handler registered for ${frame.method}`,
      });
      return;
    }
    try {
      const result = await Promise.resolve(handler(frame.params));
      this.respond(frame.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.respond(frame.id, undefined, { code: -32000, message });
    }
  }

  private respond(id: RpcId, result?: unknown, error?: RpcError): void {
    if (!this.child || this.exited) return;
    const frame: Record<string, unknown> = { jsonrpc: '2.0', id };
    if (error) frame.error = error;
    else frame.result = result ?? null;
    this.write(frame);
  }

  private write(frame: Record<string, unknown>): void {
    if (!this.child || this.exited) return;
    try {
      this.child.stdin.write(JSON.stringify(frame) + '\n');
    } catch (err) {
      console.error('[grok-acp] write failed', err);
    }
  }

  request<TRes = unknown>(method: string, params: unknown): Promise<TRes> {
    if (!this.child || this.exited) {
      return Promise.reject(new Error(`grok agent stdio is not running (method=${method})`));
    }
    const id = this.nextId++;
    return new Promise<TRes>((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (result) => resolve(result as TRes),
        reject,
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  on(method: string, handler: NotificationHandler): void;
  on(event: 'exit', handler: (info: { code: number | null; signal: string | null }) => void): this;
  on(event: 'error', handler: (err: Error) => void): this;
  on(event: 'notification', handler: (n: RpcNotification) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(eventOrMethod: string, handler: (...args: any[]) => void): this {
    if (eventOrMethod === 'exit' || eventOrMethod === 'error' || eventOrMethod === 'notification') {
      return super.on(eventOrMethod, handler);
    }
    this.notifHandlers.set(eventOrMethod, handler as NotificationHandler);
    return this;
  }

  onRequest(method: string, handler: ServerRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  private failAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      try {
        p.reject(err);
      } catch {
        /* ignore */
      }
    }
    this.pending.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.child) return;
    const child = this.child;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 2000);
    child.once('exit', () => clearTimeout(killTimer));
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}
