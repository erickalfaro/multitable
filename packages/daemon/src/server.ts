import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs';
import type { GlobalConfig, WsClientState, WsMessage } from './types.js';
import type { PtyManager } from './pty/manager.js';
import type { PermissionManager } from './hooks/permissionManager.js';
import type { ElicitationManager } from './hooks/elicitationManager.js';
import type { AgentSessionManager } from './agent/manager.js';
import type { SessionAlert } from './agent/types.js';
import type { ElicitationPrompt } from './types.js';
import { handleWsMessage } from './pty/stream.js';
import { createProjectsRouter } from './api/projects.js';
import { createSessionsRouter } from './api/sessions.js';
import { createCommandsRouter } from './api/commands.js';
import { createProcessesRouter } from './api/processes.js';
import { createTerminalsRouter } from './api/terminals.js';
import { createConfigRouter } from './api/config.js';
import { createSearchRouter } from './api/search.js';
import { createTranscriptsRouter } from './api/transcripts.js';
import { createNotesRouter } from './api/notes.js';
import { createIntegrationsRouter } from './api/integrations.js';
import { createGitRouter } from './api/git.js';
import { createProvidersRouter } from './api/providers.js';
import type { TelegramBridge } from './notifications/telegramBridge.js';
import type { GitWatcher } from './git/watcher.js';
import { getSessionById } from './db/store.js';

export interface ServerInstance {
  app: express.Application;
  server: http.Server;
  wss: WebSocketServer;
  broadcast: (type: string, payload: any) => void;
  sendToSubscribers: (processId: string, type: string, payload: any) => void;
  closeAllClients: () => void;
}

