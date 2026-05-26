import { Router } from 'express';
import type { Request, Response } from 'express';
import type { PermissionManager } from '../hooks/permissionManager.js';
import type { ElicitationManager } from '../hooks/elicitationManager.js';
import type { AgentSessionManager } from '../agent/manager.js';

/**
 * Recovery snapshot for in-flight agent popups.
 *
 * Permission prompts, AskUserQuestion prompts, and MCP elicitations are held in
 * daemon memory and broadcast over WS exactly once at creation — a browser
 * refresh wipes the client's copy and leaves the turn blocked with no UI to
 * unblock it. The web re-fetches this endpoint on load / ws:reconnected /
 * ws:resumed and replays the result into the store (id-deduped), so a pending
 * popup survives a refresh. The daemon stays the source of truth: anything
 * resolved while the tab was away (e.g. answered from Telegram) simply isn't
 * returned, so stale prompts never reappear.
 */
export function createPromptsRouter(
  permManager: PermissionManager,
  elicitManager: ElicitationManager,
  agentManager: AgentSessionManager,
): Router {
  const router = Router();

  // GET /api/pending-prompts
  router.get('/', (_req: Request, res: Response) => {
    res.json({
      permissions: permManager.getPending(), // includes kind:'ask-question'
      elicitations: elicitManager.getAll(),
      options: agentManager.getDetectedOptions(),
    });
  });

  return router;
}
