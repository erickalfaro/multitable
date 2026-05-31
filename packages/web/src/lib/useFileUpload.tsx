import React, { useCallback, useRef } from 'react';
import { toast } from 'react-hot-toast';
import { api } from './api';
import { useAppStore } from '../stores/appStore';

interface UseFileUploadResult {
  // Open the OS file picker, then upload every selected file into `targetDir`
  // (empty string = project root). The same hidden input is reused across
  // calls — we just stash the target before triggering .click().
  openPicker: (targetDir: string) => void;
  // Mount once per consumer. Spread into a sidebar / header somewhere stable
  // so the picker doesn't unmount mid-flight.
  hiddenInput: React.ReactNode;
}

/**
 * File Viewer upload helper. Returns a single hidden <input type="file" multiple>
 * plus an `openPicker(targetDir)` trigger. Every selected file is POSTed as a
 * raw body to /api/projects/:id/file-upload sequentially (one fetch per file)
 * so a 20 MB file doesn't block the next pick and a failure doesn't poison the
 * batch. Toasts surface per-file success/failure; the file tree refreshes once
 * at the end regardless of partial failure so anything that *did* land is
 * visible immediately.
 *
 * Mobile / Tailscale: a stock <input type="file"> just opens the local OS
 * picker on iOS Safari / Chrome Android, which is the whole point — the
 * Tailscale tunnel is irrelevant to the picker, only to the upload bytes.
 */
export function useFileUpload(projectId: string): UseFileUploadResult {
  const inputRef = useRef<HTMLInputElement>(null);
  // Stash the target across the click() → change() boundary. We can't rely
  // on a closure because openPicker is called from many places (header,
  // multiple folder rows) and the input persists across them.
  const targetDirRef = useRef<string>('');
  const bumpFileViewerRefresh = useAppStore((s) => s.bumpFileViewerRefresh);

  const openPicker = useCallback((targetDir: string) => {
    targetDirRef.current = targetDir || '';
    const el = inputRef.current;
    if (!el) return;
    // Clear any previous selection so picking the same file again still fires
    // change. Some mobile browsers (older WebKit) need this on the element
    // itself, not just after onChange.
    el.value = '';
    el.click();
  }, []);

  const onChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      // Reset so the same file can be picked again later.
      e.target.value = '';
      if (files.length === 0) return;

      const targetDir = targetDirRef.current;
      const dirLabel = targetDir ? targetDir : 'project root';

      let successCount = 0;
      for (const file of files) {
        const toastId = toast.loading(`Uploading ${file.name}…`);
        try {
          const result = await api.projects.uploadFile(projectId, targetDir, file);
          successCount += 1;
          toast.success(`Uploaded ${result.path}`, { id: toastId });
        } catch (err: any) {
          const status = err?.status;
          if (status === 409) {
            toast.error(`${file.name}: already exists in ${dirLabel}`, { id: toastId });
          } else if (status === 413) {
            toast.error(`${file.name}: too large (20 MB limit)`, { id: toastId });
          } else {
            toast.error(`${file.name}: ${err?.message || 'upload failed'}`, { id: toastId });
          }
        }
      }

      // Refresh the file tree once whether or not every file landed — the user
      // wants to see what made it in.
      if (successCount > 0) {
        bumpFileViewerRefresh(projectId);
      }
    },
    [projectId, bumpFileViewerRefresh],
  );

  const hiddenInput = (
    <input
      ref={inputRef}
      type="file"
      multiple
      onChange={onChange}
      style={{ display: 'none' }}
    />
  );

  return { openPicker, hiddenInput };
}
