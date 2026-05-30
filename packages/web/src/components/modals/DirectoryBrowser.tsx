import React, { useEffect, useState } from 'react';
import { ArrowUp, Folder, FolderPlus, Check, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import { Button, Input, Spinner } from '../ui';

interface BrowseDirResponse {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string; type: 'directory' }>;
  roots: Array<{ label: string; path: string }>;
}

interface DirectoryBrowserProps {
  // Seed location; pass an absolute path or undefined to start at the host home dir.
  initialPath?: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// Deterministic list height per screen tier (mobile/desktop × small/large) so the
// panel never resizes with the number of folders a directory happens to contain.
// Tiers are keyed off the viewport so the browser stays usable without overflowing
// the modal on short screens, but the height is fixed within a tier (no content jump).
const MOBILE_BREAKPOINT = 768;

function computeListHeight(): number {
  if (typeof window === 'undefined') return 320;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w < MOBILE_BREAKPOINT) return h < 700 ? 200 : 280; // mobile: small / large
  return h < 850 ? 300 : 400; // desktop: small / large
}

function useListHeight(): number {
  const [height, setHeight] = useState(computeListHeight);
  useEffect(() => {
    const handler = () => setHeight(computeListHeight());
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return height;
}

export function DirectoryBrowser({ initialPath, onSelect, onCancel }: DirectoryBrowserProps) {
  const [currentPath, setCurrentPath] = useState<string | undefined>(initialPath);
  const [data, setData] = useState<BrowseDirResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoverPath, setHoverPath] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);
  const listHeight = useListHeight();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.projects
      .browseDir(currentPath)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        // Adopt the daemon's canonical resolved path so breadcrumb/parent stay correct.
        if (res.path !== currentPath) setCurrentPath(res.path);
      })
      .catch((e: any) => {
        if (cancelled) return;
        const msg = e?.message ?? 'Failed to read directory';
        // If we already have a good listing, a failed hop (e.g. permission denied)
        // shouldn't blank the panel — toast and stay on the last readable folder.
        if (data) {
          toast.error(msg);
          setCurrentPath(data.path);
        } else {
          setError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `data` is intentionally omitted: the effect must re-run only on a path change,
    // and the catch relies on the closure capturing the last *good* listing to revert to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath]);

  const navigate = (p: string) => {
    setNewFolderOpen(false);
    setNewFolderName('');
    setCurrentPath(p);
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name || !data) return;
    setCreating(true);
    try {
      const { path: created } = await api.projects.mkdir(data.path, name);
      setNewFolderOpen(false);
      setNewFolderName('');
      navigate(created);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to create folder');
    } finally {
      setCreating(false);
    }
  };

  const chipStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 8px',
    fontSize: 11,
    fontFamily: MONO,
    color: 'var(--text-muted)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-snug)',
    cursor: 'pointer',
  };

  return (
    <div>
      {/* Quick-root shortcut chips */}
      {data && data.roots.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {data.roots.map((root) => (
            <button
              key={root.path}
              type="button"
              onClick={() => navigate(root.path)}
              style={chipStyle}
            >
              {root.label}
            </button>
          ))}
        </div>
      )}

      {/* Path bar + Up */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <button
          type="button"
          onClick={() => data?.parent && navigate(data.parent)}
          disabled={!data?.parent}
          title="Up one level"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 4,
            borderRadius: 'var(--radius-snug)',
            background: 'none',
            border: '1px solid var(--border)',
            color: data?.parent ? 'var(--text-muted)' : 'var(--text-faint)',
            cursor: data?.parent ? 'pointer' : 'not-allowed',
            flexShrink: 0,
          }}
        >
          <ArrowUp size={14} />
        </button>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: MONO,
            fontSize: 11.5,
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: 'rtl',
            textAlign: 'left',
          }}
          title={data?.path ?? ''}
        >
          {data?.path ?? '…'}
        </div>
        <button
          type="button"
          onClick={() => setNewFolderOpen((v) => !v)}
          disabled={!data}
          title="New folder"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 4,
            borderRadius: 'var(--radius-snug)',
            background: 'none',
            border: '1px solid var(--border)',
            color: newFolderOpen ? 'var(--accent-amber)' : 'var(--text-muted)',
            cursor: data ? 'pointer' : 'not-allowed',
            flexShrink: 0,
          }}
        >
          <FolderPlus size={14} />
        </button>
      </div>

      {/* New folder input row */}
      {newFolderOpen && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <Input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFolder();
              if (e.key === 'Escape') {
                setNewFolderOpen(false);
                setNewFolderName('');
              }
            }}
            placeholder="New folder name"
            style={{ fontFamily: MONO }}
            wrapperStyle={{ flex: 1 }}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={handleCreateFolder}
            loading={creating}
            disabled={!newFolderName.trim()}
            leftIcon={<Check size={12} />}
          >
            Create
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setNewFolderOpen(false);
              setNewFolderName('');
            }}
            leftIcon={<X size={12} />}
          >
            Cancel
          </Button>
        </div>
      )}

      {/* Folder list (directories only) */}
      <div
        className="mt-scroll"
        style={{
          height: listHeight,
          overflowY: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-snug)',
          background: 'var(--bg-base)',
        }}
      >
        {/* First load (nothing to show yet): a single centered spinner. */}
        {!data && loading && (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)',
            }}
          >
            <Spinner size="md" />
          </div>
        )}
        {!data && !loading && error && (
          <div style={{ padding: 12, color: 'var(--status-error)', fontSize: 12 }}>{error}</div>
        )}
        {/* Once we have a listing, keep it mounted across hops — dim + freeze it
            while the next directory loads so the panel never flashes empty. */}
        {data && (
          <div
            style={{
              opacity: loading ? 0.5 : 1,
              pointerEvents: loading ? 'none' : 'auto',
              transition: 'opacity 120ms var(--ease-out)',
            }}
          >
            {data.entries.length === 0 ? (
              <div style={{ padding: 12, color: 'var(--text-faint)', fontSize: 12 }}>
                No subfolders
              </div>
            ) : (
              data.entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => navigate(entry.path)}
                  onMouseEnter={() => setHoverPath(entry.path)}
                  onMouseLeave={() => setHoverPath(null)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '6px 10px',
                    background: hoverPath === entry.path ? 'var(--bg-hover)' : 'transparent',
                    border: 'none',
                    borderBottom: '1px solid var(--border-subtle, var(--border))',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: MONO,
                    fontSize: 12,
                  }}
                >
                  <Folder size={14} style={{ color: 'var(--accent-amber)', flexShrink: 0 }} />
                  <span
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {entry.name}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Action row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 8,
          marginTop: 10,
        }}
      >
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => data && onSelect(data.path)}
          disabled={!data}
        >
          Use this folder
        </Button>
      </div>
    </div>
  );
}
