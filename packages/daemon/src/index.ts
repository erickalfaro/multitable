#!/usr/bin/env node
import { loadGlobalConfig } from './config/loader.js';
import { initDb, getAllProjects, getSessionsByProject, getCommandsByProject } from './db/store.js';
import { PtyManager } from './pty/manager.js';
import { PermissionManager } from './hooks/permissionManager.js';
import { ElicitationManager } from './hooks/elicitationManager.js';
import { AgentSessionManager } from './agent/manager.js';
import { FileWatcher } from './watcher/index.js';
import { GitWatcher } from './git/watcher.js';
import { createServer } from './server.js';
import { checkOrphanedPids } from './pids.js';
import { loadProjectConfig } from './config/loader.js';
import { TelegramBridge } from './notifications/telegramBridge.js';
import { getTelegramToken } from './config/secrets.js';
import type { SpawnConfig, ProcessConfig } from './types.js';

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

// Chokidar 3.6 has a known race in `setFsWatchListener` (nodefs-handler.js:159)
// where attaching a watch to a file that's been atomically rewritten/deleted
// throws `Cannot read properties of undefined (reading 'close')`. The error
// is harmless — chokidar recovers and the watcher keeps working — but it
// surfaces as an unhandled rejection and spams the daemon log. We swallow
// just this one pattern; everything else still bubbles up.
//
// Heavy editor activity in the watched project (HMR cache invalidations,
// `git stash`, `npm install`) is the usual trigger. A clean fix requires
// chokidar 4.x.
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  if (
    /chokidar\/lib\/nodefs-handler\.js/.test(msg) &&
    /Cannot read properties of undefined \(reading 'close'\)/.test(msg)
  ) {
    return; // known harmless chokidar 3.6 race
  }
  console.error('[daemon] Unhandled rejection:', reason);
});

