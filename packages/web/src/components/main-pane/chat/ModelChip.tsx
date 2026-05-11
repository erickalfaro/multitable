import React, { useEffect } from 'react';
import { Sparkles } from 'lucide-react';
import type { Session } from '../../../lib/types';
import { useAppStore } from '../../../stores/appStore';

interface Props {
  session: Session;
}

// Strip provider prefixes and title-case the remainder so a raw model id like
// `claude-opus-4-7` reads as `Opus 4.7` while the catalog is loading or when
// the daemon returns an id we don't have a displayName for.
function prettify(modelId: string): string {
  const stripped = modelId.replace(/^(claude-|codex-)/, '');
  const segments = stripped.split('-');
  return segments
    .map((seg) => {
      if (/^\d/.test(seg)) return seg;
      if (/^gpt$/i.test(seg)) return 'GPT';
      if (seg.length === 0) return seg;
      return seg.charAt(0).toUpperCase() + seg.slice(1);
    })
    .join(' ')
    .replace(/\bGpt\b/gi, 'GPT');
}

export function ModelChip({ session }: Props) {
  const provider = session.agentProvider;
  const catalog = useAppStore((s) => s.modelCatalog[provider]);
  const status = useAppStore((s) => s.modelCatalogStatus[provider]);
  const loadModelCatalog = useAppStore((s) => s.loadModelCatalog);

  useEffect(() => {
    if (session.model && status === 'idle') {
      loadModelCatalog(provider);
    }
  }, [provider, session.model, status, loadModelCatalog]);

  if (!session.model) return null;

  const fromCatalog = catalog?.find((m) => m.id === session.model)?.displayName;
  const label = fromCatalog ?? prettify(session.model);

  return (
    <span
      title={`Model: ${session.model}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        padding: '0 8px',
        fontFamily: 'inherit',
        fontSize: 11.5,
        fontWeight: 500,
        letterSpacing: '0.01em',
        color: 'var(--text-secondary)',
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 999,
        lineHeight: 1,
        userSelect: 'none',
        WebkitUserSelect: 'none',
        flexShrink: 0,
      }}
    >
      <Sparkles size={11} strokeWidth={2.2} />
      <span style={{ lineHeight: 1 }}>{label}</span>
    </span>
  );
}
