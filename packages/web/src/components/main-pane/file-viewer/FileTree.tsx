import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Folder, FileText, Loader2 } from 'lucide-react';
import { api } from '../../../lib/api';
import { useLongPress } from '../../../lib/useLongPress';
import { ContextMenu } from '../../context-menu/ContextMenu';
import { emphasisFill } from '../../../lib/emphasis';
import type { GitFileStatus } from '../../../lib/types';

interface Entry {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: number;
  modifiedAt: number;
}

interface Props {
  projectId: string;
  selectedPath: string | null;
  onOpenFile: (relPath: string) => void;
  refreshKey: number;
  // Optional per-file-row action cluster (e.g. copy-path / add-to-context).
  // Directories never get one. Clicking inside it must not open the file —
  // the renderer wraps it with stopPropagation.
  fileActions?: (entry: { name: string; path: string }) => React.ReactNode;
  // Optional: when set, folder rows show an "Upload file(s) here" entry on
  // right-click (desktop) or long-press (mobile). The arg is the folder's
  // path relative to the project root. Files (non-directories) never trigger
  // this — uploading to a file would be ambiguous.
  onUploadHere?: (targetDir: string) => void;
  // 'panel' = legacy fixed-width bordered column (center File Viewer host);
  // 'sidebar' = full-width, transparent, no own scroll (host scrolls).
  variant?: 'panel' | 'sidebar';
  // Optional git decorations: project-relative path -> status. Changed files'
  // names tint by status (VS Code-style); directories are never decorated.
  gitStatusByPath?: ReadonlyMap<string, GitFileStatus>;
}

const ROOT = '';
const PAGE_SIZE = 50;

// Filename tints per git status. `deleted` is intentionally absent — a
// deleted file no longer appears in the tree. NOTE: --accent-amber is a
// lavender alias in the current theme; the true status hues live in the
// --status-* family (kept consistent with GitChangeRow's icons).
const GIT_TINT: Partial<Record<GitFileStatus, string>> = {
  modified: 'var(--status-warning)',
  renamed: 'var(--status-warning)',
  copied: 'var(--status-warning)',
  added: 'var(--status-running)',
  untracked: 'var(--status-running)',
  conflicted: 'var(--status-error)',
};

interface DirMeta {
  total: number;
  hasMore: boolean;
  truncated: boolean;
}

