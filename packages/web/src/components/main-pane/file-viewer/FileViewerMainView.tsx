import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, FolderTree } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useAppStore } from '../../../stores/appStore';
import { IconButton } from '../../ui';
import { api } from '../../../lib/api';
import { FileEditor, type LoadState } from './FileEditor';

interface Props {
  projectId: string;
}

// The file tree now lives in the left sidebar (SidebarExplorerSection); this
// component is the center editor host. The currently-open path comes from the
// store (set by the sidebar tree) so the two surfaces stay in sync; draft /
// load / save state stays local here.
export function FileViewerMainView({ projectId }: Props) {
  const project = useAppStore((s) => s.projects.find((p) => p.id === projectId));
  const setSelectedFileViewer = useAppStore((s) => s.setSelectedFileViewer);
  const setFileViewerOpenPath = useAppStore((s) => s.setFileViewerOpenPath);
  const bumpFileViewerRefresh = useAppStore((s) => s.bumpFileViewerRefresh);
  const openPath = useAppStore((s) => s.fileViewerOpenPath[projectId] ?? null);
  const isNew = useAppStore((s) => s.fileViewerNewFile[projectId] ?? false);

  const [openContent, setOpenContent] = useState('');
  const [draft, setDraft] = useState('');
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The last path whose content is actually committed in openContent/draft.
  // Dirtiness and the in-app discard guard are relative to this, not openPath
  // (which may have just changed via the store before we load it).
  const prevPathRef = useRef<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const openContentRef = useRef(openContent);
  openContentRef.current = openContent;

  const isDirty = prevPathRef.current !== null && draft !== openContent;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  // React to store-driven path changes: guard unsaved edits, then load.
  useEffect(() => {
    if (
      openPath !== prevPathRef.current &&
      prevPathRef.current !== null &&
      draftRef.current !== openContentRef.current
    ) {
      if (!window.confirm(`Discard unsaved changes to ${prevPathRef.current}?`)) {
        // Roll the store back to the still-open file. This re-fires the effect
        // with openPath === prevPathRef.current → the no-op branch below.
        setFileViewerOpenPath(projectId, prevPathRef.current);
        return;
      }
    }

    if (!openPath) {
      prevPathRef.current = null;
      setOpenContent('');
      setDraft('');
      setLoadState('idle');
      setLoadError(null);
      return;
    }

    if (openPath === prevPathRef.current) {
      // Already committed (rollback re-fire, or the new→saved flag flip).
      return;
    }

    if (isNew) {
      prevPathRef.current = openPath;
      setOpenContent('');
      setDraft('');
      setLoadState('missing');
      setLoadError(null);
      return;
    }

    let cancelled = false;
    setLoadState('loading');
    setLoadError(null);
    api.projects
      .readFile(projectId, openPath)
      .then((res) => {
        if (cancelled) return;
        prevPathRef.current = openPath;
        setOpenContent(res.content);
        setDraft(res.content);
        setLoadState(res.exists ? 'ready' : 'missing');
      })
      .catch((err: any) => {
        if (cancelled) return;
        prevPathRef.current = openPath;
        setOpenContent('');
        setDraft('');
        setLoadState('error');
        setLoadError(err?.message || 'Failed to open file');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, openPath, isNew, setFileViewerOpenPath]);

  const save = useCallback(async () => {
    if (!openPath || saving || !isDirty) return;
    setSaving(true);
    try {
      await api.projects.saveFile(projectId, openPath, draft);
      setOpenContent(draft);
      setLoadState('ready');
      bumpFileViewerRefresh(projectId);
      // Clear the "new file" flag now that it exists on disk.
      if (isNew) setFileViewerOpenPath(projectId, openPath, { isNew: false });
      toast.success(`Saved ${openPath}`);
    } catch (err: any) {
      toast.error(`Save failed: ${err?.message || err}`);
    } finally {
      setSaving(false);
    }
  }, [
    draft,
    isDirty,
    isNew,
    openPath,
    projectId,
    saving,
    bumpFileViewerRefresh,
    setFileViewerOpenPath,
  ]);

  // Warn on tab close / reload while there are unsaved edits.
  //
  // Skipped on mobile / touch devices for two reasons:
  //   1. Chrome bfcache: a registered `beforeunload` listener — even one
  //      that does nothing — disqualifies the page from bfcache. On mobile
  //      that means every app-background triggers a hard reload on return,
  //      which is a far worse UX than the warning would have been.
  //   2. Mobile browsers (Chrome Android, iOS Safari) suppress the
  //      confirmation dialog entirely — the listener fires but no prompt
  //      is shown — so it has no functional value there anyway.
  // The user-initiated close flow (`guardedClose` below) still gates
  // destructive in-app navigation via `window.confirm`, which DOES work
  // on mobile.
  useEffect(() => {
    if (!isDirty) return;
    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches
    ) {
      return;
    }
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const guardedClose = useCallback(() => {
    if (
      isDirtyRef.current &&
      !window.confirm(`Discard unsaved changes to ${openPath ?? 'this file'}?`)
    ) {
      return;
    }
    // Suppress the load-effect's own guard (we just confirmed) before the
    // store path goes null.
    prevPathRef.current = null;
    setFileViewerOpenPath(projectId, null);
    setSelectedFileViewer(null);
  }, [openPath, projectId, setFileViewerOpenPath, setSelectedFileViewer]);

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
        <IconButton size="sm" onClick={guardedClose} label="Close file viewer">
          <X size={13} />
        </IconButton>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
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
