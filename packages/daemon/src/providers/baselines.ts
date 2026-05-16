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

export const CODEX_BASELINE: BaselineModel[] = [];

export function baselineFor(provider: 'claude' | 'codex'): BaselineModel[] {
  switch (provider) {
    case 'claude':
      return CLAUDE_BASELINE;
    case 'codex':
      return CODEX_BASELINE;
  }
}