export function FileTree({
  projectId,
  selectedPath,
  onOpenFile,
  refreshKey,
  fileActions,
  onUploadHere,
  variant = 'panel',
  gitStatusByPath,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenByDir, setChildrenByDir] = useState<Record<string, Entry[]>>({});
  const [metaByDir, setMetaByDir] = useState<Record<string, DirMeta>>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [loadingMoreDirs, setLoadingMoreDirs] = useState<Set<string>>(new Set());
  const [errorByDir, setErrorByDir] = useState<Record<string, string>>({});
  // Folder context menu (right-click + long-press). Position is in client
  // coords because <ContextMenu> uses position: fixed.
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; dir: string } | null>(
    null,
  );

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const childrenRef = useRef(childrenByDir);
  childrenRef.current = childrenByDir;

  // Load (or extend) a directory page-by-page. append=false resets to the first
  // PAGE_SIZE entries (initial expand / refresh); append=true fetches the next page
  // from the current loaded count and appends it.
  const loadDir = useCallback(
    async (dir: string, append = false) => {
      const offset = append ? (childrenRef.current[dir]?.length ?? 0) : 0;
      const spinnerSetter = append ? setLoadingMoreDirs : setLoadingDirs;
      spinnerSetter((s) => new Set(s).add(dir));
      if (!append) {
        setErrorByDir((e) => {
          const next = { ...e };
          delete next[dir];
          return next;
        });
      }
      try {
        const res = await api.projects.filesPage(projectId, {
          path: dir || undefined,
          all: true,
          limit: PAGE_SIZE,
          offset,
        });
        setChildrenByDir((c) => ({
          ...c,
          [dir]: append ? [...(c[dir] ?? []), ...res.entries] : res.entries,
        }));
        setMetaByDir((m) => ({
          ...m,
          [dir]: { total: res.total, hasMore: res.hasMore, truncated: res.truncated },
        }));
      } catch (err: any) {
        if (!append) {
          setErrorByDir((e) => ({ ...e, [dir]: err?.message || 'Failed to read directory' }));
        }
      } finally {
        spinnerSetter((s) => {
          const next = new Set(s);
          next.delete(dir);
          return next;
        });
      }
    },
    [projectId],
  );

  // Initial load + refresh: re-fetch root and any currently-expanded dirs,
  // keeping the expanded set intact so a freshly-saved file shows up.
  useEffect(() => {
    void loadDir(ROOT);
    for (const dir of expandedRef.current) void loadDir(dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, refreshKey, loadDir]);

  const toggleDir = useCallback(
    (dir: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dir)) {
          next.delete(dir);
        } else {
          next.add(dir);
          if (!childrenByDir[dir]) void loadDir(dir);
        }
        return next;
      });
    },
    [childrenByDir, loadDir],
  );

  const renderLevel = (dir: string, depth: number): React.ReactNode => {
    const entries = childrenByDir[dir];
    if (errorByDir[dir]) {
      return (
        <div
          style={{
            padding: '4px 8px',
            paddingLeft: 12 + depth * 14,
            fontSize: 11,
            color: 'var(--status-error)',
          }}
        >
          {errorByDir[dir]}
        </div>
      );
    }
    if (!entries) {
      return loadingDirs.has(dir) ? (
        <div
          style={{
            padding: '4px 8px',
            paddingLeft: 12 + depth * 14,
            fontSize: 11,
            color: 'var(--text-muted)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Loader2 size={11} className="mt-spin" /> Loading…
        </div>
      ) : null;
    }
    if (entries.length === 0) {
      return (
        <div
          style={{
            padding: '4px 8px',
            paddingLeft: 12 + depth * 14,
            fontSize: 11,
            color: 'var(--text-muted)',
            fontStyle: 'italic',
          }}
        >
          empty
        </div>
      );
    }
    const meta = metaByDir[dir];
    const rows = entries.map((entry) => {
      if (entry.type === 'directory') {
        const isOpen = expanded.has(entry.path);
        return (
          <div key={entry.path}>
            <FolderRow
              entry={entry}
              depth={depth}
              isOpen={isOpen}
              onToggle={() => toggleDir(entry.path)}
              onOpenMenu={
                onUploadHere
                  ? (dir, x, y) => setFolderMenu({ dir, x, y })
                  : null
              }
            />
            {isOpen && renderLevel(entry.path, depth + 1)}
          </div>
        );
      }
      const isSelected = entry.path === selectedPath;
      const gitStatus = gitStatusByPath?.get(entry.path);
      const tint = gitStatus ? GIT_TINT[gitStatus] : undefined;
      return (
        <Row
          key={entry.path}
          depth={depth}
          selected={isSelected}
          onClick={() => onOpenFile(entry.path)}
        >
          <span style={{ width: 11, flexShrink: 0 }} />
          <FileText size={12} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
          <Name selected={isSelected} tint={tint}>
            {entry.name}
          </Name>
          {fileActions && (
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}
              onClick={(e) => e.stopPropagation()}
            >
              {fileActions({ name: entry.name, path: entry.path })}
            </div>
          )}
        </Row>
      );
    });

    if (meta?.hasMore) {
      const remaining = Math.max(0, meta.total - entries.length);
      const isLoadingMore = loadingMoreDirs.has(dir);
      rows.push(
        <Row
          key={`__more__${dir}`}
          depth={depth}
          onClick={() => {
            if (!isLoadingMore) void loadDir(dir, true);
          }}
        >
          {isLoadingMore ? (
            <Loader2 size={11} className="mt-spin" style={{ flexShrink: 0 }} />
          ) : (
            <span style={{ width: 11, flexShrink: 0 }} />
          )}
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 11.5,
              color: 'var(--text-muted)',
              fontStyle: 'italic',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {isLoadingMore ? 'Loading…' : `Load more (${remaining} more)`}
          </span>
        </Row>,
      );
    }

    if (meta?.truncated) {
      rows.push(
        <div
          key={`__truncated__${dir}`}
          style={{
            padding: '4px 8px',
            paddingLeft: 12 + depth * 14,
            fontSize: 11,
            color: 'var(--text-faint)',
            fontStyle: 'italic',
          }}
        >
          directory too large to list fully — showing first {meta.total}
        </div>,
      );
    }

    return rows;
  };

  const folderContextMenu =
    folderMenu && onUploadHere ? (
      <ContextMenu
        position={{ x: folderMenu.x, y: folderMenu.y }}
        items={[
          {
            label: 'Upload file(s) here',
            action: () => onUploadHere(folderMenu.dir),
          },
        ]}
        onClose={() => setFolderMenu(null)}
      />
    ) : null;

  if (variant === 'sidebar') {
    return (
      <div style={{ padding: '2px 0' }}>
        {renderLevel(ROOT, 0)}
        {folderContextMenu}
      </div>
    );
  }

  return (
    <div
      style={{
        width: 260,
        flexShrink: 0,
        overflow: 'auto',
        borderRight: '1px solid var(--border)',
        backgroundColor: 'var(--bg-sidebar)',
        padding: '6px 0',
      }}
    >
      {renderLevel(ROOT, 0)}
      {folderContextMenu}
    </div>
  );
}

