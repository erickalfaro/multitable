import React, { useMemo, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useAppStore } from '../../stores/appStore';
import { validateNewPath } from '../../lib/filePath';
import { useFileUpload } from '../../lib/useFileUpload';
import { emphasisFill } from '../../lib/emphasis';
import type { GitFileStatus } from '../../lib/types';
import { FileTree } from '../main-pane/file-viewer/FileTree';
import { ContextMenu } from '../context-menu/ContextMenu';
import { SidebarSection } from './SidebarSection';
import { SidebarFileTreeActions } from './SidebarFileTreeActions';

interface Props {
  projectId: string;
}

// Multi-bucket priority when the same path appears in several git buckets
// (e.g. staged-added + further working-tree edits): conflicted wins, then
// new-file green, then modified amber — VS Code's precedence.
const STATUS_RANK: Record<GitFileStatus, number> = {
  conflicted: 3,
  untracked: 2,
  added: 2,
  modified: 1,
  renamed: 1,
  copied: 1,
  deleted: 0,
};

/**
 * The unified workspace EXPLORER (IDE-style): a slim branch row on top — the
 * project's source-control entry point, click opens the Git panel — then the
 * file tree, whose filenames tint by git status. Merges the old SOURCE
 * CONTROL and FILE VIEWER sections into one surface so git state lives where
 * the files are.
 */
