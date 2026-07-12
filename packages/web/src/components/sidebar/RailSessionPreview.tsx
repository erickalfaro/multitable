import React, { useState } from 'react';
import { Bell } from 'lucide-react';
import {
  useAppStore,
  useRailSessionSnippet,
  useRailSessionAttention,
} from '../../stores/appStore';
import { SessionStatusLoader } from './SessionStatusLoader';

/**
 * One live session row under a project in the expanded rail sheet: sessions
 * that are mid-turn or need the user, with a ticking one-line snippet.
 * Clicking is the cross-project jump — it selects the session directly
 * (setSelectedProcess flips the sidebar + focused project to the owner and
 * clears the other main-pane surfaces), so the user lands in the conversation
 * in one click from anywhere.
 */
export function RailSessionPreview({
  sessionId,
  onNavigate,
}: {
  sessionId: string;
  onNavigate?: () => void;
}) {
  const session = useAppStore((s) => s.sessions[sessionId]);
  const selected = useAppStore((s) => s.selectedProcessId === sessionId);
  const snippet = useRailSessionSnippet(sessionId);
  const attention = useRailSessionAttention(sessionId);
  const [hover, setHover] = useState(false);
  if (!session) return null;

  const jump = () => {
    const store = useAppStore.getState();
    store.clearMultiSelectedSessions();
    store.setSelectedProcess(sessionId);
    onNavigate?.();
  };

  return (
    <button
      type="button"
      onClick={jump}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={session.name}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: 'calc(100% - 18px)',
        marginLeft: 18,
        padding: '3px 6px',
        fontFamily: 'inherit',
        background: selected
          ? 'var(--glass-bg)'
          : hover
            ? 'var(--glass-bg-soft)'
            : 'transparent',
        border: `1px solid ${selected ? 'var(--border-strong)' : 'transparent'}`,
        borderRadius: 'var(--radius-soft)',
        cursor: 'pointer',
        overflow: 'hidden',
        textAlign: 'left',
        transition:
          'background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
      }}
    >
      <SessionStatusLoader
        loaderVariant={session.loaderVariant}
        state={session.state}
        projectId={session.projectId}
        size={12}
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}
      >
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 500,
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {session.name}
        </span>
        {snippet && (
          <span
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {snippet}
          </span>
        )}
      </span>
      {attention && (
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 15,
            height: 15,
            flexShrink: 0,
            borderRadius: 'var(--radius-pill)',
            background: 'var(--glass-bg-strong)',
            color: 'var(--accent-amber)',
            border: '1px solid var(--accent-amber)',
            animation: 'mt-pulse 1.6s ease-in-out infinite',
          }}
        >
          <Bell size={8} />
        </span>
      )}
    </button>
  );
}
