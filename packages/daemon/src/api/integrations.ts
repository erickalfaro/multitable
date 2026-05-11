import { Router } from 'express';
import type { Request, Response } from 'express';
import { loadGlobalConfig, saveGlobalConfig } from '../config/loader.js';
import {
  getTelegramToken,
  hasTelegramToken,
  isTelegramTokenFromEnv,
  setTelegramToken,
} from '../config/secrets.js';
import type { TelegramBridge } from '../notifications/telegramBridge.js';
import type { AgentSessionManager } from '../agent/manager.js';
import type { PermissionManager } from '../hooks/permissionManager.js';

interface TelegramSettingsView {
  hasToken: boolean;
  tokenSource: 'env' | 'file' | 'none';
  chatIds: number[];
  sendNotifications: boolean;
  sendAlerts: boolean;
  dashboardUrl: string;
  running: boolean;
}

interface TelegramSettingsUpdate {
  token?: string | null; // string => set, null => clear, undefined => leave
  chatIds?: number[];
  sendNotifications?: boolean;
  sendAlerts?: boolean;
  dashboardUrl?: string;
}

function buildView(bridge: TelegramBridge): TelegramSettingsView {
  const config = loadGlobalConfig();
  const tg = config.integrations?.telegram ?? {};
  return {
    hasToken: hasTelegramToken(),
    tokenSource: isTelegramTokenFromEnv() ? 'env' : hasTelegramToken() ? 'file' : 'none',
    chatIds: Array.isArray(tg.chatIds) ? tg.chatIds : [],
    sendNotifications: tg.sendNotifications !== false,
    sendAlerts: tg.sendAlerts !== false,
    dashboardUrl: typeof tg.dashboardUrl === 'string' ? tg.dashboardUrl : '',
    running: bridge.isRunning(),
  };
}

export function createIntegrationsRouter(
  bridge: TelegramBridge,
  permManager: PermissionManager,
  agentManager: AgentSessionManager,
): Router {
  const router = Router();

  router.get('/telegram', (_req: Request, res: Response) => {
    try {
      res.json(buildView(bridge));
    } catch (err) {
      res.status(500).json({ error: 'Failed to load telegram settings' });
    }
  });

  router.put('/telegram', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as TelegramSettingsUpdate;

      // Token: env wins; refuse to write the file when an env token is set
      // because the file would be silently shadowed and confuse later reads.
      if (body.token !== undefined) {
        if (isTelegramTokenFromEnv()) {
          return res.status(409).json({
            error:
              'Token is set via MULTITABLE_TELEGRAM_BOT_TOKEN environment variable. Unset the env var to manage the token from the UI.',
          });
        }
        if (body.token === null || body.token === '') {
          setTelegramToken(null);
        } else if (typeof body.token === 'string') {
          const trimmed = body.token.trim();
          if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
            return res.status(400).json({ error: 'Token does not look like a Telegram bot token (expected "<digits>:<letters>")' });
          }
          setTelegramToken(trimmed);
        }
      }

      // Persist non-secret fields to config.yml under integrations.telegram.
      const config = loadGlobalConfig();
      const current = config.integrations?.telegram ?? {};
      const next = { ...current };
      if (body.chatIds !== undefined) {
        if (!Array.isArray(body.chatIds) || !body.chatIds.every((n) => Number.isFinite(n))) {
          return res.status(400).json({ error: 'chatIds must be an array of numbers' });
        }
        next.chatIds = body.chatIds;
      }
      if (body.sendNotifications !== undefined) next.sendNotifications = Boolean(body.sendNotifications);
      if (body.sendAlerts !== undefined) next.sendAlerts = Boolean(body.sendAlerts);
      if (body.dashboardUrl !== undefined) {
        const url = String(body.dashboardUrl).trim();
        if (url.length === 0) {
          next.dashboardUrl = '';
        } else {
          if (!/^https?:\/\//i.test(url)) {
            return res.status(400).json({ error: 'dashboardUrl must start with http:// or https://' });
          }
          // Strip trailing slash for clean concatenation later.
          next.dashboardUrl = url.replace(/\/+$/, '');
        }
      }
      saveGlobalConfig({
        ...config,
        integrations: { ...(config.integrations ?? {}), telegram: next },
      });

      // Hot-reload the bridge with the new settings.
      await bridge.reconfigure({
        token: getTelegramToken(),
        chatIds: Array.isArray(next.chatIds) ? next.chatIds : [],
        sendNotifications: next.sendNotifications !== false,
        sendAlerts: next.sendAlerts !== false,
        dashboardUrl: typeof next.dashboardUrl === 'string' ? next.dashboardUrl : '',
        permManager,
        agentManager,
      });

      res.json(buildView(bridge));
    } catch (err: any) {
      console.error('[integrations] PUT /telegram failed:', err);
      res.status(500).json({ error: err?.message || 'Failed to save telegram settings' });
    }
  });

  return router;
}
