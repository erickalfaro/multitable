import type { WsMessage } from './types';
import { useAppStore } from '../stores/appStore';
import { devLog, trimPreview } from './devLog';

type MessageHandler = (msg: WsMessage) => void;

const MAX_RETRIES = 20;

function previewWsMessage(msg: WsMessage): string {
  const parts: string[] = [];
  if (msg.processId) parts.push(`pid=${msg.processId.slice(0, 8)}`);
  if (msg.payload && typeof msg.payload === 'object') {
    try {
      const json = JSON.stringify(msg.payload);
      parts.push(trimPreview(json, 180));
    } catch {
      // ignore
    }
  }
  return parts.join(' ');
}

class WsClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, MessageHandler[]> = new Map();
  private reconnectDelay = 1000;
  private subscribedProcess: string | null = null;
  private subscribedDims: { cols: number; rows: number } | null = null;
  private retryCount = 0;
  private hasConnectedBefore = false;
  // True while the page is being suspended (pagehide / mobile background).
  // We intentionally close the socket so the browser can bfcache the page —
  // an open WebSocket is a known bfcache disqualifier. When `suspended` is
  // true, `onclose` skips the reconnect loop and `resume()` is the only path
  // back to a live connection. The next `onopen` after a resume emits a
  // `ws:resumed` event (not `ws:reconnected`) so listeners can do a
  // lightweight sync instead of a full data refetch.
  private suspended = false;
  private resumePending = false;

  connect(): void {
    // External callers (Retry button, resume) override suspend.
    this.suspended = false;
    // Idempotent: if a socket is already open or connecting, do nothing.
    // Prevents StrictMode's double-mount from opening two sockets that both
    // deliver every broadcast to the shared handler list.
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;

    // Only flip the banner for *re*connects. The first attempt should be
    // invisible — flashing "Reconnecting..." during normal mount feels like
    // a hang. A `resumePending` reconnect is also kept silent because the
    // socket only dropped because we asked it to (bfcache).
    if (this.hasConnectedBefore && !this.resumePending) {
      useAppStore.getState().setConnectionState('reconnecting');
    }
    devLog.add({ category: 'ws-conn', label: `connecting ${url}` });
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      const isReconnect = this.hasConnectedBefore;
      const isResume = this.resumePending;
      this.hasConnectedBefore = true;
      this.resumePending = false;
      this.reconnectDelay = 1000;
      this.retryCount = 0;
      useAppStore.getState().setConnectionState('connected');
      devLog.add({
        category: 'ws-conn',
        label: isResume ? 'resumed' : isReconnect ? 'reconnected' : 'connected',
      });

      // Resume (page bfcache restore / mobile foreground): lightweight signal
      // for listeners — they should sync active sessions but skip the full
      // projects/sessions/commands/terminals refetch since state is intact.
      // Reconnect (server restart): full reload signal.
      if (isResume) {
        const handlers = this.handlers.get('ws:resumed') ?? [];
        handlers.forEach(h => h({ type: 'ws:resumed', payload: {} } as WsMessage));
      } else if (isReconnect) {
        const handlers = this.handlers.get('ws:reconnected') ?? [];
        handlers.forEach(h => h({ type: 'ws:reconnected', payload: {} } as WsMessage));
      }

      if (this.subscribedProcess) {
        const payload = this.subscribedDims ? { cols: this.subscribedDims.cols, rows: this.subscribedDims.rows } : {};
        this.send({ type: 'subscribe', processId: this.subscribedProcess, payload });
      }
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data) as WsMessage;
        const isPty = msg.type === 'pty-output' || msg.type === 'scrollback';
        devLog.add({
          category: isPty ? 'ws-pty' : 'ws-in',
          label: msg.type,
          detail: previewWsMessage(msg),
          data: msg,
        });
        const handlers = this.handlers.get(msg.type) ?? [];
        handlers.forEach(h => h(msg));
        const allHandlers = this.handlers.get('*') ?? [];
        allHandlers.forEach(h => h(msg));
      } catch (err) {
        devLog.add({
          category: 'error',
          label: 'ws: malformed inbound message',
          detail: err instanceof Error ? err.message : String(err),
          data: { raw: typeof evt.data === 'string' ? trimPreview(evt.data, 400) : '<binary>' },
        });
      }
    };

    this.ws.onclose = (evt) => {
      // Intentional close for bfcache: do not retry, do not flip the banner.
      // resume() owns the next connection attempt.
      if (this.suspended) {
        devLog.add({
          category: 'ws-conn',
          label: `closed (suspended for bfcache, code=${evt.code})`,
        });
        return;
      }
      this.retryCount++;
      devLog.add({
        category: 'ws-conn',
        level: 'warn',
        label: `closed (code=${evt.code}${evt.reason ? `, ${evt.reason}` : ''})`,
        detail: `retry ${this.retryCount}/${MAX_RETRIES}`,
      });
      if (this.retryCount >= MAX_RETRIES) {
        useAppStore.getState().setConnectionState('disconnected');
        devLog.add({
          category: 'ws-conn',
          level: 'error',
          label: 'reconnect attempts exhausted',
        });
        return;
      }
      useAppStore.getState().setConnectionState('reconnecting');
      setTimeout(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        this.connect();
      }, this.reconnectDelay);
    };

    this.ws.onerror = () => {
      devLog.add({
        category: 'ws-conn',
        level: 'error',
        label: 'socket error',
      });
    };
  }

  on(type: string, handler: MessageHandler): () => void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
    return () => {
      this.handlers.set(
        type,
        (this.handlers.get(type) ?? []).filter(h => h !== handler)
      );
    };
  }

  send(msg: WsMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const isPtyInput = msg.type === 'pty-input';
      devLog.add({
        category: isPtyInput ? 'ws-pty' : 'ws-out',
        label: msg.type,
        detail: previewWsMessage(msg),
        data: msg,
      });
      this.ws.send(JSON.stringify(msg));
    } else {
      // Only surface when we had something meaningful to send — helps catch
      // cases where the socket dropped mid-interaction.
      devLog.add({
        category: 'ws-out',
        level: 'warn',
        label: `dropped ${msg.type}`,
        detail: `socket not open (readyState=${this.ws?.readyState})`,
        data: msg,
      });
      console.warn(`[ws] dropped message type=${msg.type} — socket not open (readyState=${this.ws?.readyState})`);
    }
  }

  subscribe(processId: string, dims?: { cols: number; rows: number }): void {
    this.subscribedProcess = processId;
    this.subscribedDims = dims ?? null;
    this.send({ type: 'subscribe', processId, payload: dims ? { cols: dims.cols, rows: dims.rows } : {} });
  }

  unsubscribe(processId: string): void {
    this.send({ type: 'unsubscribe', processId, payload: {} });
    if (this.subscribedProcess === processId) this.subscribedProcess = null;
  }

  sendInput(processId: string, data: string): void {
    this.send({ type: 'pty-input', processId, payload: { data } });
  }

  sendTurn(processId: string, text: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      useAppStore.getState().appendMessages(processId, [
        {
          id: `send-error-${Date.now()}`,
          ts: Date.now(),
          kind: 'system',
          text: 'Send failed: WebSocket is not connected.',
        },
      ]);
      console.warn(`[ws] dropped session turn — socket not open (readyState=${this.ws?.readyState})`);
      return;
    }
    useAppStore.getState().updateProcessState(processId, 'running');
    this.send({ type: 'session:send', processId, payload: { text } });
  }

  sendResize(processId: string, cols: number, rows: number): void {
    this.send({ type: 'pty-resize', processId, payload: { cols, rows } });
    // Cache latest dims so auto-resubscribe on reconnect uses the current size
    // rather than whatever dims were passed at initial subscribe.
    if (this.subscribedProcess === processId) {
      this.subscribedDims = { cols, rows };
    }
  }

  respondPermission(id: string, decision: 'allow' | 'deny' | 'always-allow'): void {
    this.send({ type: 'permission:respond', payload: { id, decision } });
  }

  answerQuestion(id: string, answers: string[][]): void {
    this.send({ type: 'permission:answer-question', payload: { id, answers } });
  }

  // Suspend the live connection so the page becomes bfcache-eligible.
  // Called from a `pagehide` listener — the browser refuses to bfcache pages
  // with an open WebSocket, so leaving the socket open forces a fresh load
  // when the user returns. Idempotent.
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    devLog.add({ category: 'ws-conn', label: 'suspending for bfcache' });
    const sock = this.ws;
    this.ws = null;
    if (sock) {
      try {
        sock.close(1000, 'suspend');
      } catch {
        // ignore — socket may already be in a terminal state
      }
    }
  }

  // Re-establish the live connection after a suspend. Called from
  // `pageshow` (or `visibilitychange` to visible on mobile). The next
  // `onopen` fires a `ws:resumed` event rather than `ws:reconnected` so
  // listeners can pick a lightweight sync path (no full refetch /
  // connection-overlay flash). Safe to call when not suspended.
  resume(): void {
    if (!this.suspended && this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    devLog.add({ category: 'ws-conn', label: 'resuming' });
    this.suspended = false;
    this.resumePending = true;
    this.connect();
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  respondElicitation(
    id: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, string | number | boolean | string[]>,
  ): void {
    this.send({
      type: 'session:elicitation:respond',
      payload: { id, action, content },
    });
  }
}

export const wsClient = new WsClient();
