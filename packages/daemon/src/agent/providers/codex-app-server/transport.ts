import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, Interface } from 'readline';
import { EventEmitter } from 'events';

// Line-delimited JSON-RPC transport for `codex app-server --listen stdio://`.
//
// Wire format (verified against codex-cli 0.128.0): one JSON object per line on
// both stdin and stdout. The server omits `jsonrpc: "2.0"` in its outbound
// frames but accepts it on inbound — we send it for clarity.
//
// Three frame kinds we receive from the server:
//   - response:           {id, result}        or {id, error}
//   - notification:       {method, params}    (no id)
//   - server-request:     {method, id, params} (we must respond)
//
// The transport doesn't know about Codex semantics — it only correlates ids
// and dispatches by method name. Higher-level routing (per-thread subscribers,
// auto-deny approvals) lives in client.ts.

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

export interface TransportOptions {
  // Path to the codex binary. Defaults to 'codex' on PATH.
  codexPath?: string;
  // Extra CLI args injected after `app-server`. Mostly for testing.
  extraArgs?: string[];
  // Working directory for the child. Defaults to process.cwd().
  cwd?: string;
}

export class CodexAppServerTransport extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, PendingRequest>();
  private notifHandlers = new Map<string, NotificationHandler>();
  private requestHandlers = new Map<string, ServerRequestHandler>();
  private closed = false;
  private exited = false;

  constructor(private readonly options: TransportOptions = {}) {
    super();
  }

  start(): void {
    if (this.child) return;
    const codex = this.options.codexPath ?? 'codex';
    const args = ['app-server', '--listen', 'stdio://', ...(this.options.extraArgs ?? [])];
    const child = spawn(codex, args, {
      cwd: this.options.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child = child;
    this.exited = false;

    child.on('error', (err) => {
      // Spawn failure (e.g. ENOENT). Surfaces as one rejection per pending
      // request, plus a synthesized exit so client.ts can decide whether to
      // retry or report.
      this.failAllPending(err);
      this.emit('error', err);
    });

    child.on('exit', (code, signal) => {
      this.exited = true;
      this.failAllPending(new Error(`codex app-server exited (code=${code} signal=${signal})`));
      this.emit('exit', { code, signal });
    });

    this.rl = createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.onLine(line));

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      // Codex emits its own structured tracing on stderr. Surface as warnings —
      // useful for operator debugging, never load-bearing.
      for (const line of text.split('\n')) {
        if (line.trim().length > 0) console.warn('[codex-app-server]', line);
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
    } catch (err) {
      console.warn('[codex-app-server] non-JSON stdout line dropped:', trimmed.slice(0, 200));
      return;
    }

    // Disambiguate: response (has id, no method) vs server-request (has both)
    // vs notification (has method, no id).
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
    console.warn('[codex-app-server] unrecognized frame dropped:', trimmed.slice(0, 200));
  }

  private handleResponse(frame: Record<string, unknown>): void {
    const id = frame.id as RpcId;
    const pending = this.pending.get(id);
    if (!pending) {
      console.warn('[codex-app-server] response for unknown id', id);
      return;
    }
    this.pending.delete(id);
    if ('error' in frame && frame.error) {
      const err = frame.error as RpcError;
      pending.reject(new Error(`${pending.method} failed: ${err.message ?? 'unknown error'}`));
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
        console.error('[codex-app-server] notification handler threw:', frame.method, err);
      }
    }
    // Always re-emit on the EventEmitter so client.ts's per-thread fan-out can
    // see every notification regardless of typed handler registration.
    this.emit('notification', frame);
  }

  private async handleServerRequest(frame: RpcServerRequest): Promise<void> {
    const handler = this.requestHandlers.get(frame.method);
    if (!handler) {
      // Defensive: if we forgot to register a handler, error back so the
      // server doesn't hang on its side.
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
      console.error('[codex-app-server] write failed', err);
    }
  }

  request<TRes = unknown>(method: string, params: unknown): Promise<TRes> {
    if (!this.child || this.exited) {
      return Promise.reject(new Error(`codex app-server is not running (method=${method})`));
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
    // Force-kill if it hasn't exited cleanly within 2s.
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
