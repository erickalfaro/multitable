import { spawn } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { BaselineModel } from './baselines.js';

// Discovery functions for each provider. Each returns the live model catalog
// as DiscoveredModel-shaped objects, or throws on failure (the caller — the
// catalog module — handles errors by falling back to baseline/cache).
//
// Discovery is run in the background at boot and on user-triggered refresh.
// The catalog module is the only consumer; nothing else should call these
// directly.

export type DiscoveredModel = BaselineModel;

// Bounded soft-timeout wrapper around child_process.spawn that returns stdout.
// Identical to the helper formerly inline in api/providers.ts.
function execStdout(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 6000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error(`${cmd} ${args.join(' ')}: timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (b) => {
      out += b.toString();
    });
    child.stderr.on('data', (b) => {
      err += b.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.trim() || out.trim()}`));
    });
  });
}

type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const ALLOWED_EFFORTS: ReadonlySet<EffortLevel> = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

// Codex emits `none` / `minimal` for the two tiers below our exposed minimum.
// Those land here as well, and we deliberately discard them — we don't surface
// those as user-pickable options.
function clampEffort(raw: unknown): EffortLevel | undefined {
  return typeof raw === 'string' && ALLOWED_EFFORTS.has(raw as EffortLevel)
    ? (raw as EffortLevel)
    : undefined;
}

// === Codex =================================================================
//
// `codex debug models` emits the live catalog as JSON, including per-model
// `supported_reasoning_levels` + `default_reasoning_level`. We pass those
// through verbatim into the DiscoveredModel shape so the ThinkingEffortBadge
// gates correctly without any heuristic.
//
// No baseline: per design (user assumes the Codex CLI is installed before
// using MultiTable). If the CLI is missing or returns malformed JSON, the
// caller surfaces the error and the catalog stays empty until the user
// installs the CLI and refreshes.

export async function discoverCodex(env: NodeJS.ProcessEnv): Promise<DiscoveredModel[]> {
  const stdout = await execStdout('codex', ['debug', 'models'], env);
  const parsed = JSON.parse(stdout);
  const raw = Array.isArray(parsed?.models) ? parsed.models : [];
  // Codex emits a `priority` field per model — lowest number = most preferred
  // (the codex CLI's own TUI picker uses this). Sort by it so the first
  // element of the resulting array is the provider-recommended default. We
  // explicitly DO NOT pattern-match on model id (gpt-5 / o3 / …); the
  // catalog ordering is Codex's call, not ours.
  const sorted = [...raw]
    .filter((m: any) => m && typeof m.slug === 'string' && m.visibility !== 'hide')
    .sort((a: any, b: any) => {
      const pa = typeof a.priority === 'number' ? a.priority : Number.MAX_SAFE_INTEGER;
      const pb = typeof b.priority === 'number' ? b.priority : Number.MAX_SAFE_INTEGER;
      return pa - pb;
    });
  const models: DiscoveredModel[] = sorted.map((m: any, idx: number) => {
    const rawLevels = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels
      : [];
    const effortLevels = rawLevels
      .map((r: any) => clampEffort(r?.effort))
      .filter((x: EffortLevel | undefined): x is EffortLevel => !!x);
    const supportsEffort = effortLevels.length > 0;
    const defaultEffort = clampEffort(m.default_reasoning_level);
    return {
      id: String(m.slug),
      displayName:
        typeof m.display_name === 'string' && m.display_name ? m.display_name : String(m.slug),
      description: typeof m.description === 'string' ? m.description : undefined,
      // Mark the top-priority model as the default. The frontend's
      // `find(m => m.isDefault) ?? models[0]` would already do the right
      // thing without this, but tagging is explicit and survives future
      // re-sortings.
      ...(idx === 0 ? { isDefault: true } : {}),
      supportsEffort,
      ...(supportsEffort ? { effortLevels } : {}),
      ...(defaultEffort ? { defaultEffort } : {}),
    };
  });
  return models;
}

