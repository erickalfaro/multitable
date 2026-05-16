import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, Interface } from 'readline';
import { EventEmitter } from 'events';

// Line-delimited JSON-RPC 2.0 transport for `hermes acp` (a.k.a.
// `python -m acp_adapter.entry`). Hermes implements the standard Agent Client
// Protocol over stdio: one JSON object per line on both stdin and stdout.
//
// Three frame kinds we receive from the agent:
//   - response:           {jsonrpc, id, result | error}
//   - notification:       {jsonrpc, method, params}    (no id)
//   - server-request:     {jsonrpc, method, id, params} (we must respond)
//
// Hermes routes most user-relevant work through `session/update` notifications
// (assistant chunks, tool calls, plan updates) and a single `session/prompt`
// response that closes the turn. Server-requests cover permission prompts and
// the (optional) filesystem / terminal tool surface — we register handlers in
// client.ts.
//
// The transport doesn't know any ACP semantics — it only correlates ids and
// dispatches by method name. Higher-level routing (per-session fan-out,
// auto-handle approvals) lives in client.ts.

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

export interface HermesTransportOptions {
  // Path to the hermes binary. Defaults to 'hermes' on PATH.
  hermesPath?: string;
  // Extra CLI args injected after `acp`. Mostly for testing / version pinning.
  extraArgs?: string[];
  // Working directory for the child. Defaults to process.cwd(). Note that ACP
  // sessions carry their own per-session cwd; this is just the child's spawn
  // cwd (matters for relative paths in MCP server configs etc.).
  cwd?: string;
  // Extra env overlays on top of process.env. Used to pin the inference
  // provider (`HERMES_INFERENCE_PROVIDER=xai-oauth`) so the user's shell
  // defaults can't accidentally route turns to a different backend.
  envOverlay?: Record<string, string>;
}

export class HermesAcpTransport extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, PendingRequest>();
  private notifHandlers = new Map<string, NotificationHandler>();
  private requestHandlers = new Map<string, ServerRequestHandler>();
  private closed = false;
  private exited = false;

  constructor(private readonly options: HermesTransportOptions = {}) {
    super();
  }

  start(): void {
    if (this.child) return;
    const hermes = this.options.hermesPath ?? 'hermes';
    const args = ['acp', ...(this.options.extraArgs ?? [])];
    const env = { ...process.env, ...(this.options.envOverlay ?? {}) };
    const child = spawn(hermes, args, {
      cwd: this.options.cwd ?? process.cwd(),
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
      this.failAllPending(new Error(`hermes acp exited (code=${code} signal=${signal})`));
      this.emit('exit', { code, signal });
    });

    this.rl = createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.onLine(line));

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      // Hermes routes all logging to stderr by design (see acp_adapter/entry.py
      // _setup_logging); stdout is reserved for JSON-RPC frames. Surface as
      // warnings — useful for operator debugging, never load-bearing.
      for (const line of text.split('\n')) {
        if (line.trim().length > 0) console.warn('[hermes-acp]', line);
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
      console.warn('[hermes-acp] non-JSON stdout line dropped:', trimmed.slice(0, 200));
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
    console.warn('[hermes-acp] unrecognized frame dropped:', trimmed.slice(0, 200));
  }

  private handleResponse(frame: Record<string, unknown>): void {
    const id = frame.id as RpcId;
    const pending = this.pending.get(id);
    if (!pending) {
      console.warn('[hermes-acp] response for unknown id', id);
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
        console.error('[hermes-acp] notification handler threw:', frame.method, err);
      }
    }
    this.emit('notification', frame);
  }

  private async handleServerRequest(frame: RpcServerRequest): Promise<void> {
    const handler = this.requestHandlers.get(frame.method);
    if (!handler) {
      // ACP -32601: method_not_found. Hermes's own probe filter recognises this
      // for `ping`/`health` — for any other method it logs but accepts our
      // response and continues.
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
      console.error('[hermes-acp] write failed', err);
    }
  }

  request<TRes = unknown>(method: string, params: unknown): Promise<TRes> {
    if (!this.child || this.exited) {
      return Promise.reject(new Error(`hermes acp is not running (method=${method})`));
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