export function SidebarExplorerSection({ projectId }: Props) {
  const status = useAppStore((s) => s.gitByProject[projectId]);
  const isGitSelected = useAppStore((s) => s.selectedGitProjectId === projectId);
  const setSelectedGitProject = useAppStore((s) => s.setSelectedGitProject);

  const setSelectedFileViewer = useAppStore((s) => s.setSelectedFileViewer);
  const setFileViewerOpenPath = useAppStore((s) => s.setFileViewerOpenPath);
  const openPath = useAppStore((s) => s.fileViewerOpenPath[projectId] ?? null);
  const refreshKey = useAppStore((s) => s.fileViewerRefreshKey[projectId] ?? 0);

  // Resolve the session that "add to context" attaches to — but ONLY when
  // this project is the one the user is currently focused on. Adding files
  // across projects (e.g. Project B's tree while a Project A session is
  // selected) is not allowed, so the + stays disabled there.
  //
  // - selected process is a session in THIS project  -> that session
  // - this project's File Viewer is the foreground surface -> its
  //   most-recently-active session (so browsing files here still works)
  // - otherwise -> null (disabled)
  const activeSessionId = useAppStore((s) => {
    const sel = s.selectedProcessId;
    if (sel && s.sessions[sel]?.projectId === projectId) return sel;
    if (s.selectedFileViewerProjectId !== projectId) return null;
    let best: string | null = null;
    let bestRecency = -1;
    for (const sess of Object.values(s.sessions)) {
      if (sess.projectId !== projectId) continue;
      const recency = sess.claudeState?.lastActivity || sess.lastActiveAt || sess.createdAt || 0;
      if (recency > bestRecency) {
        bestRecency = recency;
        best = sess.id;
      }
    }
    return best;
  });

  const [newFileMode, setNewFileMode] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');

  // Hidden <input type="file" multiple> + per-file upload pipeline. One per
  // project so the input doesn't unmount mid-upload.
  const { openPicker, hiddenInput } = useFileUpload(projectId);

  // Header context menu (right-click on desktop, long-press on mobile) — its
  // only entry uploads to the project root.
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);

  // project-relative path -> git status, for the tree's filename tints.
  const gitStatusByPath = useMemo(() => {
    const map = new Map<string, GitFileStatus>();
    if (!status?.isRepo) return map;
    for (const bucket of [status.staged, status.unstaged, status.untracked, status.conflicted]) {
      for (const f of bucket) {
        const prev = map.get(f.path);
        if (!prev || STATUS_RANK[f.status] >= STATUS_RANK[prev]) map.set(f.path, f.status);
      }
    }
    return map;
  }, [status]);

  const showBranchRow = !(status && status.isRepo === false);
  const branchLabel =
    status?.branch ?? (status?.head ? status.head.slice(0, 7) : 'no branch');
  const unstagedCount = status ? status.unstaged.length + status.untracked.length : 0;
  const stagedCount = status ? status.staged.length : 0;
  const conflictedCount = status ? status.conflicted.length : 0;
  const totalChanges = unstagedCount + stagedCount + conflictedCount;

  const createNewFile = () => {
    const err = validateNewPath(newFilePath);
    if (err) {
      toast.error(err);
      return;
    }
    const p = newFilePath.trim();
    setFileViewerOpenPath(projectId, p, { isNew: true });
    setSelectedFileViewer(projectId);
    setNewFileMode(false);
    setNewFilePath('');
  };

  return (
    <SidebarSection
      title="Explorer"
      onAdd={() => {
        setNewFileMode((v) => !v);
        setNewFilePath('');
      }}
      onHeaderRequestMenu={(x, y) => setHeaderMenu({ x, y })}
    >
      {hiddenInput}
      {headerMenu && (
        <ContextMenu
          position={{ x: headerMenu.x, y: headerMenu.y }}
          items={[
            {
              label: 'Upload file(s) to project root',
              action: () => openPicker(''),
            },
          ]}
          onClose={() => setHeaderMenu(null)}
        />
      )}

      {/* Branch row — the source-control entry point. The branch name IS the
          label (no "Source Control" text); click opens the Git panel. */}
      {showBranchRow && (
        <div
          className={'mt-sidebar-item' + (isGitSelected ? ' is-selected' : '')}
          onClick={() => setSelectedGitProject(projectId)}
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '4px 10px 4px 12px',
            margin: '1px 0',
            cursor: 'pointer',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            position: 'relative',
            borderRadius: 6,
            ...(isGitSelected
              ? emphasisFill('var(--accent-amber)', { fill: 12, tone: 'strong' })
              : { background: 'transparent', boxShadow: 'none' }),
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 12,
              flexShrink: 0,
              color: 'var(--text-secondary)',
            }}
          >
            <GitBranch size={12} />
          </div>
          <span
            style={{
              marginLeft: 10,
              flex: 1,
              minWidth: 0,
              fontSize: 13.5,
              lineHeight: 1.3,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: isGitSelected ? 600 : 500,
            }}
          >
            {branchLabel}
          </span>
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 10.5,
                color: 'var(--text-faint)',
                flexShrink: 0,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {status.ahead > 0 ? `↑${status.ahead}` : ''}
              {status.behind > 0 ? `↓${status.behind}` : ''}
            </span>
          )}
          {status && totalChanges > 0 && (
            <span
              title={`${stagedCount} staged, ${unstagedCount} unstaged${conflictedCount ? `, ${conflictedCount} conflicted` : ''}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                marginLeft: 6,
                color: conflictedCount > 0 ? 'var(--status-error)' : 'var(--text-muted)',
                fontSize: 10,
                fontWeight: 500,
                flexShrink: 0,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {unstagedCount}+{stagedCount}
              {conflictedCount > 0 ? ` !${conflictedCount}` : ''}
            </span>
          )}
          {status && totalChanges === 0 && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 10.5,
                color: 'var(--text-faint)',
                flexShrink: 0,
              }}
            >
              clean
            </span>
          )}
        </div>
      )}

      {newFileMode && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 10px 6px 12px',
          }}
        >
          <input
            autoFocus
            value={newFilePath}
            onChange={(e) => setNewFilePath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createNewFile();
              if (e.key === 'Escape') {
                setNewFileMode(false);
                setNewFilePath('');
              }
            }}
            placeholder="e.g. .claude/notes/scratch.md"
            style={{
              flex: 1,
              minWidth: 0,
              padding: '4px 6px',
              fontSize: 11.5,
              fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-snug)',
              color: 'var(--text-primary)',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={createNewFile}
            style={{
              padding: '4px 8px',
              fontSize: 11.5,
              fontWeight: 500,
              fontFamily: 'inherit',
              border: 'none',
              borderRadius: 'var(--radius-snug)',
              background: 'var(--text-primary)',
              color: 'var(--bg-elevated)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            Create
          </button>
        </div>
      )}

      <FileTree
        projectId={projectId}
        selectedPath={openPath}
        refreshKey={refreshKey}
        gitStatusByPath={gitStatusByPath}
        onOpenFile={(rel) => {
          setFileViewerOpenPath(projectId, rel);
          setSelectedFileViewer(projectId);
        }}
        onUploadHere={(dir) => openPicker(dir)}
        fileActions={(entry) => (
          <SidebarFileTreeActions filePath={entry.path} targetSessionId={activeSessionId} />
        )}
      />
    </SidebarSection>
  );
}
