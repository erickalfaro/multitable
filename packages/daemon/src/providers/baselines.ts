// Baseline model catalogs shipped with the daemon. These are the seed values
// the UI sees BEFORE the boot-time live-discovery pass returns, and the safety
// net when discovery fails (auth missing, CLI unavailable, network error).
//
// Authoritative status per provider:
//
//   - **Claude** — baseline holds the canonical alias triple (opus / sonnet /
//     haiku) which always resolve to the latest tier server-side. Live
//     discovery (via SDK `Query.initializationResult()`) replaces the catalog
//     with concrete versioned ids + per-model effort metadata when it lands.
//
//   - **Codex** — no baseline. The user has agreed to assume the `codex` CLI
//     is installed before using MultiTable, and `codex debug models` is the
//     only source of truth. Catalog starts empty until first discovery.
//
// Schema mirrors DiscoveredModel in api/providers.ts. Keep them in sync.

export interface BaselineModel {
  id: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
  supportsEffort?: boolean;
  effortLevels?: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

// Minimal Claude baseline: the three official aliases (opus/sonnet/haiku) that
// Anthropic resolves server-side to the latest concrete model on each turn.
// We do NOT encode effort tiers or supportsEffort here — those flow from
// live discovery via the SDK's `Query.initializationResult()`, which returns
// `ModelInfo[]` with authoritative `supportedEffortLevels`. Until discovery
// has run, the badge falls back to showing the SDK's full enum permissively;
// the provider will reject unsupported levels with a clear turn-error.
export const CLAUDE_BASELINE: BaselineModel[] = [
  {
    id: 'opus',
    displayName: 'Opus (latest)',
    description: 'Resolves to the latest Opus on each turn.',
  },
  {
    id: 'sonnet',
    displayName: 'Sonnet (latest)',
    description: 'Resolves to the latest Sonnet on each turn.',
  },
  {
    id: 'haiku',
    displayName: 'Haiku (latest)',
    description: 'Resolves to the latest Haiku on each turn.',
  },
];

// Claude models the SDK's `initializationResult()` does NOT return in its
// model list even when the account can use them — Fable is gated behind
// consent/credits flags (`fableCreditsRequired` / `fableConsentSessionFailed`
// in the SDK), so it's filtered out of discovery but works when passed as an
// explicit `model:`. discoverClaude appends any of these the SDK didn't
// already surface (deduped by id), so they're pickable in the UI. When the
// SDK starts listing one natively, the dedup drops the supplemental copy.
// supportsEffort is left false — no authoritative effort metadata for these
// until the SDK includes them, and the provider rejects a bad level with a
// clear turn-error anyway.
export const CLAUDE_SUPPLEMENTAL: BaselineModel[] = [
  {
    id: 'claude-fable-5',
    displayName: 'Fable 5',
    description: 'Claude Fable 5.',
    supportsEffort: false,
  },
];

export const CODEX_BASELINE: BaselineModel[] = [];

// Hermes (Grok) baseline. Hermes does not currently expose a `list models`
// flag, so live discovery typically returns `[]` and this seed shows through
// in the AddAgent picker. Reasoning effort levels are sourced from the
// official Hermes slash-commands docs (the `/reasoning <level>` command lists
// none / minimal / low / medium / high / xhigh; we expose only the upper four
// tiers to match Claude/Codex's user-pickable surface).
export const HERMES_BASELINE: BaselineModel[] = [
  {
    id: 'grok-4.3',
    displayName: 'Grok 4.3',
    isDefault: true,
    supportsEffort: true,
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
  {
    id: 'grok-4.20-0309-reasoning',
    displayName: 'Grok 4.20 Reasoning',
    supportsEffort: true,
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'grok-4.20-0309-non-reasoning',
    displayName: 'Grok 4.20',
    supportsEffort: false,
  },
  {
    id: 'grok-4.20-multi-agent-0309',
    displayName: 'Grok 4.20 Multi-agent',
    supportsEffort: true,
    effortLevels: ['low', 'medium', 'high'],
  },
];

// Grok Build (xAI) baseline. Grok's ACP `session/new` reports a single model
// (`grok-build`, 512K context). Effort is wired via the spawn-time
// `grok agent --reasoning-effort` flag, whose tiers are
// none|minimal|low|medium|high|xhigh — there is NO `max`, so we cap at `xhigh`
// (the GrokAdapter also maps a stray `max` → `xhigh` defensively). Live
// discovery returns `[]` for now (no machine-readable `grok models --json`), so
// this seed shows through in the AddAgent picker.
export const GROK_BASELINE: BaselineModel[] = [
  {
    id: 'grok-build',
    displayName: 'Grok Build',
    description: 'xAI Grok Build — best for advanced coding tasks (512K context).',
    isDefault: true,
    supportsEffort: true,
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
];

// Cursor CLI (`cursor-agent`) baseline. `cursor-agent models` lists 100+ models
// (Composer, GPT-5.x, Claude, Gemini, Grok) and is the source of truth via live
// discovery; this seed shows through before the first probe / if it fails.
// `composer-2.5` is Cursor's current default. Effort is encoded IN the model id
// (e.g. gpt-5.5-high), so no effort tiers are declared here — see the
// cursor-cli skill (reference/models.md).
export const CURSOR_BASELINE: BaselineModel[] = [
  {
    id: 'composer-2.5',
    displayName: 'Composer 2.5',
    description: "Cursor's default coding model.",
    isDefault: true,
    supportsEffort: false,
  },
  {
    id: 'auto',
    displayName: 'Auto',
    description: 'Let Cursor pick the best available model per turn.',
    supportsEffort: false,
  },
];

// GitHub Copilot baseline. The SDK's `client.listModels()` is the source of
// truth via live discovery (rich per-model `supportedReasoningEfforts`); this
// minimal seed shows through before the first probe / if auth is missing.
// `auto` is Copilot's own recommended default (it also carries a premium-
// request discount).
export const COPILOT_BASELINE: BaselineModel[] = [
  {
    id: 'auto',
    displayName: 'Auto',
    description: 'Let Copilot pick the best available model per turn.',
    isDefault: true,
    supportsEffort: false,
  },
  {
    id: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    supportsEffort: true,
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
  },
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    supportsEffort: true,
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
  },
];

export function baselineFor(
  provider: 'claude' | 'codex' | 'hermes' | 'grok' | 'cursor' | 'copilot',
): BaselineModel[] {
  switch (provider) {
    case 'claude':
      return CLAUDE_BASELINE;
    case 'codex':
      return CODEX_BASELINE;
    case 'hermes':
      return HERMES_BASELINE;
    case 'grok':
      return GROK_BASELINE;
    case 'cursor':
      return CURSOR_BASELINE;
    case 'copilot':
      return COPILOT_BASELINE;
  }
}