// === Hermes ================================================================
//
// Hermes (Grok) does not currently expose a JSON model-listing flag. The
// shape below is forward-looking: if/when `hermes models --json` lands, we
// parse it the same way as Codex. Until then, every spawn path here resolves
// to `[]` so the catalog falls back to the shipped baseline.
//
// Failure semantics, kept deliberately permissive so a missing/unauthorised
// Hermes CLI doesn't blow up the catalog refresh:
//
//   - Binary missing (`ENOENT`)          → return `[]` (baseline shows through)
//   - CLI exits non-zero (e.g. unknown   → return `[]`  (ditto — Hermes simply
//     `--json` flag, no auth, etc.)         doesn't have live data to share)
//   - Soft timeout (5s)                  → return `[]`
//   - JSON parse failure                 → return `[]`
//
// The function never throws — discovery is best-effort and the baseline is
// the source of truth until Hermes ships a real listing API.
export async function discoverHermes(env: NodeJS.ProcessEnv): Promise<DiscoveredModel[]> {
  let stdout: string;
  try {
    stdout = await execStdout('hermes', ['models', '--json'], env, 5000);
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  // Accept either `{ models: [...] }` (Codex-shaped) or a bare array so we're
  // resilient to whichever shape Hermes lands on. Each entry is mapped onto
  // DiscoveredModel; unknown fields are ignored.
  const raw: any[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.models)
      ? (parsed as any).models
      : [];

  const models: DiscoveredModel[] = raw
    .filter((m: any) => m && typeof (m.id ?? m.slug) === 'string')
    .map((m: any, idx: number) => {
      const id = String(m.id ?? m.slug);
      const rawLevels = Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels
        : Array.isArray(m.effortLevels)
          ? m.effortLevels
          : [];
      const effortLevels = rawLevels
        .map((r: any) => clampEffort(typeof r === 'string' ? r : r?.effort))
        .filter((x: EffortLevel | undefined): x is EffortLevel => !!x);
      const supportsEffort =
        typeof m.supportsEffort === 'boolean' ? m.supportsEffort : effortLevels.length > 0;
      const defaultEffort = clampEffort(m.default_reasoning_level ?? m.defaultEffort);
      return {
        id,
        displayName:
          typeof m.display_name === 'string' && m.display_name
            ? m.display_name
            : typeof m.displayName === 'string' && m.displayName
              ? m.displayName
              : id,
        description: typeof m.description === 'string' ? m.description : undefined,
        ...(idx === 0 ? { isDefault: true } : {}),
        supportsEffort,
        ...(supportsEffort && effortLevels.length ? { effortLevels } : {}),
        ...(defaultEffort ? { defaultEffort } : {}),
      };
    });

  return models;
}

// === Claude ================================================================
//
// The Claude Agent SDK exposes the authoritative per-model metadata through
// `Query.initializationResult()`, which returns `models: ModelInfo[]` with
// `supportsEffort` + `supportedEffortLevels` already populated. The same
// trick we use in `provisionSession`: start a minimal `query()` with an empty
// prompt, await the init result, then abort the iterator. The SDK doesn't
// actually run a turn — it just spins up the session, hands us the metadata,
// and we tear down.
//
// Requires either ANTHROPIC_API_KEY or a valid ~/.claude/auth.json. On
// failure, the caller falls back to the baseline alias triple.

export async function discoverClaude(
  cwd: string,
  resolveExecutable: () => string | undefined,
): Promise<DiscoveredModel[]> {
  const pathToClaudeCodeExecutable = resolveExecutable();
  const ctrl = new AbortController();
  const it = query({
    prompt: ' ',
    options: {
      cwd,
      ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      includePartialMessages: false,
      abortController: ctrl,
    },
  });

  // The SDK exposes initializationResult() on the Query handle. To get the
  // handle we have to start iterating; the init message arrives first.
  // Belt-and-braces: drain at most a few events before bailing out so we
  // don't leak a long-running iterator if the SDK changes its message order.
  try {
    let iterations = 0;
    for await (const msg of it) {
      iterations += 1;
      const m = msg as { type?: string; subtype?: string };
      if (m.type === 'system' && m.subtype === 'init') break;
      if (iterations >= 8) break;
    }
    const initResult = await (it as unknown as {
      initializationResult: () => Promise<{
        models?: Array<{
          value: string;
          displayName: string;
          description: string;
          supportsEffort?: boolean;
          supportedEffortLevels?: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
        }>;
      }>;
    }).initializationResult();
    ctrl.abort();
    const raw = Array.isArray(initResult?.models) ? initResult.models : [];
    // Trust the SDK's ordering — `ModelInfo[]` from `initializationResult()`
    // is the same shape Claude's own UIs consume. No pattern-matching on id
    // or display name; if the SDK ranks Sonnet above Opus tomorrow, that's
    // Anthropic's call and we surface it. The first model is treated as the
    // recommended default.
    const models: DiscoveredModel[] = raw.map((m, idx) => {
      const effortLevels = (m.supportedEffortLevels ?? [])
        .map(clampEffort)
        .filter((x): x is EffortLevel => !!x);
      const supportsEffort = m.supportsEffort === true && effortLevels.length > 0;
      return {
        id: m.value,
        displayName: m.displayName || m.value,
        description: m.description || undefined,
        ...(idx === 0 ? { isDefault: true } : {}),
        supportsEffort,
        ...(supportsEffort ? { effortLevels } : {}),
      };
    });
    return models;
  } catch (err) {
    ctrl.abort();
    throw err;
  }
}

