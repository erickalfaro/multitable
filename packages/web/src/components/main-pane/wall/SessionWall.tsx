import { useMemo } from 'react';
import { useAppStore } from '../../../stores/appStore';
import { SessionTile } from './SessionTile';

/**
 * Pinned Session Wall — replaces the legacy project-grid dashboard as the
 * "homepage" of MultiTable when no session is focused. See plan §5.1 and §2
 * rule 7 ("The Wall is the homepage.").
 *
 * Responsive grid: tiles auto-fit at a minimum 360px column, gap = --space-3.
 * On a 14" laptop this is 2-up; on a 27" monitor it's 4–5-up; the user can
 * pin up to ~10 sessions comfortably.
 *
 * Empty state nudges the user toward the new mental model: pinning is the
 * gesture that fills this canvas.
 */
export function SessionWall() {
  const pinnedIds = useAppStore((s) => s.pinnedSessionIds);
  const sessions = useAppStore((s) => s.sessions);
  const focusedPaneId = useAppStore((s) => s.focusedPaneId);

  // Filter to ids that still exist as sessions (a pinned session might have
  // been deleted in another browser; we just skip the stale id rather than
  // forcibly cleaning the list so the user can re-create it under the same
  // id without losing pin order).
  const tiles = useMemo(
    () => pinnedIds.map((id) => ({ id, session: sessions[id] })).filter((t) => t.session),
    [pinnedIds, sessions],
  );

  if (tiles.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--space-6)',
          color: 'var(--text-muted)',
          textAlign: 'center',
          flexDirection: 'column',
          gap: 'var(--space-3)',
        }}
      >
        <div
          style={{
            fontSize: 18,
            color: 'var(--text-secondary)',
            fontWeight: 500,
            letterSpacing: '-0.01em',
          }}
        >
          Your wall is empty
        </div>
        <div style={{ fontSize: 13.5, maxWidth: 460, lineHeight: 1.5 }}>
          Right-click any session in the sidebar and choose{' '}
          <span style={{ color: 'var(--text-primary)' }}>Pin to Wall</span> to see it
          here. Pin up to a dozen sessions across projects to monitor them all from one
          screen.
        </div>
      </div>
    );
  }

  return (
    <div
      className="mt-scroll mt-wall"
      data-has-focus={focusedPaneId !== null ? 'true' : undefined}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: 'var(--space-4)',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
        gridAutoRows: 'minmax(280px, 1fr)',
        gap: 'var(--space-3)',
        // The grid expands vertically with the wall — give every tile a real
        // floor (~280px) so a single tile doesn't try to fill the viewport
        // and a 10-tile wall isn't impossibly tall.
        alignContent: 'start',
      }}
    >
      {tiles.map(({ id, session }) => (
        <SessionTile key={id} sessionId={id} session={session!} />
      ))}
    </div>
  );
}
