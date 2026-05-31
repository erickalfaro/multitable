import React from 'react';
import { ChevronRight } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';

/**
 * Group header that labels a run of pending items in the Console with their
 * owning project and session. Reads names from the global store so renaming
 * either propagates without any prop plumbing. Clicking jumps the main pane
 * to that session.
 */
export function SessionGroupHeader({
  sessionId,
  count,
  onJump,
}: {
  sessionId: string;
  count: number;
  onJump?: () => void;
}) {
  const session = useAppStore((s) => s.sessions[sessionId]);
  const project = useAppStore((s) =>
    session ? s.projects.find((p) => p.id === session.projectId) : null,
  );

  const sessionName = session?.name ?? 'Session';
  const projectName = project?.name ?? 'Project';
  const providerLabel = session?.agentProvider ?? '';

  return (
    <button
      onClick={onJump}
      style={{
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        borderBottom: '1px solid var(--border)',
        padding: '8px 12px',
        cursor: onJump ? 'pointer' : 'default',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-secondary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
          minWidth: 0,
        }}
      >
        {projectName}
        <span style={{ color: 'var(--text-faint)', margin: '0 4px' }}>›</span>
        <span style={{ color: 'var(--text-primary)' }}>{sessionName}</span>
        {providerLabel && (
          <span
            style={{
              marginLeft: 6,
              fontSize: 10,
              color: 'var(--text-faint)',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
            }}
          >
            {providerLabel}
          </span>
        )}
      </span>
      <span
        style={{
          fontSize: 10.5,
          color: 'var(--text-muted)',
          fontVariantNumeric: 'tabular-nums',
          flexShrink: 0,
        }}
      >
        {count}
      </span>
      {onJump && <ChevronRight size={11} color="var(--text-faint)" />}
    </button>
  );
}
