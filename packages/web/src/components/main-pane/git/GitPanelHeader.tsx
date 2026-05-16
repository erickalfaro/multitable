import { GitBranch, RefreshCw, X, ArrowUp, ArrowDown } from 'lucide-react';
import { GitActionMenu, type GitMenuItem } from './GitActionMenu';

interface Props {
  branch: string | null;
  ahead: number;
  behind: number;
  onOpenBranchPicker: () => void;
  onRefresh: () => void;
  menuItems: GitMenuItem[];
  error: string | null;
  onDismissError: () => void;
}

export function GitPanelHeader({
  branch,
  ahead,
  behind,
  onOpenBranchPicker,
  onRefresh,
  menuItems,
  error,
  onDismissError,
}: Props) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        borderBottom: '1px solid var(--border)',
        backgroundColor: 'var(--bg-primary)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          fontSize: 12,
          color: 'var(--text-secondary)',
          minHeight: 36,
        }}
      >
        <button
          type="button"
          onClick={onOpenBranchPicker}
          title="Switch Branch…"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 8px',
            fontSize: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: 'var(--text-primary)',
            backgroundColor: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-snug)',
            cursor: 'pointer',
          }}
        >
          <GitBranch size={12} />
          <span>{branch ?? 'detached'}</span>
        </button>

        {(ahead > 0 || behind > 0) && (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
            {behind > 0 && (
              <span
                title={`${behind} commit${behind === 1 ? '' : 's'} behind`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
              >
                <ArrowDown size={10} />
                {behind}
              </span>
            )}
            {ahead > 0 && (
              <span
                title={`${ahead} commit${ahead === 1 ? '' : 's'} ahead`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
              >
                <ArrowUp size={10} />
                {ahead}
              </span>
            )}
          </span>
        )}

        <button
          type="button"
          onClick={onRefresh}
          title="Refresh"
          style={{ ...iconBtn, marginLeft: 'auto' }}
        >
          <RefreshCw size={12} />
        </button>

        <GitActionMenu items={menuItems} />
      </div>

      {error && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            fontSize: 11,
            color: 'var(--accent-amber)',
            backgroundColor: 'color-mix(in srgb, var(--accent-amber) 10%, transparent)',
            borderTop: '1px solid var(--border)',
          }}
        >
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {error}
          </span>
          <button
            type="button"
            onClick={onDismissError}
            title="Dismiss"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              background: 'transparent',
              border: 'none',
              color: 'var(--accent-amber)',
              cursor: 'pointer',
              borderRadius: 'var(--radius-snug)',
            }}
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  borderRadius: 'var(--radius-snug)',
};