function Row({
  depth,
  selected,
  onClick,
  onContextMenu,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onTouchCancel,
  children,
}: {
  depth: number;
  selected?: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onTouchStart?: (e: React.TouchEvent) => void;
  onTouchMove?: (e: React.TouchEvent) => void;
  onTouchEnd?: () => void;
  onTouchCancel?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      className="mt-sidebar-item"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px',
        paddingLeft: 11 + depth * 14,
        cursor: 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        ...(selected
          ? emphasisFill('var(--accent-amber)', { fill: 10, ring: 35, on: 'var(--bg-elevated)' })
          : { backgroundColor: 'transparent' }),
        // Suppress iOS long-press text-selection callout — folder rows have
        // userSelect:none above but the callout is governed by a separate prop.
        WebkitTouchCallout: 'none',
      }}
    >
      {children}
    </div>
  );
}

// A folder row that wires right-click + long-press into the menu callback.
// We need this as its own component because useLongPress is a hook and would
// otherwise be called inside renderLevel's .map() — a rules-of-hooks violation
// since folder count varies between renders.
function FolderRow({
  entry,
  depth,
  isOpen,
  onToggle,
  onOpenMenu,
}: {
  entry: Entry;
  depth: number;
  isOpen: boolean;
  onToggle: () => void;
  onOpenMenu: ((dir: string, x: number, y: number) => void) | null;
}) {
  // useLongPress fires its callback without args. We need touch coords to
  // position the menu, so stash the last touch start position in a ref and
  // read it back when the timer fires.
  const lastTouch = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const longPress = useLongPress(() => {
    if (onOpenMenu) onOpenMenu(entry.path, lastTouch.current.x, lastTouch.current.y);
  });

  return (
    <Row
      depth={depth}
      onClick={onToggle}
      onContextMenu={
        onOpenMenu
          ? (e) => {
              e.preventDefault();
              onOpenMenu(entry.path, e.clientX, e.clientY);
            }
          : undefined
      }
      onTouchStart={
        onOpenMenu
          ? (e) => {
              const t = e.touches[0];
              if (t) lastTouch.current = { x: t.clientX, y: t.clientY };
              longPress.onTouchStart(e);
            }
          : undefined
      }
      onTouchMove={onOpenMenu ? longPress.onTouchMove : undefined}
      onTouchEnd={onOpenMenu ? longPress.onTouchEnd : undefined}
      onTouchCancel={onOpenMenu ? longPress.onTouchCancel : undefined}
    >
      <ChevronRight
        size={11}
        style={{
          flexShrink: 0,
          color: 'var(--text-faint)',
          transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform var(--dur-fast) var(--ease-out)',
        }}
      />
      <Folder size={12} style={{ flexShrink: 0, color: 'var(--text-secondary)' }} />
      <Name>{entry.name}</Name>
    </Row>
  );
}

function Name({
  selected,
  tint,
  children,
}: {
  selected?: boolean;
  tint?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      style={{
        flex: 1,
        minWidth: 0,
        fontSize: 12.5,
        // A git tint wins even when selected (VS Code behavior) — selection
        // still reads via the row fill and weight.
        color: tint ?? (selected ? 'var(--text-primary)' : 'var(--text-secondary)'),
        fontWeight: selected ? 600 : 400,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}
