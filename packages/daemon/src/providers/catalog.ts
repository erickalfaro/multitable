import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';
import type { BaselineModel } from './baselines.js';
import { baselineFor } from './baselines.js';
import {
  discoverClaude,
  discoverCodex,
  discoverHermes,
  type DiscoveredModel,
} from './discovery.js';

// Provider-catalog cache.
//
// Three sources of truth, layered (later overrides earlier):
//
//   baseline (shipped, in baselines.ts)
//        ↓
//   on-disk cache (~/.cache/multitable/models.json)
//        ↓
//   live discovery (runs in background at boot + on user-triggered refresh)
//
// API endpoints + the WS broadcaster always read from the in-memory state.
// Per-request CLI calls / SDK probes are gone — the cache is the canonical
// runtime view.
//
// Events:
//   - 'updated' { provider, models, lastRefreshed } — fires on any change to
//     a provider's catalog (boot hydration, discovery success, user refresh).
//     server.ts subscribes and broadcasts `providers:catalog-updated`.

export type Provider = 'claude' | 'codex' | 'hermes';

interface CatalogEntry {
  models: DiscoveredModel[];
  lastRefreshed: number | null; // unix ms; null = never discovered (using baseline/cache)
  lastError: string | null;
}

interface PersistedCatalog {
  version: 1;
  entries: Partial<Record<Provider, { models: DiscoveredModel[]; lastRefreshed: number }>>;
}

const CACHE_SCHEMA_VERSION = 1 as const;

interface CatalogOptions {
  getDaemonEnv: () => NodeJS.ProcessEnv;
  resolveClaudeExecutable: () => string | undefined;
  discoveryCwd: string;
}

export class ProviderCatalog extends EventEmitter {
  private state: Map<Provider, CatalogEntry> = new Map();
  private inFlight: Map<Provider, Promise<void>> = new Map();
  private opts: CatalogOptions;
  private cachePath: string;

  constructor(opts: CatalogOptions) {
    super();
    this.opts = opts;
    const paths = envPaths('multitable', { suffix: '' });
    this.cachePath = path.join(paths.cache, 'models.json');
    // Seed every provider with its baseline. Codex's baseline is empty by
    // design — the UI will see an empty Codex catalog until first discovery.
    for (const provider of ['claude', 'codex', 'hermes'] as const) {
      this.state.set(provider, {
        models: cloneBaseline(baselineFor(provider)),
        lastRefreshed: null,
        lastError: null,
      });
    }
  }

  /**
   * Hydrate the in-memory state from the on-disk cache (if present). Called
   * during daemon startup BEFORE the HTTP server starts listening so the very
   * first /api/providers/* call gets cached data, not bare baselines.
   *
   * Schema mismatch (older daemon wrote a different shape) → ignore and reset.
   * Read errors → log + use baselines.
   */
  async hydrate(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedCatalog;
      if (parsed.version !== CACHE_SCHEMA_VERSION) {
        console.warn('[catalog] cache schema version mismatch, ignoring');
        return;
      }
      for (const provider of ['claude', 'codex', 'hermes'] as const) {
        const entry = parsed.entries?.[provider];
        // Only hydrate when the cache actually has models — an empty array
        // means a prior discovery returned no live data, and the seeded
        // baseline is more useful than blanking the picker.
        if (entry && Array.isArray(entry.models) && entry.models.length > 0) {
          this.state.set(provider, {
            models: entry.models,
            lastRefreshed: entry.lastRefreshed ?? null,
            lastError: null,
          });
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        console.warn('[catalog] failed to read cache file:', err);
      }
    }
  }

  /**
   * Return the current in-memory catalog for a provider. Always returns a
   * snapshot — never throws — so callers don't have to special-case "catalog
   * not yet loaded" states.
   */
  get(provider: Provider): CatalogEntry {
    return (
      this.state.get(provider) ?? { models: [], lastRefreshed: null, lastError: null }
    );
  }

  getAll(): Record<Provider, CatalogEntry> {
    return {
      claude: this.get('claude'),
      codex: this.get('codex'),
      hermes: this.get('hermes'),
    };
  }

  /**
   * Run live discovery for one provider. De-duplicates concurrent refreshes
   * (a click-spamming user triggers exactly one in-flight discovery; later
   * clicks await the same Promise). On success: update state, persist cache,
   * emit 'updated'. On failure: record lastError, emit 'updated' anyway so the
   * UI can surface the error state, do NOT touch the cache or stable models.
   */
  refresh(provider: Provider): Promise<void> {
    const existing = this.inFlight.get(provider);
    if (existing) return existing;
    const task = this.runDiscovery(provider).finally(() => {
      this.inFlight.delete(provider);
    });
    this.inFlight.set(provider, task);
    return task;
  }

  /**
   * Kick off discovery for every provider in parallel. Fire-and-forget from
   * the boot path. Errors per provider are isolated.
   */
  async refreshAll(): Promise<void> {
    await Promise.allSettled([
      this.refresh('claude'),
      this.refresh('codex'),
      this.refresh('hermes'),
    ]);
  }

  private async runDiscovery(provider: Provider): Promise<void> {
    const before = this.state.get(provider);
    try {
      let models: DiscoveredModel[];
      if (provider === 'codex') {
        models = await discoverCodex(this.opts.getDaemonEnv());
      } else if (provider === 'hermes') {
        models = await discoverHermes(this.opts.getDaemonEnv());
      } else {
        models = await discoverClaude(this.opts.discoveryCwd, this.opts.resolveClaudeExecutable);
      }
      // If discovery returned no live data but we have a baseline (e.g. Hermes
      // until `hermes models --json` lands), keep the baseline so the picker
      // isn't empty. `discoverHermes` is intentionally permissive and resolves
      // to `[]` rather than throwing; without this guard it would clobber the
      // seeded baseline on every refresh.
      if (models.length === 0) {
        const baseline = cloneBaseline(baselineFor(provider));
        if (baseline.length > 0) models = baseline;
      }
      const now = Date.now();
      this.state.set(provider, {
        models,
        lastRefreshed: now,
        lastError: null,
      });
      await this.persist().catch((err) => {
        console.warn('[catalog] failed to persist cache:', err);
      });
      this.emit('updated', { provider, ...this.state.get(provider)! });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[catalog] discovery failed for ${provider}:`, message);
      // Preserve the existing models — don't blank them on transient errors.
      this.state.set(provider, {
        models: before?.models ?? [],
        lastRefreshed: before?.lastRefreshed ?? null,
        lastError: message,
      });
      this.emit('updated', { provider, ...this.state.get(provider)! });
    }
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.cachePath);
    await fsp.mkdir(dir, { recursive: true });
    const payload: PersistedCatalog = {
      version: CACHE_SCHEMA_VERSION,
      entries: {},
    };
    for (const provider of ['claude', 'codex', 'hermes'] as const) {
      const entry = this.state.get(provider);
      if (entry && entry.lastRefreshed !== null) {
        payload.entries[provider] = {
          models: entry.models,
          lastRefreshed: entry.lastRefreshed,
        };
      }
    }
    // Atomic write — same trick as secrets.ts. Avoids torn reads if the daemon
    // exits mid-write.
    const tmp = `${this.cachePath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
    await fsp.rename(tmp, this.cachePath);
  }
}

function cloneBaseline(b: BaselineModel[]): DiscoveredModel[] {
  return b.map((m) => ({ ...m }));
}
