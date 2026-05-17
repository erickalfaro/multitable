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
}

const ROOT = '';

export function FileTree({ projectId, selectedPath, onOpenFile, refreshKey }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenByDir, setChildrenByDir] = useState<Record<string, Entry[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [errorByDir, setErrorByDir] = useState<Record<string, string>>({});

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const loadDir = useCallback(
    async (dir: string) => {
      setLoadingDirs((s) => new Set(s).add(dir));
      setErrorByDir((e) => {
        const next = { ...e };
        delete next[dir];
        return next;
      });
      try {
        const entries = await api.projects.files(projectId, dir || undefined, true);
        setChildrenByDir((c) => ({ ...c, [dir]: entries }));
      } catch (err: any) {
        setErrorByDir((e) => ({ ...e, [dir]: err?.message || 'Failed to read directory' }));
      } finally {
        setLoadingDirs((s) => {
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
    return entries.map((entry) => {
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
        </Row>
      );
    });
  };

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
