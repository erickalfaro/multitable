import React from 'react';
import { GitBranch } from 'lucide-react';
import type { Session } from '../../lib/types';
import { useAppStore } from '../../stores/appStore';

interface Props {
  session: Session;
}

// Non-interactive chip shown only for worktree-backed sessions: the worktree
// branch name plus a live dirty indicator. Branch name comes from the session
// row (always available); the dirty count arrives via the daemon's per-session
// GitWatcher (`git:session-status-changed` → store.gitBySession) and stays
// dark until the first event after a page load — there is no REST seed.
export function WorktreeBadge({ session }: Props) {
  const status = useAppStore((s) => s.gitBySession[session.id]);
  if (!session.worktreePath || !session.worktreeBranch) return null;

  const dirtyCount = status
    ? status.staged.length + status.unstaged.length + status.untracked.length
    : 0;
  const title = `Isolated worktree: ${session.worktreePath}${
    dirtyCount > 0 ? ` — ${dirtyCount} uncommitted change${dirtyCount === 1 ? '' : 's'}` : ''
  }`;

  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        height: 14,
        padding: '0 5px',
        fontSize: 8.5,
        fontWeight: 600,
        letterSpacing: '0.01em',
        color: 'var(--accent-amber)',
        background: 'color-mix(in srgb, var(--accent-amber) 12%, var(--bg-elevated))',
        border: '1px solid color-mix(in srgb, var(--accent-amber) 55%, var(--border))',
        borderRadius: 'var(--radius-snug)',
        lineHeight: 1,
        whiteSpace: 'nowrap',
        maxWidth: 160,
      }}
    >
      <GitBranch size={9} style={{ flexShrink: 0 }} />
      <span
        style={{
          lineHeight: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {session.worktreeBranch}
      </span>
      {dirtyCount > 0 && (
        <span aria-hidden style={{ lineHeight: 1, opacity: 0.9 }}>
          ±{dirtyCount}
        </span>
      )}
    </span>
  );
}
