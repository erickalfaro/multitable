import React, { useState } from 'react';
import { toast } from 'react-hot-toast';
import { useAppStore } from '../../stores/appStore';
import { validateNewPath } from '../../lib/filePath';
import { FileTree } from '../main-pane/file-viewer/FileTree';
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

  // Active session for this project: the explicit selection if it's a session
  // in this project, else the most-recently-active one (same recency
  // expression the sidebar sorts by). null → "add to context" is disabled.
  const activeSessionId = useAppStore((s) => {
    const sel = s.selectedProcessId;
    if (sel && s.sessions[sel]?.projectId === projectId) return sel;
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
    >
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
        fileActions={(entry) => (
          <SidebarFileTreeActions filePath={entry.path} targetSessionId={activeSessionId} />
        )}
      />
    </SidebarSection>
  );
}
