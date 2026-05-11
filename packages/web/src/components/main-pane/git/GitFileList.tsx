import { Plus, Minus, FilePlus, FileMinus, FileEdit, FileWarning, Trash2 } from 'lucide-react';
import type { GitFileEntry, GitFileStatus } from '../../../lib/types';

interface Section {
  title: string;
  files: GitFileEntry[];
  bucket: 'staged' | 'unstaged' | 'untracked' | 'conflicted';
}

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
  const sections: Section[] = [
    { title: 'Conflicts', files: conflicted, bucket: 'conflicted' },
    { title: 'Staged', files: staged, bucket: 'staged' },
    { title: 'Unstaged', files: unstaged, bucket: 'unstaged' },
    { title: 'Untracked', files: untracked, bucket: 'untracked' },
  ];

  const empty =
    staged.length === 0 &&
    unstaged.length === 0 &&
    untracked.length === 0 &&
    conflicted.length === 0;

  if (empty) {
    return (
      <div
        style={{
          padding: 24,
          color: 'var(--text-muted)',
          fontSize: 13,
          textAlign: 'center',
        }}
      >
        Working tree is clean.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {sections.map(({ title, files, bucket }) => {
        if (files.length === 0) return null;
        const stagedTitle = bucket === 'staged';
        const unstagedTitle = bucket === 'unstaged' || bucket === 'untracked';
        return (
          <div key={bucket}>
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
                color: 'var(--text-secondary)',
                backgroundColor: 'var(--bg-sidebar)',
                borderTop: '1px solid var(--border)',
                borderBottom: '1px solid var(--border)',
                position: 'sticky',
                top: 0,
                zIndex: 1,
              }}
            >
              <span style={{ flex: 1 }}>
                {title} ({files.length})
              </span>
              {stagedTitle && (
                <button
                  type="button"
                  onClick={() => onUnstage(files.map((f) => f.path))}
                  title="Unstage all"
                  style={iconBtn}
                >
                  <Minus size={12} />
                </button>
              )}
              {unstagedTitle && (
                <button
                  type="button"
                  onClick={() => onStage(files.map((f) => f.path))}
                  title="Stage all"
                  style={iconBtn}
                >
                  <Plus size={12} />
                </button>
              )}
            </div>
            {files.map((file) => {
              const isSelected =
                selectedPath === file.path &&
                ((bucket === 'staged' && selectedBucket === 'staged') ||
                  (bucket !== 'staged' && selectedBucket === 'unstaged'));
              const isChecked = selectedPaths.has(`${bucket}:${file.path}`);
              const canCheck = bucket === 'staged' || bucket === 'unstaged' || bucket === 'untracked';
              return (
                <div
                  key={`${bucket}:${file.path}`}
                  onClick={() => {
                    if (bucket === 'staged') onSelect(file, 'staged');
                    else if (bucket === 'unstaged' || bucket === 'untracked') onSelect(file, 'unstaged');
                  }}
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
                    borderLeft: isSelected
                      ? '2px solid var(--accent-blue)'
                      : '2px solid transparent',
                  }}
                >
                  {canCheck ? (
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => onToggleSelect(file, bucket)}
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
                  <RowActions
                    bucket={bucket}
                    file={file}
                    onStage={onStage}
                    onUnstage={onUnstage}
                    onDiscard={onDiscard}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
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

function RowActions({
  bucket,
  file,
  onStage,
  onUnstage,
  onDiscard,
}: {
  bucket: Section['bucket'];
  file: GitFileEntry;
  onStage: (files: string[]) => void;
  onUnstage: (files: string[]) => void;
  onDiscard: (files: string[]) => void;
}) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div style={{ display: 'flex', gap: 4 }} onClick={stop}>
      {bucket === 'staged' && (
        <button
          type="button"
          onClick={() => onUnstage([file.path])}
          title="Unstage"
          style={iconBtn}
        >
          <Minus size={12} />
        </button>
      )}
      {(bucket === 'unstaged' || bucket === 'untracked') && (
        <button
          type="button"
          onClick={() => onStage([file.path])}
          title="Stage"
          style={iconBtn}
        >
          <Plus size={12} />
        </button>
      )}
      {(bucket === 'unstaged' || bucket === 'untracked') && (
        <button
          type="button"
          onClick={() => onDiscard([file.path])}
          title="Discard changes"
          style={{ ...iconBtn, color: 'var(--status-error)' }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
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
