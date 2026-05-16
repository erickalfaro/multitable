import { ArrowUp, ArrowDown } from 'lucide-react';

interface Props {
  filePath: string;
  hunkCount: number;
  currentHunk: number;
  onPrev: () => void;
  onNext: () => void;
}

export function GitDiffHeader({ filePath, hunkCount, currentHunk, onPrev, onNext }: Props) {
  const hasPrev = hunkCount > 0 && currentHunk > 0;
  const hasNext = hunkCount > 0 && currentHunk < hunkCount - 1;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        fontSize: 12,
        color: 'var(--text-secondary)',
        borderBottom: '1px solid var(--border)',
        backgroundColor: 'var(--bg-primary)',
        flexShrink: 0,
        minHeight: 32,
      }}
    >
      <FileLabel path={filePath} />
      {hunkCount > 1 && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {currentHunk + 1} / {hunkCount}
        </span>
      )}
      <button
        type="button"
        onClick={onPrev}
        disabled={!hasPrev}
        title="Previous Change"
        style={{ ...iconBtn, opacity: hasPrev ? 1 : 0.35, cursor: hasPrev ? 'pointer' : 'default' }}
      >
        <ArrowUp size={12} />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={!hasNext}
        title="Next Change"
        style={{ ...iconBtn, opacity: hasNext ? 1 : 0.35, cursor: hasNext ? 'pointer' : 'default' }}
      >
        <ArrowDown size={12} />
      </button>
    </div>
  );
}

function FileLabel({ path }: { path: string }) {
  const slash = path.lastIndexOf('/');
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dir = slash === -1 ? '' : path.slice(0, slash);
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        overflow: 'hidden',
        minWidth: 0,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      }}
      title={path}
    >
      <span style={{ color: 'var(--text-primary)', fontSize: 12, flexShrink: 0 }}>{name}</span>
      {dir && (
        <span
          style={{
            color: 'var(--text-muted)',
            fontSize: 11,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: 'rtl',
            textAlign: 'left',
            minWidth: 0,
          }}
        >
          {'‪' + dir + '‬'}
        </span>
      )}
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-muted)',
  borderRadius: 'var(--radius-snug)',
};
