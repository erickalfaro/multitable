import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ProviderCatalog, Provider } from '../providers/catalog.js';
import type { AgentSessionManager } from '../agent/manager.js';

// DiscoveredModel mirrors the shape ProviderCatalog produces and the
// AddAgentModal consumes. Kept here as the wire-format type so the web client
// can re-export it without depending on the catalog module.
export interface DiscoveredModel {
  id: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  // Per-model effort metadata. effortLevels lists exactly which tiers the model
  // accepts; the badge dropdown filters against this so the user can't pick a
  // tier that the model would reject (e.g. `max` on Sonnet, `xhigh` on a Codex
  // model that doesn't support it).
  supportsEffort?: boolean;
  effortLevels?: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

interface ProvidersDeps {
  catalog: ProviderCatalog;
  agentManager: AgentSessionManager;
}

const VALID_PROVIDERS: Provider[] = ['claude', 'codex', 'hermes', 'grok', 'cursor', 'copilot'];

function isProvider(s: unknown): s is Provider {
  return typeof s === 'string' && (VALID_PROVIDERS as string[]).includes(s);
}

export function createProvidersRouter(deps: ProvidersDeps): Router {
  const router = Router();

  // GET /api/providers/:provider/models
  //
  // Serves the in-memory cached catalog. Never blocks on live discovery — the
  // first /api/providers call after boot returns whatever's in the cache
  // (baseline if first ever boot, last cached values otherwise). Discovery
  // runs in the background and pushes updates over WS.
  router.get('/:provider/models', (req: Request, res: Response) => {
    const provider = String(req.params.provider || '').toLowerCase();
    if (!isProvider(provider)) {
      return res.status(404).json({ error: `unknown provider: ${provider}` });
    }
    const entry = deps.catalog.get(provider);
    res.json({
      provider,
      models: entry.models,
      lastRefreshed: entry.lastRefreshed,
      lastError: entry.lastError,
    });
  });

  // GET /api/providers/:provider/capabilities
  //
  // Serves the adapter's ProviderCapabilities bag without requiring a session
  // to exist. The AddAgentModal calls this before creation so it can render
  // the right mode picker (and gate creation-only providers like Grok).
  router.get('/:provider/capabilities', (req: Request, res: Response) => {
    const provider = String(req.params.provider || '').toLowerCase();
    if (!isProvider(provider)) {
      return res.status(404).json({ error: `unknown provider: ${provider}` });
    }
    const caps = deps.agentManager.getProviderCapabilities(provider);
    if (!caps) {
      return res.status(404).json({ error: `no adapter registered for provider: ${provider}` });
    }
    res.json({ provider, capabilities: caps });
  });

  // GET /api/providers/catalog
  //
  // Full snapshot across all providers — used by anything that wants to see
  // when each catalog was last refreshed (e.g. a "last updated 5m ago" label).
  router.get('/catalog', (_req: Request, res: Response) => {
    res.json(deps.catalog.getAll());
  });

  // POST /api/providers/refresh
  //
  // Triggers live discovery. Body: `{ provider?: 'claude' | 'codex' | 'hermes' }`.
  // Omit the provider to refresh every provider in parallel. De-duplicated by the
  // catalog module — concurrent clicks share the same in-flight Promise.
  // Returns 202 Accepted with the current snapshot; updates land async via WS.
  router.post('/refresh', (req: Request, res: Response) => {
    const provider = req.body?.provider;
    if (provider !== undefined && !isProvider(provider)) {
      return res
        .status(400)
        .json({ error: `invalid provider: ${provider}. Expected one of ${VALID_PROVIDERS.join(', ')}` });
    }
    if (provider) {
      void deps.catalog.refresh(provider);
    } else {
      void deps.catalog.refreshAll();
    }
    res.status(202).json({
      ok: true,
      refreshing: provider ? [provider] : VALID_PROVIDERS,
    });
  });

  return router;
}
