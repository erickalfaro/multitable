import type { WsClientState, WsMessage, ProcessConfig, SpawnConfig } from '../types.js';
import type { WebSocket } from 'ws';
import type { PtyManager } from './manager.js';
import type { PermissionManager } from '../hooks/permissionManager.js';
import type { ElicitationManager, ElicitAction, ElicitResponseContent } from '../hooks/elicitationManager.js';
import type { AgentSessionManager } from '../agent/manager.js';
import { getCommandById, getTerminalById, getSessionById } from '../db/store.js';

function defaultProcessConfig(overrides?: Partial<ProcessConfig>): ProcessConfig {
  return {
    autostart: false,
    autorestart: false,
    autorestartMax: 5,
    autorestartDelayMs: 2000,
    autorestartWindowSecs: 60,
    autorespawn: true,
    terminalAlerts: false,
    fileWatchPatterns: [],
    ...overrides,
  };
}

export function handleWsMessage(
  clientState: WsClientState,
  msg: WsMessage,
  ws: WebSocket,
  manager: PtyManager,
  permManager: PermissionManager,
  agentManager: AgentSessionManager,
  elicitManager: ElicitationManager
): void {
  switch (msg.type) {
    case 'subscribe':
      handleSubscribe(clientState, msg, ws, manager, agentManager);
      break;
    case 'unsubscribe':
      handleUnsubscribe(clientState);
      break;
    case 'pty-input':
      handlePtyInput(msg, manager, agentManager);
      break;
    case 'pty-resize':
      handlePtyResize(msg, manager, agentManager);
      break;
    case 'session:send':
      handleSessionSend(msg, agentManager, ws);
      break;
    case 'permission:respond':
      handlePermissionRespond(msg, permManager);
      break;
    case 'permission:answer-question':
      handleAnswerQuestion(msg, permManager);
      break;
    case 'session:elicitation:respond':
      handleElicitationRespond(msg, elicitManager);
      break;
    case 'option:dismiss': {
      const sid = msg.payload?.sessionId;
      if (typeof sid === 'string' && sid) agentManager.clearDetectedOptions(sid);
      break;
    }
    default:
      // Unknown message type — ignore
      break;
  }
}

function handleSubscribe(
  clientState: WsClientState,
  msg: WsMessage,
  ws: WebSocket,
  manager: PtyManager,
  agentManager: AgentSessionManager
): void {
  // Clean up any existing subscriptions
  for (const cleanup of clientState.cleanups) {
    try { cleanup(); } catch {}
  }
  clientState.cleanups = [];

  const processId = msg.processId || (msg.payload && msg.payload.processId);
  if (!processId) return;

  clientState.subscribedProcess = processId;

  // Sessions are managed by AgentSessionManager, NOT PtyManager. They never
  // spawn a child process. If the id corresponds to a registered session,
  // emit current state and return — the client already receives agent events
  // via sendToSubscribers wired globally in server.ts (matched by
  // clientState.subscribedProcess).
  let agentSession = agentManager.get(processId);
  if (!agentSession) {
    // Auto-register on demand: the session may have been created after boot
    // or this client may have raced the boot registration loop. If the row
    // exists in the DB and isn't a command/terminal, register it now.
    const row = getSessionById(processId);
    if (row) {
      agentSession = agentManager.register({
        id: row.id,
        projectId: row.projectId,
        name: row.name,
        workingDir: row.workingDirectory || '',
        provider: row.agentProvider,
        model: row.model,
        mode: row.mode,
        thinkingEffort: row.thinkingEffort,
        agentSessionId: row.agentSessionId ?? null,
        agentSessionIdHistory: row.agentSessionIdHistory ?? [],
        claudeSessionId: row.claudeSessionId ?? null,
        claudeSessionIdHistory: row.claudeSessionIdHistory ?? [],
      });
    }
  }
  if (agentSession) {
    ws.send(JSON.stringify({
      type: 'process-state-changed',
      processId,
      payload: { state: agentSession.state },
    }));
    return;
  }

  const cols = msg.payload?.cols ?? 80;
  const rows = msg.payload?.rows ?? 24;

  // Try to respawn if dead and autorespawn is enabled
  let proc = manager.respawnIfDead(processId, cols, rows);

  // If not in PtyManager at all, look up in DB and spawn (commands/terminals only)
  if (!proc) {
    const cmd = getCommandById(processId);
    if (cmd) {
      const spawnCfg: SpawnConfig = {
        id: cmd.id,
        name: cmd.name,
        command: cmd.command,
        workingDir: cmd.workingDirectory || '',
        type: 'command',
        projectId: cmd.projectId,
        config: defaultProcessConfig({ autorestart: cmd.autorestart }),
        cols,
        rows,
      };
      try {
        proc = manager.spawn(spawnCfg);
      } catch { /* spawn failed */ }
    }
    if (!proc) {
      const term = getTerminalById(processId);
      if (term) {
        const termShell = term.shell || process.env.SHELL || 'bash';
        const spawnCfg: SpawnConfig = {
          id: term.id,
          name: term.name,
          command: termShell,
          workingDir: term.workingDirectory || '',
          type: 'terminal',
          projectId: term.projectId,
          config: defaultProcessConfig({ autorespawn: false }),
          cols,
          rows,
        };
        try {
          proc = manager.spawn(spawnCfg);
        } catch { /* spawn failed */ }
      }
    }
  }

  if (!proc) {
    ws.send(JSON.stringify({ type: 'error', payload: { message: `Process ${processId} not found` } }));
    return;
  }

  // Resize PTY to match client dimensions (process may have been spawned at different size)
  if (proc.state === 'running' && proc.pty) {
    manager.resize(processId, cols, rows);
  }

  // Send scrollback
  try {
    const scrollback = proc.outputBuffer.read();
    ws.send(JSON.stringify({
      type: 'scrollback',
      processId,
      payload: { data: scrollback },
    }));
  } catch {}

  // Send current state
  ws.send(JSON.stringify({
    type: 'process-state-changed',
    processId,
    payload: { state: proc.state },
  }));

  // Register data listener
  const onData = ({ processId: pid, data }: { processId: string; data: string }) => {
    if (pid !== processId) return;
    if (ws.readyState !== 1 /* OPEN */) return;
    try {
      ws.send(JSON.stringify({ type: 'pty-output', processId, payload: { data } }));
    } catch {}
  };

  // NOTE: exit/state-changed events are already broadcast to ALL clients by
  // server.ts via manager.on('state-changed') and manager.on('exit').
  // A previous version sent a duplicate process-state-changed here with
  // { exitCode, signal } but no `state` field, which clobbered the frontend
  // process state to undefined — causing blank-screen bugs after stop/restart.

  manager.on('data', onData);

  clientState.cleanups.push(() => {
    manager.off('data', onData);
  });
}