async function main() {
  console.log('Starting MultiTable daemon...');

  // 1. Load global config
  const config = loadGlobalConfig();

  // 2. Check pids.json for orphaned processes
  const orphans = checkOrphanedPids();
  if (orphans.length > 0) {
    console.log(`Found ${orphans.length} orphaned process(es):`);
    for (const o of orphans) {
      console.log(`  processId=${o.processId} pid=${o.pid}`);
    }
  }

  // 3. Init db store
  initDb();
  console.log('Database initialized.');

  // 4. Create PtyManager and PermissionManager
  const manager = new PtyManager();
  const permManager = new PermissionManager();
  const elicitManager = new ElicitationManager();
  const agentManager = new AgentSessionManager(permManager, elicitManager);

  // Configure permission manager from project configs
  for (const projRef of config.projects) {
    const projConfig = loadProjectConfig(projRef.path);
    if (projConfig?.permissions?.auto_defer) {
      permManager.setAutoDeferTools(projConfig.permissions.auto_defer);
    }
  }

  // 5a. Telegram bridge — second channel for permission prompts and alerts.
  // Token comes from MULTITABLE_TELEGRAM_BOT_TOKEN env var (preferred) or
  // ~/.config/multitable/secrets.yml. Chat allowlist + per-category toggles
  // live in config.integrations.telegram and are editable from the GUI.
  // start() is a no-op when token or chatIds are missing.
  const tgConfig = config.integrations?.telegram ?? {};
  const tgBridge = new TelegramBridge({
    token: getTelegramToken(),
    chatIds: Array.isArray(tgConfig.chatIds) ? tgConfig.chatIds : [],
    sendNotifications: tgConfig.sendNotifications !== false,
    sendAlerts: tgConfig.sendAlerts !== false,
    dashboardUrl: typeof tgConfig.dashboardUrl === 'string' ? tgConfig.dashboardUrl : '',
    permManager,
    agentManager,
  });

  // 5b. Construct the GitWatcher before the server so the projects router can
  // hold a reference. We give it a placeholder broadcaster — `setBroadcaster`
  // could be cleaner, but the simplest fix is to declare the broadcast hook
  // up front; it's reassigned just below once `serverInstance` exists.
  // eslint-disable-next-line prefer-const
  let broadcastRef: (type: string, payload: unknown) => void = () => {};
  const fileWatcher = new FileWatcher();
  const gitWatcher = new GitWatcher((projectId, status) => {
    broadcastRef('git:status-changed', { projectId, status });
  });

  // 5c. Express/WS server (mounts /api/integrations using the bridge above).
  const serverInstance = createServer(
    config,
    manager,
    permManager,
    agentManager,
    elicitManager,
    tgBridge,
    gitWatcher,
  );
  const { server, broadcast } = serverInstance;
  broadcastRef = broadcast;
  tgBridge.start();

  // 7. Load projects from DB, start autostart processes
  const projects = getAllProjects();

  for (const project of projects) {
    const sessions = getSessionsByProject(project.id);
    const commands = getCommandsByProject(project.id);

    // Watch mt.yml for changes
    fileWatcher.watchMtYml(project.path, () => {
      console.log(`mt.yml changed for project: ${project.name}`);
      broadcast('project:config-changed', { projectId: project.id });
    });

    // Watch the working tree for git status changes (skipped if not a repo).
    gitWatcher.watch(project.id, project.path);

    // Register sessions with the agent manager. Sessions are no longer spawned
    // as PTY children; the SDK owns their lifecycle. "Autostart" has no meaning
    // for an agent session — sending a turn is what "starts" work. File-watch
    // restart also doesn't apply (we don't restart a conversation on file
    // change). Both concepts are commands-only now.
    for (const session of sessions) {
      agentManager.register({
        id: session.id,
        projectId: project.id,
        name: session.name,
        workingDir: session.workingDirectory || project.path,
        provider: session.agentProvider,
        model: session.model,
        mode: session.mode,
        agentSessionId: session.agentSessionId ?? null,
        agentSessionIdHistory: session.agentSessionIdHistory ?? [],
        claudeSessionId: session.claudeSessionId ?? null,
        claudeSessionIdHistory: session.claudeSessionIdHistory ?? [],
      });
      console.log(`Registered session: ${session.name} (${session.id})`);
    }

    // Start autostart commands
    for (const cmd of commands) {
      if (cmd.autostart) {
        try {
          const spawnCfg: SpawnConfig = {
            id: cmd.id,
            name: cmd.name,
            command: cmd.command,
            workingDir: cmd.workingDirectory || project.path,
            type: 'command',
            projectId: project.id,
            config: defaultProcessConfig({
              autostart: cmd.autostart,
              autorestart: cmd.autorestart,
              autorestartMax: cmd.autorestartMax,
              autorestartDelayMs: cmd.autorestartDelayMs,
              autorestartWindowSecs: cmd.autorestartWindowSecs,
              terminalAlerts: cmd.terminalAlerts,
              fileWatchPatterns: cmd.fileWatchPatterns,
            }),
          };
          manager.spawn(spawnCfg);
          console.log(`Autostarted command: ${cmd.name} (${cmd.id})`);
        } catch (err) {
          console.error(`Failed to autostart command ${cmd.name}:`, err);
        }
      }

      if (cmd.fileWatchPatterns.length > 0) {
        fileWatcher.watchPatterns(cmd.id, cmd.fileWatchPatterns, cmd.workingDirectory || project.path, () => {
          console.log(`File change detected, restarting command: ${cmd.name}`);
          manager.restart(cmd.id);
        });
      }
    }
  }

  // 9. Listen on host:port
  server.listen(config.port, config.host, () => {
    console.log(`MultiTable daemon running at http://${config.host}:${config.port}`);
    console.log(`WebSocket endpoint: ws://${config.host}:${config.port}/ws`);
  });

  // 10. Graceful shutdown — idempotent, force exits within 2s
  let shuttingDown = false;
  function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down...`);
    setTimeout(() => process.exit(0), 2000);
    fileWatcher.unwatchAll();
    gitWatcher.unwatchAll();
    manager.destroy();
    void agentManager.shutdown();
    serverInstance.closeAllClients();
    void tgBridge.stop();
    server.close(() => process.exit(0));
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
  });
}

main().catch((err) => {
  console.error('Fatal error starting daemon:', err);
  process.exit(1);
});
