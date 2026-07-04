import { useCallback, useEffect, useState } from 'react';
import { GitBranch, Trash2, Bot } from 'lucide-react';
import { api } from '../../../lib/api';
import type { GitWorktree } from '../../../lib/types';
import { GitConfirmDialog } from './GitConfirmDialog';

interface Props {
  projectId: string;
  /** Bumped by GitPanel on every status change so the list stays fresh. */
  refreshKey: number;
  onError: (message: string) => void;
}

// Inventory of the repo's linked worktrees (session-created or otherwise).
// Ownership rule: a worktree referenced by a live agent session is removed by
// deleting that agent — this list only offers removal for orphans, so nothing
// "floating" on disk is invisible or unkillable, and nothing under a running
// agent can be yanked away.
export function GitWorktreeList({ projectId, refreshKey, onError }: Props) {
  const [worktrees, setWorktrees] = useState<GitWorktree[] | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<GitWorktree | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(() => {
    api.git
      .worktrees(projectId)
      .then((r) => setWorktrees(r.worktrees))
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const remove = async (wt: GitWorktree, force: boolean) => {
    setRemoving(wt.path);
    try {
      await api.git.removeWorktree(projectId, wt.path, force);
      load();
    } catch (err) {
      const e = err as Error & { status?: number };
      // Dirty and not yet forced → escalate to the confirm dialog instead of
      // surfacing an error. Anything else (in-use, git failure) is an error.
      if (!force && e.status === 409 && /uncommitted/i.test(e.message)) {
        setConfirmTarget(wt);
      } else {
        onError(e.message || 'Failed to remove worktree');
      }
    } finally {
      setRemoving(null);
    }
  };

  const linked = (worktrees ?? []).filter((w) => !w.isMain);
  if (linked.length === 0) return null;

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--text-secondary)',
          backgroundColor: 'var(--bg-sidebar)',
          borderTop: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
          minHeight: 24,
        }}
      >
        <span style={{ flex: 1 }}>
          Worktrees <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>({linked.length})</span>
        </span>
      </div>
      {linked.map((wt) => {
        const owned = !!wt.sessionId;
        const label = wt.branch ?? wt.path.split('/').pop() ?? wt.path;
        return (
          <div
            key={wt.path}
            title={wt.path}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 12px',
              fontSize: 12,
              color: 'var(--text-primary)',
              minHeight: 26,
            }}
          >
            <GitBranch size={12} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
            <span
              style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: 11,
              }}
            >
              {label}
            </span>
            {wt.prunable ? (
              <Tag color="var(--text-muted)">missing</Tag>
            ) : wt.dirty ? (
              <Tag color="var(--accent-amber)">dirty</Tag>
            ) : (
              <Tag color="var(--text-muted)">clean</Tag>
            )}
            {owned ? (
              <span
                title={`In use by agent "${wt.sessionName}" — delete the agent to remove this worktree`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  fontSize: 10,
                  color: 'var(--text-muted)',
                  maxWidth: 110,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <Bot size={11} style={{ flexShrink: 0 }} />
                {wt.sessionName}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void remove(wt, false)}
                disabled={removing === wt.path}
                title={wt.prunable ? 'Remove stale worktree entry' : 'Remove worktree'}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: 3,
                  background: 'transparent',
                  border: 'none',
                  borderRadius: 'var(--radius-snug)',
                  color: 'var(--status-error)',
                  cursor: removing === wt.path ? 'default' : 'pointer',
                  opacity: removing === wt.path ? 0.5 : 0.8,
                }}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        );
      })}

      <GitConfirmDialog
        open={confirmTarget !== null}
        title="Remove Dirty Worktree"
        destructive
        confirmLabel="Discard & Remove"
        body={
          <span>
            Worktree <code>{confirmTarget?.branch ?? confirmTarget?.path}</code> has uncommitted
            changes. Removing it discards them permanently (the branch and its commits are kept).
          </span>
        }
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => {
          if (confirmTarget) void remove(confirmTarget, true);
          setConfirmTarget(null);
        }}
      />
    </div>
  );
}

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        color,
        border: `1px solid color-mix(in srgb, ${color} 45%, var(--border))`,
        borderRadius: 'var(--radius-snug)',
        padding: '1px 5px',
        lineHeight: 1.4,
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}
