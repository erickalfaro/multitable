import { useState } from 'react';
import { FilePlus, FileMinus, FileEdit, FileWarning } from 'lucide-react';
import type { GitFileEntry, GitFileStatus } from '../../../lib/types';
import { emphasisFill } from '../../../lib/emphasis';

interface Props {
  file: GitFileEntry;
  isSelected: boolean;
  onClick: () => void;
  actions: React.ReactNode;
}

export function GitChangeRow({ file, isSelected, onClick, actions }: Props) {
  const [hover, setHover] = useState(false);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 12px 4px 14px',
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: 'var(--text-primary)',
        cursor: 'pointer',
        borderRadius: 'var(--radius-snug)',
        ...(isSelected
          ? emphasisFill('var(--accent-blue)', { fill: 10, ring: 30, on: 'var(--bg-elevated)' })
          : { backgroundColor: hover ? 'var(--bg-sidebar)' : 'transparent' }),
        minHeight: 24,
      }}
    >
      <StatusIcon status={file.status} />
      <FileLabel path={file.path} oldPath={file.oldPath} />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          visibility: hover || isSelected ? 'visible' : 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {actions}
      </div>
      <StatusBadge status={file.status} />
    </div>
  );
}

function FileLabel({ path, oldPath }: { path: string; oldPath?: string }) {
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
      }}
      title={oldPath ? `${oldPath} → ${path}` : path}
    >
      <span
        style={{
          color: 'var(--text-primary)',
          flexShrink: 0,
        }}
      >
        {name}
      </span>
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
          {/* direction:rtl + unicode markers keeps the trailing segment visible
              while ellipsizing the leading directories. */}
          {'‪' + dir + '‬'}
        </span>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: GitFileStatus }) {
  const common = { size: 12, style: { flexShrink: 0 as const } };
  switch (status) {
    case 'added':
      return <FilePlus {...common} color="var(--status-running)" />;
    case 'deleted':
      return <FileMinus {...common} color="var(--status-error)" />;
    case 'renamed':
    case 'copied':
      return <FileEdit {...common} color="var(--accent-blue)" />;
    case 'conflicted':
      return <FileWarning {...common} color="var(--accent-amber)" />;
    case 'untracked':
      return <FilePlus {...common} color="var(--text-muted)" />;
    default:
      return <FileEdit {...common} color="var(--text-muted)" />;
  }
}

function StatusBadge({ status }: { status: GitFileStatus }) {
  const info: Record<GitFileStatus, { letter: string; color: string; label: string }> = {
    added: { letter: 'A', color: 'var(--status-running)', label: 'Added' },
    modified: { letter: 'M', color: 'var(--accent-amber)', label: 'Modified' },
    deleted: { letter: 'D', color: 'var(--status-error)', label: 'Deleted' },
    renamed: { letter: 'R', color: 'var(--accent-blue)', label: 'Renamed' },
    copied: { letter: 'C', color: 'var(--accent-blue)', label: 'Copied' },
    untracked: { letter: 'U', color: 'var(--text-muted)', label: 'Untracked' },
    conflicted: { letter: '!', color: 'var(--accent-amber)', label: 'Conflicted' },
  };
  const i = info[status];
  return (
    <span
      title={i.label}
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: i.color,
        width: 12,
        textAlign: 'center',
        flexShrink: 0,
      }}
    >
      {i.letter}
    </span>
  );
}
