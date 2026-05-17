import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, FolderTree, FilePlus } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useAppStore } from '../../../stores/appStore';
import { IconButton } from '../../ui';
import { api } from '../../../lib/api';
import { FileTree } from './FileTree';
import { FileEditor, type LoadState } from './FileEditor';

interface Props {
  projectId: string;
}

// Mirror the daemon's POST /file-content validation so we fail fast in the UI.
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

function validateNewPath(raw: string): string | null {
  const p = raw.trim();
  if (!p) return 'Enter a file path';
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) return 'Path must be relative to the project';
  if (p.includes('\\')) return 'Use forward slashes (/)';
  if (p.endsWith('/')) return 'Path must point to a file, not a directory';
  if (p.split('/').includes('..')) return 'Path may not contain ".."';
  if (hasControlChar(p)) return 'Path contains invalid characters';
  return null;
}

export function FileViewerMainView({ projectId }: Props) {
  const project = useAppStore((s) => s.projects.find((p) => p.id === projectId));
  const setSelectedFileViewer = useAppStore((s) => s.setSelectedFileViewer);

  const [openPath, setOpenPath] = useState<string | null>(null);
  const [openContent, setOpenContent] = useState('');
  const [draft, setDraft] = useState('');
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);

  const [newFileMode, setNewFileMode] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');

  const isDirty = openPath !== null && draft !== openContent;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  const confirmDiscard = useCallback(() => {
    if (!isDirtyRef.current) return true;
    return window.confirm(`Discard unsaved changes to ${openPath ?? 'this file'}?`);
  }, [openPath]);

  const openFile = useCallback(
    async (relPath: string) => {
      if (relPath === openPath && !isDirtyRef.current) return;
      if (!confirmDiscard()) return;
      setNewFileMode(false);
      setLoadState('loading');
      setLoadError(null);
      try {
        const res = await api.projects.readFile(projectId, relPath);
        setOpenPath(relPath);
        setOpenContent(res.content);
        setDraft(res.content);
        setLoadState(res.exists ? 'ready' : 'missing');
      } catch (err: any) {
        setOpenPath(relPath);
        setOpenContent('');
        setDraft('');
        setLoadState('error');
        setLoadError(err?.message || 'Failed to open file');
      }
    },
    [confirmDiscard, openPath, projectId],
  );

  const createNewFile = useCallback(() => {
    const err = validateNewPath(newFilePath);
    if (err) {
      toast.error(err);
      return;
    }
    if (!confirmDiscard()) return;
    const p = newFilePath.trim();
    setOpenPath(p);
    setOpenContent('');
    setDraft('');
    setLoadState('missing');
    setLoadError(null);
    setNewFileMode(false);
    setNewFilePath('');
  }, [confirmDiscard, newFilePath]);

  const save = useCallback(async () => {
    if (!openPath || saving || !isDirty) return;
    setSaving(true);
    try {
      await api.projects.saveFile(projectId, openPath, draft);
      setOpenContent(draft);
      setLoadState('ready');
      setTreeRefreshKey((k) => k + 1);
      toast.success(`Saved ${openPath}`);
    } catch (err: any) {
      toast.error(`Save failed: ${err?.message || err}`);
    } finally {
      setSaving(false);
    }
  }, [draft, isDirty, openPath, projectId, saving]);

  // Warn on tab close / reload while there are unsaved edits.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const guardedClose = useCallback(() => {
    if (!confirmDiscard()) return;
    setSelectedFileViewer(null);
  }, [confirmDiscard, setSelectedFileViewer]);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        backgroundColor: 'var(--bg-primary)',
      }}
    >
      <div
        style={{
          height: 38,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 10px 0 14px',
          gap: 8,
          borderBottom: '1px solid var(--border)',
          backgroundColor: 'var(--bg-sidebar)',
        }}
      >
        <FolderTree size={13} style={{ color: 'var(--text-secondary)' }} />
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-primary)',
            letterSpacing: '0.01em',
          }}
        >
          File Viewer
        </span>
        {project && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· {project.name}</span>
        )}
        <div style={{ flex: 1 }} />
        <IconButton
          size="sm"
          onClick={() => {
            setNewFileMode((v) => !v);
            setNewFilePath('');
          }}
          label="New file"
        >
          <FilePlus size={13} />
        </IconButton>
        <IconButton size="sm" onClick={guardedClose} label="Close file viewer">
          <X size={13} />
        </IconButton>
      </div>

      {newFileMode && (
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--border)',
            backgroundColor: 'var(--bg-elevated)',
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
            placeholder="Relative path, e.g. .claude/notes/scratch.md"
            style={{
              flex: 1,
              minWidth: 0,
              padding: '5px 8px',
              fontSize: 12,
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
              padding: '5px 12px',
              fontSize: 12,
              fontWeight: 500,
              fontFamily: 'inherit',
              border: 'none',
              borderRadius: 'var(--radius-snug)',
              background: 'var(--text-primary)',
              color: 'var(--bg-elevated)',
              cursor: 'pointer',
            }}
          >
            Create
          </button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <FileTree
          projectId={projectId}
          selectedPath={openPath}
          onOpenFile={openFile}
          refreshKey={treeRefreshKey}
        />
        <FileEditor
          path={openPath}
          value={draft}
          isDirty={isDirty}
          saving={saving}
          loadState={loadState}
          loadError={loadError}
          onChange={setDraft}
          onSave={save}
        />
      </div>
    </div>
  );
}
