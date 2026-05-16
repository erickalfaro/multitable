import React, { useEffect } from 'react';
import type { Session } from '../../../lib/types';
import { useAppStore } from '../../../stores/appStore';
import { cleanModelLabelFromCatalog } from '../../../lib/modelName';

interface Props {
  session: Session;
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

  const label = cleanModelLabelFromCatalog(session.model, catalog) ?? session.model;

  return (
    <span
      title={`Model: ${label}`}
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
        borderRadius: 'var(--radius-snug)',
        lineHeight: 1,
        userSelect: 'none',
        WebkitUserSelect: 'none',
        flexShrink: 0,
      }}
    >
      <span style={{ lineHeight: 1 }}>{label}</span>
    </span>
  );
}
