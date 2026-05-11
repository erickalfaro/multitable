import { useEffect, useRef, useState } from 'react';
import { ChevronDown, GitBranch, Plus } from 'lucide-react';
import { api } from '../../../lib/api';
import type { GitBranchList } from '../../../lib/types';

interface Props {
  projectId: string;
  current: string | null;
  hasUnstagedChanges: boolean;
  onSwitch: (branch: string) => void | Promise<void>;
  onCreate: (name: string) => void | Promise<void>;
  // Bumped by parent on git:status-changed so the dropdown reflects newly
  // created / deleted branches without needing manual refresh.
  refreshKey: number;
}

export function GitBranchPicker({
  projectId,
  current,
  hasUnstagedChanges,
  onSwitch,
  onCreate,
  refreshKey,
}: Props) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchList | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.git
      .branches(projectId)
      .then(setBranches)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, projectId, refreshKey]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setNewBranchName('');
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const handleSwitch = async (b: string) => {
    if (b === current) {
      setOpen(false);
      return;
    }
    if (
      hasUnstagedChanges &&
      !confirm(
        `You have unstaged changes. Switching to "${b}" may merge or block. Continue?`,
      )
    ) {
      return;
    }
    await onSwitch(b);
    setOpen(false);
  };

  const handleCreate = async () => {
    const name = newBranchName.trim();
    if (!name) return;
    await onCreate(name);
    setOpen(false);
    setCreating(false);
    setNewBranchName('');
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          backgroundColor: 'var(--bg-hover)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-snug)',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        <GitBranch size={12} />
        <span>{current ?? 'detached'}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            minWidth: 220,
            maxHeight: 320,
            overflow: 'auto',
            backgroundColor: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-soft)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            zIndex: 20,
          }}
        >
          {loading && (
            <div style={{ padding: 8, fontSize: 12, color: 'var(--text-muted)' }}>
              Loading branches…
            </div>
          )}
          {!loading && branches && (
            <>
              {branches.local.map((b) => (
                <div
                  key={b}
                  onClick={() => handleSwitch(b)}
                  style={{
                    padding: '6px 10px',
                    fontSize: 12,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    cursor: 'pointer',
                    color: b === current ? 'var(--accent-blue)' : 'var(--text-primary)',
                    fontWeight: b === current ? 600 : 400,
                    backgroundColor: b === current ? 'var(--bg-hover)' : 'transparent',
                  }}
                >
                  {b}
                </div>
              ))}
              <div
                style={{
                  padding: '6px 10px',
                  borderTop: '1px solid var(--border)',
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                }}
              >
                {creating ? (
                  <>
                    <input
                      autoFocus
                      value={newBranchName}
                      onChange={(e) => setNewBranchName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleCreate();
                        if (e.key === 'Escape') {
                          setCreating(false);
                          setNewBranchName('');
                        }
                      }}
                      placeholder="new-branch-name"
                      style={{
                        flex: 1,
                        padding: '3px 6px',
                        fontSize: 12,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        backgroundColor: 'var(--bg-primary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-snug)',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void handleCreate()}
                      style={smallBtn}
                    >
                      Create
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setCreating(true)}
                    style={{
                      ...smallBtn,
                      width: '100%',
                      justifyContent: 'flex-start',
                      gap: 6,
                    }}
                  >
                    <Plus size={12} /> New branch
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const smallBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '3px 8px',
  fontSize: 12,
  backgroundColor: 'var(--bg-hover)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-snug)',
  cursor: 'pointer',
};
