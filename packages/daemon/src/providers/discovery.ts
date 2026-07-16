import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { BaselineModel } from './baselines.js';
import { CLAUDE_SUPPLEMENTAL } from './baselines.js';
import { resolveCursorCli } from '../agent/providers/cursor-cli/index.js';

// Discovery functions for each provider. Each returns the live model catalog
// as DiscoveredModel-shaped objects, or throws on failure (the caller — the
// catalog module — handles errors by falling back to baseline/cache).
//
// Discovery is run in the background at boot, on user-triggered refresh, and
// on the catalog's periodic timer. The catalog module is the only consumer;
// nothing else should call these directly.

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

// === Grok Build ============================================================
//
// Grok exposes its model list through the ACP `session/new` response rather
// than a standalone command, so there's no cheap discovery probe today. We try
// `grok models --json` defensively (in case a future build adds it) and
// otherwise resolve to `[]` so the seeded GROK_BASELINE shows through.

export async function discoverGrok(env: NodeJS.ProcessEnv): Promise<DiscoveredModel[]> {
  let stdout: string;
  try {
    stdout = await execStdout('grok', ['models', '--json'], env, 5000);
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  const raw: any[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.models)
      ? (parsed as any).models
      : [];

  const models: DiscoveredModel[] = raw
    .filter((m: any) => m && typeof (m.id ?? m.modelId ?? m.slug) === 'string')
    .map((m: any, idx: number) => {
      const id = String(m.id ?? m.modelId ?? m.slug);
      const rawLevels = Array.isArray(m.effortLevels)
        ? m.effortLevels
        : Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels
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
          typeof m.name === 'string' && m.name
            ? m.name
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

// === Cursor ================================================================
//
// The Cursor CLI prints its catalog as plain text via `cursor-agent models`
// (no --json flag): one `id - Display Name` line per model, with the active
// default tagged ` (current, default)`. We resolve the executable the same way
// the adapter does (on Windows the PATH entry is a `.cmd` shim, so we spawn the
// bundled node.exe + index.js directly). Effort is encoded in the model id, so
// every row is `supportsEffort: false`. Permissive: any failure → `[]` so the
// seeded CURSOR_BASELINE shows through. See the cursor-cli skill.

export async function discoverCursor(env: NodeJS.ProcessEnv): Promise<DiscoveredModel[]> {
  let cli: { command: string; prefixArgs: string[] };
  try {
    cli = resolveCursorCli();
  } catch {
    return [];
  }
  let stdout: string;
  try {
    stdout = await execStdout(cli.command, [...cli.prefixArgs, 'models'], env, 8000);
  } catch {
    return [];
  }

  const models: DiscoveredModel[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip the header and the trailing tip.
    if (/^available models/i.test(trimmed) || /^tip:/i.test(trimmed)) continue;
    const sep = trimmed.indexOf(' - ');
    if (sep <= 0) continue;
    const id = trimmed.slice(0, sep).trim();
    let displayName = trimmed.slice(sep + 3).trim();
    if (!id) continue;
    // Pull out a ` (current, default)` / ` (default)` marker.
    const isDefault = /\(current,?\s*default\)|\(default\)/i.test(displayName);
    displayName = displayName.replace(/\s*\((?:current,?\s*)?default\)\s*$/i, '').trim();
    models.push({
      id,
      displayName: displayName || id,
      ...(isDefault ? { isDefault: true } : {}),
      supportsEffort: false,
    });
  }
  return models;
}

// === Copilot ===============================================================
//
// The Copilot SDK exposes the authoritative catalog via `client.listModels()`
// (per-model `supportedReasoningEfforts` + `defaultReasoningEffort`). We spin
// a short-lived CopilotClient (spawns the bundled CLI child), list, and stop —
// same spirit as discoverClaude's throwaway query(). Permissive: any failure
// (no GitHub auth, CLI spawn error, timeout) → `[]` so COPILOT_BASELINE shows
// through. `max` is filtered out even where advertised — the SDK's
// SessionConfig.reasoningEffort enum tops out at `xhigh`, so we never send it.
export async function discoverCopilot(): Promise<DiscoveredModel[]> {
  const { CopilotClient } = await import('@github/copilot-sdk');
  const client = new CopilotClient({ logLevel: 'error' });
  try {
    const models = await Promise.race([
      (async () => {
        await client.start();
        return client.listModels();
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('copilot discovery timed out')), 15000),
      ),
    ]);
    return models
      .filter((m) => m && typeof m.id === 'string')
      .map((m, idx) => {
        const raw = m as unknown as {
          id: string;
          name?: string;
          supportedReasoningEfforts?: string[];
          defaultReasoningEffort?: string;
        };
        const effortLevels = (raw.supportedReasoningEfforts ?? [])
          .map(clampEffort)
          .filter((x): x is EffortLevel => !!x && x !== 'max');
        const supportsEffort = effortLevels.length > 0;
        const defaultEffort = clampEffort(raw.defaultReasoningEffort);
        return {
          id: raw.id,
          displayName: raw.name || raw.id,
          ...(idx === 0 ? { isDefault: true } : {}),
          supportsEffort,
          ...(supportsEffort ? { effortLevels } : {}),
          ...(defaultEffort && defaultEffort !== 'max' ? { defaultEffort } : {}),
        };
      });
  } catch {
    return [];
  } finally {
    void client.stop().catch(() => {});
  }
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
// The catch: a single binary's model list is only as fresh as that binary.
// The SDK-bundled `claude` is pinned by the npm dep, while the user's system
// `claude` self-updates — so we probe BOTH and union the lists, letting the
// newer binary drive ordering/default. A brand-new model then appears as soon
// as either binary knows it, with no code or dep change.
//
// Requires either ANTHROPIC_API_KEY or a valid ~/.claude/auth.json. On
// failure of both probes, the caller falls back to the baseline alias triple.

interface ClaudeProbe {
  models: DiscoveredModel[]; // no isDefault, no supplementals — merge owns those
  version: [number, number, number] | null; // parsed claude_code_version
}

function parseClaudeVersion(raw: string | undefined): ClaudeProbe['version'] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Strictly newer only — ties, unparseable, and missing versions all return
// false, biasing the merge toward the bundled binary (current behavior).
function isNewerVersion(a: ClaudeProbe['version'], b: ClaudeProbe['version']): boolean {
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

async function probeClaudeBinary(
  cwd: string,
  pathToClaudeCodeExecutable: string | undefined,
  timeoutMs = 30_000,
): Promise<ClaudeProbe> {
  const ctrl = new AbortController();
  // Hard timeout: a hung probe would otherwise occupy the catalog's inFlight
  // slot forever, permanently blocking refreshes for the provider.
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref();
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
    let versionRaw: string | undefined;
    for await (const msg of it) {
      iterations += 1;
      const m = msg as { type?: string; subtype?: string; claude_code_version?: string };
      if (m.type === 'system' && m.subtype === 'init') {
        versionRaw = m.claude_code_version;
        break;
      }
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
    const raw = Array.isArray(initResult?.models) ? initResult.models : [];
    // Trust the SDK's ordering — `ModelInfo[]` from `initializationResult()`
    // is the same shape Claude's own UIs consume. No pattern-matching on id
    // or display name; if the SDK ranks Sonnet above Opus tomorrow, that's
    // Anthropic's call and we surface it.
    const models: DiscoveredModel[] = raw.map((m) => {
      const effortLevels = (m.supportedEffortLevels ?? [])
        .map(clampEffort)
        .filter((x): x is EffortLevel => !!x);
      const supportsEffort = m.supportsEffort === true && effortLevels.length > 0;
      return {
        id: m.value,
        displayName: m.displayName || m.value,
        description: m.description || undefined,
        supportsEffort,
        ...(supportsEffort ? { effortLevels } : {}),
      };
    });
    return { models, version: parseClaudeVersion(versionRaw) };
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

export async function discoverClaude(
  cwd: string,
  resolveExecutable: () => string | undefined,
  resolveSystemExecutable: () => string | undefined,
): Promise<DiscoveredModel[]> {
  const bundledPath = resolveExecutable();
  let systemPath: string | undefined = resolveSystemExecutable();
  let systemNote: string | null = systemPath ? null : 'not found';
  if (systemPath && bundledPath && samePath(systemPath, bundledPath)) {
    systemPath = undefined;
    systemNote = 'same as bundled';
  }

  const settled = await Promise.allSettled([
    probeClaudeBinary(cwd, bundledPath),
    ...(systemPath ? [probeClaudeBinary(cwd, systemPath)] : []),
  ]);
  const errMsg = (r: PromiseRejectedResult) =>
    r.reason instanceof Error ? r.reason.message : String(r.reason);
  const bundled = settled[0].status === 'fulfilled' ? settled[0].value : null;
  const system = settled[1]?.status === 'fulfilled' ? settled[1].value : null;
  if (settled[1]?.status === 'rejected') systemNote = `probe failed (${errMsg(settled[1])})`;

  if (!bundled && !system) {
    throw new Error(
      `claude discovery failed — bundled: ${errMsg(settled[0] as PromiseRejectedResult)}; system: ${systemNote}`,
    );
  }

  // Union by id: the strictly-newer binary is primary (drives ordering,
  // default, per-model metadata); models only the other binary knows are
  // appended after, verbatim.
  let models: DiscoveredModel[];
  let appendNote = '';
  if (bundled && system) {
    const systemIsPrimary = isNewerVersion(system.version, bundled.version);
    const primary = systemIsPrimary ? system : bundled;
    const secondary = systemIsPrimary ? bundled : system;
    models = [...primary.models];
    const seen = new Set(models.map((m) => m.id));
    let appended = 0;
    for (const m of secondary.models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      models.push(m);
      appended += 1;
    }
    if (appended > 0) {
      appendNote = ` (${appended} ${systemIsPrimary ? 'bundled' : 'system'}-only)`;
    }
  } else {
    models = [...(bundled ?? system)!.models];
  }
  if (models.length > 0) models[0] = { ...models[0], isDefault: true };

  // Append supplemental models (e.g. Fable) the SDK doesn't list but the
  // account can still use. Dedup by id so a future SDK that surfaces one
  // natively wins over the supplemental stub. See CLAUDE_SUPPLEMENTAL.
  const present = new Set(models.map((m) => m.id));
  for (const extra of CLAUDE_SUPPLEMENTAL) {
    if (present.has(extra.id)) continue;
    models.push({
      id: extra.id,
      displayName: extra.displayName,
      description: extra.description,
      supportsEffort: extra.supportsEffort ?? false,
      ...(extra.effortLevels ? { effortLevels: extra.effortLevels } : {}),
    });
  }

  const fmt = (v: ClaudeProbe['version']) => (v ? v.join('.') : 'unknown');
  const bundledPart = bundled ? `bundled ${fmt(bundled.version)}` : 'bundled: probe failed';
  const systemPart = system
    ? `system ${fmt(system.version)} (${systemPath})`
    : `system: ${systemNote}`;
  console.log(
    `[catalog] claude discovery: ${bundledPart}, ${systemPart}, ${models.length} models${appendNote}`,
  );
  return models;
}

