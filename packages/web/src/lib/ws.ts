import type { WsMessage } from './types';
import { useAppStore } from '../stores/appStore';

type MessageHandler = (msg: WsMessage) => void;

const MAX_RETRIES = 20;

class WsClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, MessageHandler[]> = new Map();
  private reconnectDelay = 1000;
  private subscribedProcess: string | null = null;
  private subscribedDims: { cols: number; rows: number } | null = null;
  private retryCount = 0;
  private hasConnectedBefore = false;

  connect(): void {
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
    // a hang.
    if (this.hasConnectedBefore) {
      useAppStore.getState().setConnectionState('reconnecting');
    }
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      const isReconnect = this.hasConnectedBefore;
      this.hasConnectedBefore = true;
      this.reconnectDelay = 1000;
      this.retryCount = 0;
      useAppStore.getState().setConnectionState('connected');

      // Notify listeners so they can re-fetch data after server restart
      if (isReconnect) {
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
        const handlers = this.handlers.get(msg.type) ?? [];
        handlers.forEach(h => h(msg));
        const allHandlers = this.handlers.get('*') ?? [];
        allHandlers.forEach(h => h(msg));
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.retryCount++;
      if (this.retryCount >= MAX_RETRIES) {
        useAppStore.getState().setConnectionState('disconnected');
        return;
      }
      useAppStore.getState().setConnectionState('reconnecting');
      setTimeout(() => {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        this.connect();
      }, this.reconnectDelay);
    };

    this.ws.onerror = () => {
      // onerror is always followed by onclose, so reconnect happens there
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
      this.ws.send(JSON.stringify(msg));
    } else {
      // Only surface when we had something meaningful to send — helps catch
      // cases where the socket dropped mid-interaction.
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
