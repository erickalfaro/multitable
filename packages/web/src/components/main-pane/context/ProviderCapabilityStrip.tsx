import React from 'react';
import type { Session } from '../../../lib/types';
import { useAppStore } from '../../../stores/appStore';
import type { DetailPanelTab } from '../../../stores/appStore';

interface Props {
  session: Session;
}

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

const SEGMENT_DOT = '·';

export function ProviderCapabilityStrip({ session }: Props) {
  const setDetailPanelTab = useAppStore((s) => s.setDetailPanelTab);
  const provider = session.agentProvider;
  const capabilities = session.capabilities ?? null;
  const claude = session.claudeState;
  const tokensIn = claude?.userMessages ? claude.tokenCount : claude?.tokenCount ?? 0;
  void tokensIn;
  const tokensTotal = claude?.tokenCount ?? 0;
  const cost = claude?.costUsd ?? 0;
  const model = session.model || claude?.agentProvider || provider;
  const showDollar = capabilities ? capabilities.costUsd : provider !== 'codex';

  const jumpTo = (tab: DetailPanelTab) => setDetailPanelTab(tab);

  const segments: Array<{ key: string; node: React.ReactNode; onClick?: () => void; title?: string }> = [];

  segments.push({
    key: 'model',
    node: (
      <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{model}</span>
    ),
    title: `${provider} · ${model}`,
  });

  if (showDollar) {
    segments.push({
      key: 'cost',
      node: (
        <span className="mt-mono-tabular" style={{ color: 'var(--text-secondary)' }}>
          {formatCost(cost)}
        </span>
      ),
      onClick: () => jumpTo('cost'),
      title: 'Session cost so far — click to open Cost tab',
    });
  }

  if (tokensTotal > 0) {
    segments.push({
      key: 'tokens',
      node: (
        <span className="mt-mono-tabular" style={{ color: 'var(--text-secondary)' }}>
          {formatTokens(tokensTotal)} tok
        </span>
      ),
      onClick: () => jumpTo('cost'),
      title: 'Tokens used — click to open Cost tab',
    });
  }

  if (capabilities) {
    if (capabilities.planMode !== 'none') {
      segments.push({
        key: 'plan',
        node: (
          <span style={{ color: 'var(--text-muted)' }}>
            plan:{capabilities.planMode}
          </span>
        ),
        title: `Plan mode flavor: ${capabilities.planMode}`,
      });
    }
    if (capabilities.subagents !== 'none') {
      segments.push({
        key: 'subagents',
        node: (
          <span style={{ color: 'var(--text-muted)' }}>
            subagents:{capabilities.subagents}
          </span>
        ),
      });
    }
    if (capabilities.elicitation) {
      segments.push({
        key: 'elicit',
        node: <span style={{ color: 'var(--text-muted)' }}>elicit</span>,
        title: 'Adapter supports MCP elicitInput',
      });
    }
    segments.push({
      key: 'approval',
      node: (
        <span style={{ color: 'var(--text-muted)' }}>
          approval:{capabilities.perCallApproval}
        </span>
      ),
      title: `Per-call approval mechanism: ${capabilities.perCallApproval}`,
    });
  }

  return (
    <div
      style={{
        flex: '0 0 auto',
        height: 24,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 10px',
        borderTop: '1px solid var(--border)',
        backgroundColor: 'var(--bg-statusbar)',
        fontSize: 10.5,
        color: 'var(--text-muted)',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        overflowX: 'auto',
        whiteSpace: 'nowrap',
      }}
    >
      {segments.map((s, i) => (
        <React.Fragment key={s.key}>
          {i > 0 && <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>{SEGMENT_DOT}</span>}
          {s.onClick ? (
            <button
              type="button"
              onClick={s.onClick}
              title={s.title}
              className="mt-toolbar-button"
              style={{
                background: 'transparent',
                border: 'none',
                padding: '2px 4px',
                cursor: 'pointer',
                color: 'inherit',
                fontFamily: 'inherit',
                fontSize: 'inherit',
                borderRadius: 'var(--radius-snug)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              {s.node}
            </button>
          ) : (
            <span title={s.title} style={{ flexShrink: 0 }}>
              {s.node}
            </span>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}