function handleUnsubscribe(clientState: WsClientState): void {
  for (const cleanup of clientState.cleanups) {
    try { cleanup(); } catch {}
  }
  clientState.cleanups = [];
  clientState.subscribedProcess = null;
}

function handlePtyInput(
  msg: WsMessage,
  manager: PtyManager,
  agentManager: AgentSessionManager
): void {
  const processId = msg.processId || msg.payload?.processId;
  const data = msg.payload?.data;
  if (!processId || data === undefined) return;
  // Sessions don't have a PTY — silently drop. Stale frontend code occasionally
  // emits stray bytes (e.g. carriage returns from a TUI composer) that would
  // otherwise hit a non-existent PTY here.
  if (agentManager.get(processId)) return;
  manager.write(processId, data);
}

function handlePtyResize(
  msg: WsMessage,
  manager: PtyManager,
  agentManager: AgentSessionManager
): void {
  const processId = msg.processId || msg.payload?.processId;
  const { cols, rows } = msg.payload || {};
  if (!processId || !cols || !rows) return;
  // Resize is meaningless for a session — silently drop.
  if (agentManager.get(processId)) return;
  manager.resize(processId, cols, rows);
}

function handleSessionSend(msg: WsMessage, agentManager: AgentSessionManager, ws: WebSocket): void {
  const processId = msg.processId || msg.payload?.processId;
  const text = msg.payload?.text;
  if (!processId || typeof text !== 'string' || !text.trim()) return;
  // Auto-register on demand. Sessions created via the UI after boot, or hit
  // before the boot registration loop completes, won't be in the manager yet.
  // Look them up from the DB and register before sending — mirrors the
  // /api/_internal/agent/turn REST handler.
  if (!agentManager.get(processId)) {
    const row = getSessionById(processId);
    if (!row) {
      try {
        ws.send(JSON.stringify({
          type: 'session:send-error',
          processId,
          payload: { message: `session not found: ${processId}` },
        }));
      } catch {}
      return;
    }
    agentManager.register({
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      workingDir: row.workingDirectory || '',
      provider: row.agentProvider,
      model: row.model,
      mode: row.mode,
      thinkingEffort: row.thinkingEffort,
      agentSessionId: row.agentSessionId ?? null,
      agentSessionIdHistory: row.agentSessionIdHistory ?? [],
      claudeSessionId: row.claudeSessionId ?? null,
      claudeSessionIdHistory: row.claudeSessionIdHistory ?? [],
    });
  }
  agentManager.sendTurn({ sessionId: processId, text }).catch((err: any) => {
    try {
      ws.send(JSON.stringify({
        type: 'session:send-error',
        processId,
        payload: { message: err?.message ?? String(err) },
      }));
    } catch {}
  });
}

function handlePermissionRespond(msg: WsMessage, permManager: PermissionManager): void {
  const { id, decision, updatedInput } = msg.payload || {};
  if (!id) return;
  const normalized: 'allow' | 'deny' | 'always-allow' =
    decision === 'allow' || decision === 'deny' || decision === 'always-allow'
      ? decision
      : 'deny';
  permManager.respond(id, normalized, updatedInput);
}

function handleElicitationRespond(msg: WsMessage, elicitManager: ElicitationManager): void {
  const { id, action, content } = msg.payload || {};
  if (typeof id !== 'string' || !id) return;
  const validAction: ElicitAction =
    action === 'accept' || action === 'decline' || action === 'cancel' ? action : 'cancel';
  // Only accept content if it's a plain object; trust the client to have run
  // its own JSON-Schema validation, but discard non-object payloads.
  const responseContent: ElicitResponseContent | undefined =
    content && typeof content === 'object' && !Array.isArray(content) ? content : undefined;
  elicitManager.respond(id, validAction, responseContent);
}

function handleAnswerQuestion(msg: WsMessage, permManager: PermissionManager): void {
  const { id, answers } = msg.payload || {};
  if (!id || !Array.isArray(answers)) return;
  const sanitized: string[][] = answers.map((a: unknown) =>
    Array.isArray(a) ? a.filter((s): s is string => typeof s === 'string') : []
  );
  permManager.respondAskQuestion(id, sanitized);
}
