import React, { useState } from 'react';
import { toast } from 'react-hot-toast';
import { useAppStore } from '../../stores/appStore';
import { validateNewPath } from '../../lib/filePath';
import { useFileUpload } from '../../lib/useFileUpload';
import { FileTree } from '../main-pane/file-viewer/FileTree';
import { ContextMenu } from '../context-menu/ContextMenu';
import { SidebarSection } from './SidebarSection';
import { SidebarFileTreeActions } from './SidebarFileTreeActions';

interface Props {
  projectId: string;
}

export function SidebarFileViewerSection({ projectId }: Props) {
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
  // project so the input doesn't unmount mid-upload when the section
  // collapses/expands.
  const { openPicker, hiddenInput } = useFileUpload(projectId);

  // Header context menu (right-click on desktop, long-press on mobile) — its
  // only entry uploads to the project root. Coordinates come from the touch
  // event / mouse event so the menu lands under the user's finger / cursor.
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);

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
      title="FILE VIEWER"
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
        variant="sidebar"
        selectedPath={openPath}
        refreshKey={refreshKey}
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
