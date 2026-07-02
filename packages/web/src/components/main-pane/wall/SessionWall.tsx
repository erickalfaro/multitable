import { Fragment, useCallback, useEffect, useMemo, type PointerEvent as ReactPointerEvent } from 'react';
import { useAppStore } from '../../../stores/appStore';
import { WallRegion } from './WallRegion';
import { SectionDivider } from './SectionDivider';
import { WallToolbar } from './WallToolbar';
import { WallDragProvider } from './WallDragContext';
import { layoutTileIds, normalizeWallLayout } from './grid';

/**
 * The Pinned Session Wall — a vertical stack of regions, each a free-float
 * grid of session tiles. The Zustand store holds the layout tree as the single
 * source of truth; this component renders it (DOM = f(state)) and dispatches
 * store actions from drag/resize/divider gestures. No second layout engine.
 */
export function SessionWall() {
  const pinnedIds = useAppStore((s) => s.pinnedSessionIds);
  const wallLayout = useAppStore((s) => s.wallLayout);
  const sessions = useAppStore((s) => s.sessions);
  const locked = useAppStore((s) => s.wallLayoutLocked);
  const focusedPaneId = useAppStore((s) => s.focusedPaneId);
  const setWallLayout = useAppStore((s) => s.setWallLayout);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  const pruneWallLayout = useAppStore((s) => s.pruneWallLayout);

  // Render-time reconcile: append newly-pinned ids, drop unpinned, re-pack.
  // liveIds = null so not-yet-loaded sessions are NOT dropped here (the
  // ghost-prune effect below handles truly-deleted sessions once loaded).
  const normalized = useMemo(
    () => normalizeWallLayout(wallLayout, pinnedIds, null),
    [wallLayout, pinnedIds],
  );

  // Persist the reconcile when it actually changed the tree (new pin appended,
  // unpinned tile removed). Deterministic normalize → converges in one pass.
  useEffect(() => {
    if (JSON.stringify(normalized) !== JSON.stringify(wallLayout)) {
      setWallLayout(normalized);
    }
  }, [normalized, wallLayout, setWallLayout]);

  // Ghost prune — only after sessions are loaded, permanently drop tiles/pins
  // whose session is gone (deleted server-side), cleaning the sidebar too.
  useEffect(() => {
    const liveIds = Object.keys(sessions);
    if (liveIds.length === 0) return;
    const ghostPin = pinnedIds.some((id) => !sessions[id]);
    const ghostTile = layoutTileIds(wallLayout).some((id) => !sessions[id]);
    if (ghostPin || ghostTile) pruneWallLayout(liveIds);
  }, [sessions, pinnedIds, wallLayout, pruneWallLayout]);

  // Background press clears tile focus (re-collapses composers). One handler on
  // the wall root — not a document listener — so it's deterministic.
  const onBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-tile-id]') || t.closest('.mt-wall-toolbar')) return;
      if (focusedPaneId) setFocusedPane(null);
    },
    [focusedPaneId, setFocusedPane],
  );

  if (pinnedIds.length === 0) return <EmptyWall />;

  const regions = normalized.regions;
  return (
    <div
      className="mt-scroll mt-wall"
      data-has-focus={focusedPaneId !== null ? 'true' : undefined}
      onPointerDown={onBackgroundPointerDown}
      style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}
    >
      <WallToolbar />
      <WallDragProvider locked={locked}>
        <div className="mt-wall-stack">
          <SectionDivider boundaryIndex={0} variant="top" />
          {regions.map((region, i) => (
            <Fragment key={region.id}>
              <WallRegion region={region} index={i} />
              <SectionDivider
                boundaryIndex={i + 1}
                variant={i === regions.length - 1 ? 'bottom' : 'between'}
                deleteBelowIndex={i + 1}
              />
            </Fragment>
          ))}
        </div>
      </WallDragProvider>
    </div>
  );
}

function EmptyWall() {
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
      <div className="mt-display" style={{ fontSize: 34 }}>
        your wall is <em>empty</em>
      </div>
      <div style={{ fontSize: 13.5, maxWidth: 460, lineHeight: 1.5 }}>
        Right-click any session in the sidebar and choose{' '}
        <span style={{ color: 'var(--text-primary)' }}>Pin to Wall</span> to see it here. Pin
        sessions across projects, then drag, resize, and split them into sections to monitor
        them all from one screen.
      </div>
    </div>
  );
}
