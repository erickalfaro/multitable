import React from 'react';
import type { AgentProvider } from '../../lib/types';

interface Props {
  provider: AgentProvider;
  /**
   * `glyph` is a single-letter monogram (smallest footprint, fits inside
   * sidebar status slots). `chip` is a tiny lowercase pill with a thin
   * border (good for header bars and modal lists). Default: `chip`.
   */
  size?: 'glyph' | 'chip';
  title?: string;
  style?: React.CSSProperties;
}

const LABEL: Record<AgentProvider, string> = {
  claude: 'claude',
  codex: 'codex',
  copilot: 'copilot',
  hermes: 'hermes',
  grok: 'grok',
  cursor: 'cursor',
};

const GLYPH: Record<AgentProvider, string> = {
  claude: 'C',
  codex: 'X',
  copilot: 'G',
  hermes: 'H',
  grok: 'K',
  cursor: 'U',
};

// Provider-distinct hue. Subtle in monochrome themes; the tint distinguishes
// providers at a glance without competing with status colors (amber=running,
// red=error, etc.).
function tintFor(provider: AgentProvider): string {
  switch (provider) {
    case 'claude':
      return 'var(--accent-amber)';
    case 'codex':
      return 'var(--text-secondary)';
    case 'copilot':
      // Subtle blue, distinct from amber/grey, matches GitHub's brand hint.
      return 'var(--accent-blue, #6384ff)';
    case 'hermes':
      // Subtle violet, distinct from amber/grey/blue. Hermes' brand colour.
      return 'var(--accent-violet, #a48cff)';
    case 'grok':
      // Subtle sky/cyan, distinct from amber/grey/blue/violet. xAI's accent.
      return 'var(--accent-sky, #38bdf8)';
    case 'cursor':
      // Subtle teal, distinct from amber/grey/blue/violet/sky.
      return 'var(--accent-teal, #2dd4bf)';
    default:
      return 'var(--text-secondary)';
  }
}

export function AgentBadge({ provider, size = 'chip', title, style }: Props) {
  const tint = tintFor(provider);
  const tooltip = title ?? `${LABEL[provider]} agent`;

  if (size === 'glyph') {
    return (
      <span
        title={tooltip}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 13,
          height: 13,
          fontSize: 9,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontWeight: 600,
          color: tint,
          opacity: 0.7,
          letterSpacing: 0,
          userSelect: 'none',
          WebkitUserSelect: 'none',
          ...style,
        }}
      >
        {GLYPH[provider]}
      </span>
    );
  }

  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 14,
        padding: '0 5px',
        borderRadius: 'var(--radius-snug)',
        border: `1px solid ${tint}`,
        color: tint,
        opacity: 0.85,
        fontSize: 9,
        lineHeight: 1,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        letterSpacing: '0.06em',
        textTransform: 'lowercase',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {LABEL[provider]}
    </span>
  );
}