export function createServer(
  config: GlobalConfig,
  manager: PtyManager,
  permManager: PermissionManager,
  agentManager: AgentSessionManager,
  elicitManager: ElicitationManager,
  tgBridge: TelegramBridge,
  gitWatcher: GitWatcher,
): ServerInstance {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Serve built React app if it exists
  const publicDir = path.join(__dirname, 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  // ─── Broadcast helpers ──────────────────────────────────────────────────────

  const clients = new Set<{ ws: WebSocket; state: WsClientState }>();

  function broadcast(type: string, payload: any): void {
    const msg = JSON.stringify({ type, payload });
    for (const { ws } of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch {}
      }
    }
  }

  // Like broadcast(), but puts processId at the WS top level so frontend
  // handlers that read `msg.processId` (the old sendToSubscribers contract)
  // keep working when an event is widened from per-subscriber to broadcast.
  function broadcastForProcess(processId: string, type: string, payload: any): void {
    const msg = JSON.stringify({ type, processId, payload });
    for (const { ws } of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch {}
      }
    }
  }

  function sendToSubscribers(processId: string, type: string, payload: any): void {
    const msg = JSON.stringify({ type, processId, payload });
    for (const { ws, state } of clients) {
      if (state.subscribedProcess === processId && ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch {}
      }
    }
  }

  // ─── Mount API routes ───────────────────────────────────────────────────────

  app.use('/api/projects', createProjectsRouter(manager, gitWatcher, agentManager));
  app.use('/api/sessions', createSessionsRouter(agentManager));
  app.use('/api/commands', createCommandsRouter(manager));
  app.use('/api/processes', createProcessesRouter(manager));
  app.use('/api/terminals', createTerminalsRouter(manager));
  app.use('/api/config', createConfigRouter());
  app.use('/api/search', createSearchRouter(manager));
  app.use('/api/transcripts', createTranscriptsRouter(agentManager));
  app.use('/api/notes', createNotesRouter());
  app.use('/api/integrations', createIntegrationsRouter(tgBridge, permManager, agentManager));
  app.use('/api/projects/:projectId/git', createGitRouter());
  app.use('/api/providers', createProvidersRouter({ getDaemonEnv: () => process.env }));

  // ─── Internal agent-turn endpoint (Phase 2) ────────────────────────────────
  //
  // Private, experimental: fires a single SDK-driven turn against an existing
  // session. Returns 202 immediately; turn progress streams via WS events.
  // Promoted to /api/sessions/:id/turn in Phase 4.
  app.post('/api/_internal/agent/turn', (req, res) => {
    const body = (req.body ?? {}) as { sessionId?: unknown; text?: unknown };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const text = typeof body.text === 'string' ? body.text : '';
    if (!sessionId || !text) {
      res.status(400).json({ error: 'sessionId and text required' });
      return;
    }

    // Auto-register on demand from the DB if the session isn't in memory yet.
    if (!agentManager.get(sessionId)) {
      const row = getSessionById(sessionId);
      if (!row) {
        res.status(404).json({ error: `session not found: ${sessionId}` });
        return;
      }
      agentManager.register({
        id: row.id,
        projectId: row.projectId,
        name: row.name,
        workingDir: row.workingDirectory || '',
        provider: row.agentProvider,
        model: row.model,
        agentSessionId: row.agentSessionId,
        agentSessionIdHistory: row.agentSessionIdHistory ?? [],
        claudeSessionId: row.claudeSessionId,
        claudeSessionIdHistory: row.claudeSessionIdHistory ?? [],
      });
    }

    try {
      // Do NOT await — the turn drives WS events as it progresses.
      void agentManager.sendTurn({ sessionId, text }).catch((err) => {
        console.error('[agent] sendTurn background error:', err);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(409).json({ error: message });
      return;
    }

    res.status(202).json({ ok: true, sessionId });
  });

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, pid: process.pid, uptime: process.uptime() });
  });

  // SPA fallback — only if public dir exists
  if (fs.existsSync(publicDir)) {
    app.get('*', (_req, res) => {
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  // ─── HTTP + WebSocket server ────────────────────────────────────────────────

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    const state: WsClientState = {
      subscribedProcess: null,
      cleanups: [],
      alive: true,
    };

    const clientEntry = { ws, state };
    clients.add(clientEntry);

    // Heartbeat ping/pong
    const pingInterval = setInterval(() => {
      if (!state.alive) {
        ws.terminate();
        return;
      }
      state.alive = false;
      try { ws.ping(); } catch {}
    }, 30000);

    ws.on('pong', () => {
      state.alive = true;
    });

    ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsMessage;
        handleWsMessage(state, msg, ws, manager, permManager, agentManager, elicitManager);
      } catch {}
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      for (const cleanup of state.cleanups) {
        try { cleanup(); } catch {}
      }
      clients.delete(clientEntry);
    });

    ws.on('error', () => {
      // ws error — will trigger close
    });
  });

  // ─── Wire manager events to WebSocket ──────────────────────────────────────

  // NOTE: pty-output is sent directly to the subscribed client in stream.ts's
  // handleSubscribe onData listener. Do NOT also broadcast here — that causes
  // every data event to be delivered twice.

  manager.on('state-changed', ({ processId, state: procState }: { processId: string; state: string }) => {
    broadcast('process-state-changed', { processId, state: procState });
  });

  manager.on('metrics', ({ processId, metrics }: { processId: string; metrics: any }) => {
    broadcast('process-metrics', { processId, ...metrics });
  });

  manager.on('exit', ({ processId, exitCode, signal }: { processId: string; exitCode: number; signal: number }) => {
    broadcast('process-exited', { processId, exitCode, signal });
  });

  // ─── Wire permission events ─────────────────────────────────────────────────

  permManager.on('permission:prompt', (prompt: any) => {
    broadcast('permission:prompt', { prompt });
  });

  permManager.on('permission:resolved', (id: string) => {
    broadcast('permission:resolved', { id });
  });

  permManager.on('permission:expired', (id: string) => {
    broadcast('permission:expired', { id });
  });

  // ─── Wire elicitation events ────────────────────────────────────────────────

  elicitManager.on('elicitation:prompt', (prompt: ElicitationPrompt) => {
    broadcast('session:elicitation:prompt', { prompt });
  });

  elicitManager.on('elicitation:resolved', (id: string) => {
    broadcast('session:elicitation:resolved', { id });
  });

  elicitManager.on('elicitation:expired', (id: string) => {
    broadcast('session:elicitation:expired', { id });
  });

  // ─── Wire agent session events ──────────────────────────────────────────────
  //
  // `state-changed` shares the global `process-state-changed` event shape with
  // PTY-managed processes so the frontend treats all three process types the
  // same. Per-turn message events go only to the subscribed client.

  agentManager.on('state-changed', ({ sessionId, state }: { sessionId: string; state: string }) => {
    broadcast('process-state-changed', { processId: sessionId, state });
  });

  agentManager.on('session-updated', ({ sessionId }: { sessionId: string; claudeSessionId: string }) => {
    const session = getSessionById(sessionId);
    if (session) {
      broadcast('session:updated', { session });
    }
  });

  // Session events are session-id-keyed in their payload, so broadcasting is
  // safe — the frontend store filters by id. Broadcasting (rather than
  // sendToSubscribers) is essential: a user who sends a message to session A
  // and immediately switches to session B would otherwise miss every event
  // for A — chat updates, "Claude is done" toast, error toast, final cost
  // — because their client unsubscribed when they navigated away. The
  // sendToSubscribers pattern is a holdover from the PTY days where each
  // terminal's raw bytes only made sense for the viewing client.
  agentManager.on('assistant-message', ({ sessionId, messages }: { sessionId: string; messages: any[] }) => {
    broadcastForProcess(sessionId, 'session:assistant-message', { messages });
  });

  agentManager.on('assistant-delta', ({ sessionId, text }: { sessionId: string; text: string }) => {
    broadcastForProcess(sessionId, 'session:assistant-delta', { text });
  });

  // Live in-progress tool snapshot — codex emits item.updated as a command's
  // stdout grows, a patch applies, an mcp tool runs, etc. Forwarded straight
  // to the chat UI as a transient "tool currently running" preview that gets
  // replaced by the canonical tool_use card the moment item.completed lands.
  agentManager.on(
    'tool-delta',
    ({ sessionId, payload }: { sessionId: string; payload: unknown }) => {
      broadcastForProcess(sessionId, 'session:tool-delta', { payload });
    },
  );

  // Live model reasoning text — italic preview while the agent thinks.
  agentManager.on(
    'reasoning-delta',
    ({ sessionId, text }: { sessionId: string; text: string }) => {
      broadcastForProcess(sessionId, 'session:reasoning-delta', { text });
    },
  );

  agentManager.on('user-message', ({ sessionId, messages }: { sessionId: string; messages: any[] }) => {
    broadcastForProcess(sessionId, 'session:user-message', { messages });
  });

  agentManager.on('tool-event', ({ sessionId, messages }: { sessionId: string; messages: any[] }) => {
    broadcastForProcess(sessionId, 'session:tool-event', { messages });
  });

  agentManager.on('turn-result', (payload: { sessionId: string; subtype: string; totalCostUsd: number; usage: any; text: string | null }) => {
    const { sessionId, ...rest } = payload;
    broadcastForProcess(sessionId, 'session:turn-result', rest);
  });

  agentManager.on('turn-error', ({ sessionId, error }: { sessionId: string; error: string }) => {
    broadcastForProcess(sessionId, 'session:turn-error', { message: error });
  });

  agentManager.on('turn-complete', ({ sessionId }: { sessionId: string }) => {
    broadcastForProcess(sessionId, 'session:turn-complete', {});
  });

  // Daemon just diffed in-memory s.messages against its on-disk JSONL and
  // broadcast any items the live event stream missed. Frontend uses this as
  // the canonical "now is the right moment to REST-sync" tick.
  agentManager.on(
    'reconciled',
    ({ sessionId, addedMessageIds }: { sessionId: string; addedMessageIds: string[] }) => {
      broadcastForProcess(sessionId, 'session:reconciled', { addedMessageIds });
    },
  );

  // Optimistic message id → canonical id swap. Frontend updates the existing
  // message in messagesBySession in place; no add, no remove. Avoids the
  // optimistic-vs-canonical duplicate that would otherwise need brittle
  // text-based dedup heuristics.
  agentManager.on(
    'message-rekeyed',
    ({ sessionId, oldId, newId }: { sessionId: string; oldId: string; newId: string }) => {
      broadcastForProcess(sessionId, 'session:message-rekeyed', { oldId, newId });
    },
  );

  // Hook-driven state propagation (Phase 6: replaces the HTTP receiver).
  agentManager.on('state-snapshot', ({ sessionId, snapshot }: { sessionId: string; snapshot: any }) => {
    broadcast('session:state-updated', { sessionId, state: snapshot });
  });

  agentManager.on('options-detected', ({ sessionId, options }: { sessionId: string; options: any }) => {
    broadcast('session:options-detected', { sessionId, options });
  });

  agentManager.on('notification', ({ sessionId, payload }: { sessionId: string; payload: any }) => {
    broadcast('session:notification', { sessionId, payload });
  });

  agentManager.on('session-ended', ({ sessionId }: { sessionId: string }) => {
    broadcast('session:ended', { sessionId });
  });

  agentManager.on('session-renamed', ({ sessionId }: { sessionId: string }) => {
    const session = getSessionById(sessionId);
    if (session) broadcast('session:updated', { session });
  });

  // Unified alert envelope. Broadcast (not sendToSubscribers) so unread badges
  // on non-focused sessions still tick over in the sidebar. Frontend filters
  // toast/OS-notif suppression based on the focused session.
  agentManager.on('alert', ({ alert }: { alert: SessionAlert }) => {
    broadcast('session:alert', { alert });
  });

  // Phase 5 informational events. Broadcast (not sendToSubscribers) so the
  // Tasks tab + status spinner + tool-progress pill stay accurate when the
  // user navigates away mid-turn and comes back.
  agentManager.on('status', (payload: { sessionId: string; status: string | null }) => {
    const { sessionId, ...rest } = payload;
    broadcastForProcess(sessionId, 'session:status', rest);
  });

  agentManager.on('task-event', (payload: { sessionId: string; subtype: string; payload: any }) => {
    const { sessionId, ...rest } = payload;
    broadcastForProcess(sessionId, 'session:task-event', rest);
  });

  agentManager.on('tool-progress', (payload: { sessionId: string }) => {
    const { sessionId, ...rest } = payload;
    broadcastForProcess(sessionId, 'session:tool-progress', rest);
  });

  function closeAllClients(): void {
    for (const { ws } of clients) {
      try { ws.terminate(); } catch {}
    }
    clients.clear();
  }

  return { app, server, wss, broadcast, sendToSubscribers, closeAllClients };
}
