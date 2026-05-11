import { Router } from 'express';
import type { Request, Response } from 'express';
import { loadGlobalConfig, saveGlobalConfig } from '../config/loader.js';
import type { GlobalConfig } from '../types.js';

export function createConfigRouter(): Router {
  const router = Router();

  // GET /api/config
  router.get('/', (_req: Request, res: Response) => {
    try {
      const config = loadGlobalConfig();
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: 'Failed to load config' });
    }
  });

  // PUT /api/config
  router.put('/', (req: Request, res: Response) => {
    try {
      const current = loadGlobalConfig();
      const body = req.body as Partial<GlobalConfig>;

      // Validate known fields
      const allowed: (keyof GlobalConfig)[] = [
        'theme',
        'defaultEditor',
        'defaultShell',
        'terminalFontSize',
        'terminalScrollback',
        'notifications',
        'port',
        'host',
        'projects',
        'integrations',
      ];

      const updated: GlobalConfig = { ...current };

      for (const key of allowed) {
        if (body[key] !== undefined) {
          (updated as any)[key] = body[key];
        }
      }

      // Validate theme
      if (updated.theme && !['light', 'dark', 'system'].includes(updated.theme)) {
        return res.status(400).json({ error: 'Invalid theme value' });
      }

      // Validate port
      if (updated.port !== undefined) {
        const port = Number(updated.port);
        if (isNaN(port) || port < 1 || port > 65535) {
          return res.status(400).json({ error: 'Invalid port value' });
        }
        updated.port = port;
      }

      saveGlobalConfig(updated);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: 'Failed to save config' });
    }
  });

  // PATCH /api/config — partial update
  router.patch('/', (req: Request, res: Response) => {
    try {
      const current = loadGlobalConfig();
      const updated = { ...current, ...req.body };
      saveGlobalConfig(updated);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: 'Failed to save config' });
    }
  });

  return router;
}
