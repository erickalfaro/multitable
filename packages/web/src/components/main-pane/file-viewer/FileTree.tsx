import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Folder, FileText, Loader2 } from 'lucide-react';
import { api } from '../../../lib/api';

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
  // 'panel' = legacy fixed-width bordered column (center File Viewer host);
  // 'sidebar' = full-width, transparent, no own scroll (host scrolls).
  variant?: 'panel' | 'sidebar';
}

const ROOT = '';
const PAGE_SIZE = 50;

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
  variant = 'panel',
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenByDir, setChildrenByDir] = useState<Record<string, Entry[]>>({});
  const [metaByDir, setMetaByDir] = useState<Record<string, DirMeta>>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [loadingMoreDirs, setLoadingMoreDirs] = useState<Set<string>>(new Set());
  const [errorByDir, setErrorByDir] = useState<Record<string, string>>({});

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
            <Row depth={depth} onClick={() => toggleDir(entry.path)}>
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
            {isOpen && renderLevel(entry.path, depth + 1)}
          </div>
        );
      }
      const isSelected = entry.path === selectedPath;
      return (
        <Row
          key={entry.path}
          depth={depth}
          selected={isSelected}
          onClick={() => onOpenFile(entry.path)}
        >
          <span style={{ width: 11, flexShrink: 0 }} />
          <FileText size={12} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
          <Name selected={isSelected}>{entry.name}</Name>
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

  if (variant === 'sidebar') {
    return <div style={{ padding: '2px 0' }}>{renderLevel(ROOT, 0)}</div>;
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
    </div>
  );
}

function Row({
  depth,
  selected,
  onClick,
  children,
}: {
  depth: number;
  selected?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      className="mt-sidebar-item"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px',
        paddingLeft: 8 + depth * 14,
        cursor: 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        backgroundColor: selected ? 'var(--bg-elevated)' : 'transparent',
        borderLeft: selected ? '3px solid var(--accent-amber)' : '3px solid transparent',
      }}
    >
      {children}
    </div>
  );
}

function Name({ selected, children }: { selected?: boolean; children: React.ReactNode }) {
  return (
    <span
      style={{
        flex: 1,
        minWidth: 0,
        fontSize: 12.5,
        color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
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
