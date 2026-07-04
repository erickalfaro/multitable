import { useCallback, useEffect, useState } from 'react';
import { GitBranch, Trash2, Bot } from 'lucide-react';
import { api } from '../../../lib/api';
import { useAppStore } from '../../../stores/appStore';
import type { GitWorktree } from '../../../lib/types';
import { GitConfirmDialog } from './GitConfirmDialog';

interface Props {
  projectId: string;
  /** Bumped by GitPanel on every status change so the list stays fresh. */
  refreshKey: number;
  onError: (message: string) => void;
}

// Inventory of the repo's linked worktrees (session-created or otherwise).
// Ownership rule: a worktree referenced by a live agent session belongs to
// that agent — removing it from here DETACHES it first (the agent survives
// and continues in the project root; only the directory goes), always behind
// a confirm that names the agent. Orphans remove directly: one click when
// clean, a discard confirm when dirty. Either way nothing "floating" on disk
// is invisible or unkillable.
export function GitWorktreeList({ projectId, refreshKey, onError }: Props) {
  const upsertSession = useAppStore((s) => s.upsertSession);
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

  // Owned worktrees: detach from the agent (session survives, cwd falls back
  // to the project root) and remove the directory. Reached only via the
  // confirm dialog, so force is always true here.
  const detach = async (wt: GitWorktree) => {
    if (!wt.sessionId) return;
    setRemoving(wt.path);
    try {
      const r = await api.sessions.detachWorktree(wt.sessionId, true);
      if (r.session) upsertSession(r.session);
      load();
    } catch (err) {
      const e = err as Error & { status?: number };
      onError(e.message || 'Failed to detach worktree');
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
            {owned && (
              <span
                title={`In use by agent "${wt.sessionName}" — removing detaches the agent (it keeps running, back in the project root)`}
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
            )}
            <button
              type="button"
              // Owned rows always confirm (the action also detaches an agent);
              // orphans confirm only when the server reports them dirty.
              onClick={() => (owned ? setConfirmTarget(wt) : void remove(wt, false))}
              disabled={removing === wt.path}
              title={
                owned
                  ? `Detach from "${wt.sessionName}" and remove worktree (the agent is kept)`
                  : wt.prunable
                    ? 'Remove stale worktree entry'
                    : 'Remove worktree'
              }
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
          </div>
        );
      })}

      <GitConfirmDialog
        open={confirmTarget !== null}
        title={confirmTarget?.sessionId ? 'Detach & Remove Worktree' : 'Remove Dirty Worktree'}
        destructive
        confirmLabel={confirmTarget?.sessionId ? 'Detach & Remove' : 'Discard & Remove'}
        body={
          confirmTarget?.sessionId ? (
            <span>
              Worktree <code>{confirmTarget.branch ?? confirmTarget.path}</code> belongs to agent{' '}
              <strong>{confirmTarget.sessionName}</strong>. The agent is kept and will continue in
              the project root; the worktree is deleted
              {confirmTarget.dirty ? ' and its uncommitted changes are discarded permanently' : ''}.
              The branch and its commits are kept.
            </span>
          ) : (
            <span>
              Worktree <code>{confirmTarget?.branch ?? confirmTarget?.path}</code> has uncommitted
              changes. Removing it discards them permanently (the branch and its commits are kept).
            </span>
          )
        }
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => {
          if (confirmTarget) {
            if (confirmTarget.sessionId) void detach(confirmTarget);
            else void remove(confirmTarget, true);
          }
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
