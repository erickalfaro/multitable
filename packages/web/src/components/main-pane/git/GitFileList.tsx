import { Plus, Minus, FilePlus, FileMinus, FileEdit, FileWarning, Trash2 } from 'lucide-react';
import type { GitFileEntry, GitFileStatus } from '../../../lib/types';

interface Props {
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
  conflicted: GitFileEntry[];
  selectedPath: string | null;
  selectedBucket: 'staged' | 'unstaged' | null;
  selectedPaths: Set<string>;
  onSelect: (file: GitFileEntry, bucket: 'staged' | 'unstaged') => void;
  onToggleSelect: (file: GitFileEntry, bucket: 'staged' | 'unstaged' | 'untracked') => void;
  onStage: (files: string[]) => void;
  onUnstage: (files: string[]) => void;
  onDiscard: (files: string[]) => void;
}

type ChangeBucket = 'unstaged' | 'untracked';

export function GitFileList({
  staged,
  unstaged,
  untracked,
  conflicted,
  selectedPath,
  selectedBucket,
  selectedPaths,
  onSelect,
  onToggleSelect,
  onStage,
  onUnstage,
  onDiscard,
}: Props) {
  // VS Code convention: "Changes" rolls up modified-and-tracked AND untracked
  // files into one bucket. Each row keeps its origin so the action calls the
  // right API (untracked still goes through `git add`, which `stage` does).
  const changes: Array<{ file: GitFileEntry; bucket: ChangeBucket }> = [
    ...unstaged.map((f) => ({ file: f, bucket: 'unstaged' as const })),
    ...untracked.map((f) => ({ file: f, bucket: 'untracked' as const })),
  ];

  if (staged.length === 0 && changes.length === 0 && conflicted.length === 0) {
    return <div style={emptyMessage}>Working tree is clean.</div>;
  }

  const stageAll = () => onStage(changes.map((c) => c.file.path));
  const unstageAll = () => onUnstage(staged.map((f) => f.path));

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {conflicted.length > 0 && (
        <SectionHeader title="Merge Conflicts" count={conflicted.length} tone="warning" />
      )}
      {conflicted.map((file) => (
        <FileRow
          key={`conflicted:${file.path}`}
          file={file}
          bucket="conflicted"
          isSelected={false}
          isChecked={false}
          canCheck={false}
          onClick={() => {}}
          onToggleSelect={() => {}}
          actions={null}
        />
      ))}

      <SectionHeader
        title="Staged Changes"
        count={staged.length}
        action={
          staged.length > 0 ? (
            <HeaderBtn onClick={unstageAll} title="Unstage all">
              <Minus size={12} />
            </HeaderBtn>
          ) : null
        }
      />
      {staged.length === 0 ? (
        <EmptyHint>Nothing staged yet — click + on a file below.</EmptyHint>
      ) : (
        staged.map((file) => {
          const isSelected = selectedPath === file.path && selectedBucket === 'staged';
          const isChecked = selectedPaths.has(`staged:${file.path}`);
          return (
            <FileRow
              key={`staged:${file.path}`}
              file={file}
              bucket="staged"
              isSelected={isSelected}
              isChecked={isChecked}
              canCheck
              onClick={() => onSelect(file, 'staged')}
              onToggleSelect={() => onToggleSelect(file, 'staged')}
              actions={
                <RowBtn onClick={() => onUnstage([file.path])} title="Unstage">
                  <Minus size={12} />
                </RowBtn>
              }
            />
          );
        })
      )}

      <SectionHeader
        title="Changes"
        count={changes.length}
        action={
          changes.length > 0 ? (
            <HeaderBtn onClick={stageAll} title="Stage all">
              <Plus size={12} />
            </HeaderBtn>
          ) : null
        }
      />
      {changes.length === 0 ? (
        <EmptyHint>No file changes in your working tree.</EmptyHint>
      ) : (
        changes.map(({ file, bucket }) => {
          const isSelected = selectedPath === file.path && selectedBucket === 'unstaged';
          const isChecked = selectedPaths.has(`${bucket}:${file.path}`);
          return (
            <FileRow
              key={`${bucket}:${file.path}`}
              file={file}
              bucket={bucket}
              isSelected={isSelected}
              isChecked={isChecked}
              canCheck
              onClick={() => onSelect(file, 'unstaged')}
              onToggleSelect={() => onToggleSelect(file, bucket)}
              actions={
                <>
                  <RowBtn onClick={() => onStage([file.path])} title="Stage">
                    <Plus size={12} />
                  </RowBtn>
                  <RowBtn
                    onClick={() => onDiscard([file.path])}
                    title="Discard changes"
                    danger
                  >
                    <Trash2 size={12} />
                  </RowBtn>
                </>
              }
            />
          );
        })
      )}
    </div>
  );
}

function SectionHeader({
  title,
  count,
  action,
  tone,
}: {
  title: string;
  count: number;
  action?: React.ReactNode;
  tone?: 'warning';
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        fontSize: 11,
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
      }}
    >
      <span style={{ flex: 1 }}>
        {title} ({count})
      </span>
      {action}
    </div>
  );
}

function FileRow({
  file,
  bucket,
  isSelected,
  isChecked,
  canCheck,
  onClick,
  onToggleSelect,
  actions,
}: {
  file: GitFileEntry;
  bucket: 'staged' | 'unstaged' | 'untracked' | 'conflicted';
  isSelected: boolean;
  isChecked: boolean;
  canCheck: boolean;
  onClick: () => void;
  onToggleSelect: () => void;
  actions: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: 'var(--text-primary)',
        cursor: 'pointer',
        backgroundColor: isSelected ? 'var(--bg-hover)' : 'transparent',
        borderLeft: isSelected ? '2px solid var(--accent-blue)' : '2px solid transparent',
      }}
    >
      {canCheck ? (
        <input
          type="checkbox"
          checked={isChecked}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          style={{ cursor: 'pointer' }}
        />
      ) : (
        <span style={{ width: 13, display: 'inline-block' }} />
      )}
      <StatusIcon status={file.status} />
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >
        {file.path}
      </span>
      <StatusBadge status={file.status} />
      {actions && (
        <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
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

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '10px 12px',
        fontSize: 11,
        color: 'var(--text-muted)',
        fontStyle: 'italic',
      }}
    >
      {children}
    </div>
  );
}

function HeaderBtn({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} title={title} style={iconBtn}>
      {children}
    </button>
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
  padding: 2,
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
