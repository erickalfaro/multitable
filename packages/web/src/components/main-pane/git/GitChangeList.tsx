import { useState } from 'react';
import { Plus, Minus, Trash2 } from 'lucide-react';
import type { GitFileEntry } from '../../../lib/types';
import { GitChangeRow } from './GitChangeRow';

type ChangeBucket = 'unstaged' | 'untracked';

interface Props {
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
  conflicted: GitFileEntry[];
  selectedPath: string | null;
  selectedBucket: 'staged' | 'unstaged' | null;
  onSelect: (file: GitFileEntry, bucket: 'staged' | 'unstaged') => void;
  onStage: (files: string[]) => void;
  onUnstage: (files: string[]) => void;
  onDiscard: (files: string[]) => void;
  onDiscardAll: (files: string[]) => void;
}

export function GitChangeList({
  staged,
  unstaged,
  untracked,
  conflicted,
  selectedPath,
  selectedBucket,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  onDiscardAll,
}: Props) {
  // VS Code convention: "Changes" rolls up modified-and-tracked AND untracked
  // files into one bucket. Each row keeps its origin so the action calls the
  // right API (untracked still goes through `git add`, which `stage` does).
  const changes: Array<{ file: GitFileEntry; bucket: ChangeBucket }> = [
    ...unstaged.map((f) => ({ file: f, bucket: 'unstaged' as const })),
    ...untracked.map((f) => ({ file: f, bucket: 'untracked' as const })),
  ];

  if (staged.length === 0 && changes.length === 0 && conflicted.length === 0) {
    return <div style={emptyMessage}>No changes</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {conflicted.length > 0 && (
        <Section title="Merge Changes" count={conflicted.length} tone="warning">
          {conflicted.map((file) => (
            <GitChangeRow
              key={`conflicted:${file.path}`}
              file={file}
              isSelected={false}
              onClick={() => {}}
              actions={null}
            />
          ))}
        </Section>
      )}

      {staged.length > 0 && (
        <Section
          title="Staged Changes"
          count={staged.length}
          actions={[
            {
              label: 'Unstage All Changes',
              icon: <Minus size={12} />,
              onClick: () => onUnstage(staged.map((f) => f.path)),
            },
          ]}
        >
          {staged.map((file) => {
            const isSelected = selectedPath === file.path && selectedBucket === 'staged';
            return (
              <GitChangeRow
                key={`staged:${file.path}`}
                file={file}
                isSelected={isSelected}
                onClick={() => onSelect(file, 'staged')}
                actions={
                  <RowBtn onClick={() => onUnstage([file.path])} title="Unstage Changes">
                    <Minus size={12} />
                  </RowBtn>
                }
              />
            );
          })}
        </Section>
      )}

      {changes.length > 0 && (
        <Section
          title="Changes"
          count={changes.length}
          actions={[
            {
              label: 'Discard All Changes',
              icon: <Trash2 size={12} />,
              danger: true,
              onClick: () => onDiscardAll(changes.map((c) => c.file.path)),
            },
            {
              label: 'Stage All Changes',
              icon: <Plus size={12} />,
              onClick: () => onStage(changes.map((c) => c.file.path)),
            },
          ]}
        >
          {changes.map(({ file }) => {
            const isSelected = selectedPath === file.path && selectedBucket === 'unstaged';
            return (
              <GitChangeRow
                key={`unstaged:${file.path}`}
                file={file}
                isSelected={isSelected}
                onClick={() => onSelect(file, 'unstaged')}
                actions={
                  <>
                    <RowBtn
                      onClick={() => onDiscard([file.path])}
                      title="Discard Changes"
                      danger
                    >
                      <Trash2 size={12} />
                    </RowBtn>
                    <RowBtn onClick={() => onStage([file.path])} title="Stage Changes">
                      <Plus size={12} />
                    </RowBtn>
                  </>
                }
              />
            );
          })}
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  tone,
  actions,
  children,
}: {
  title: string;
  count: number;
  tone?: 'warning';
  actions?: { label: string; icon: React.ReactNode; onClick: () => void; danger?: boolean }[];
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: tone === 'warning' ? 'var(--accent-amber)' : 'var(--text-secondary)',
          backgroundColor: 'var(--bg-sidebar)',
          borderTop: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
          position: 'sticky',
          top: 0,
          zIndex: 1,
          minHeight: 24,
        }}
      >
        <span style={{ flex: 1 }}>
          {title} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>({count})</span>
        </span>
        {actions && (
          <div
            style={{
              display: 'flex',
              gap: 2,
              visibility: hover ? 'visible' : 'hidden',
            }}
          >
            {actions.map((a, i) => (
              <button
                key={i}
                type="button"
                onClick={a.onClick}
                title={a.label}
                style={{
                  ...iconBtn,
                  color: a.danger ? 'var(--status-error)' : 'var(--text-muted)',
                }}
              >
                {a.icon}
              </button>
            ))}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function RowBtn({
  onClick,
  title,
  children,
  danger,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{ ...iconBtn, color: danger ? 'var(--status-error)' : 'var(--text-muted)' }}
    >
      {children}
    </button>
  );
}

const iconBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 18,
  height: 18,
  border: 'none',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  borderRadius: 'var(--radius-snug)',
};

const emptyMessage: React.CSSProperties = {
  padding: 24,
  color: 'var(--text-muted)',
  fontSize: 13,
  textAlign: 'center',
};
