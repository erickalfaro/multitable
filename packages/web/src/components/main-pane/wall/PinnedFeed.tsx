import { useMemo } from 'react';
import { useAppStore } from '../../../stores/appStore';
import { SessionFeedCard } from './SessionFeedCard';

/**
 * Mobile counterpart to SessionWall (plan §5.8). The desktop Wall doesn't
 * physically fit at mobile widths — 2 columns at 375px gives each tile
 * ~165px, too narrow for a usable mini-chat. The feed gives the user the
 * same "all my context on one screen" feeling, vertically scrolled, with
 * cards tuned for read-and-drill-in interaction (no composer on the card).
 */
export function PinnedFeed() {
  const pinnedIds = useAppStore((s) => s.pinnedSessionIds);
  const sessions = useAppStore((s) => s.sessions);

  const cards = useMemo(
    () => pinnedIds.map((id) => ({ id, session: sessions[id] })).filter((c) => c.session),
    [pinnedIds, sessions],
  );

  if (cards.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--space-5)',
          color: 'var(--text-muted)',
          textAlign: 'center',
          flexDirection: 'column',
          gap: 'var(--space-2)',
        }}
      >
        <div style={{ fontSize: 16, color: 'var(--text-secondary)', fontWeight: 500 }}>
          Your feed is empty
        </div>
        <div style={{ fontSize: 13.5, maxWidth: 320, lineHeight: 1.45 }}>
          Pin sessions from the sidebar to follow their chat right here.
        </div>
      </div>
    );
  }

  return (
    <div
      className="mt-scroll"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: 'var(--space-3)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      {cards.map(({ id, session }) => (
        <SessionFeedCard key={id} sessionId={id} session={session!} />
      ))}
    </div>
  );
}
