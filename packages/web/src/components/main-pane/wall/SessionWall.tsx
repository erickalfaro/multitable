import { useEffect, useRef, type RefObject } from 'react';
import { GridStack, type GridStackOptions, type GridStackNode } from 'gridstack';
import 'gridstack/dist/gridstack.min.css';
import { useAppStore } from '../../../stores/appStore';
import { SessionTile } from './SessionTile';
import { WallToolbar } from './WallToolbar';
import { reconcileLayout } from './layoutPresets';
import type { WallLayoutItem } from '../../../lib/types';

const GS_OPTS: GridStackOptions = {
  column: 12,
  cellHeight: 32,
  margin: 4,
  float: false,
  animate: true,
  handle: '.mt-tile-drag-handle',
  resizable: { handles: 'se' },
  acceptWidgets: false,
  minRow: 1,
  // No columnOpts → gridstack stays at 12 cols regardless of viewport width.
  // The wall is desktop-only (mobile uses PinnedFeed), so we don't need
  // gridstack's responsive column collapse.
};

interface SavedNode {
  id?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

// React-renders the DOM, gridstack owns positioning. The store is the source
// of truth for what's pinned + where; gridstack writes back via `change`.
export function SessionWall() {
  const pinnedIds = useAppStore((s) => s.pinnedSessionIds);
  const sessions = useAppStore((s) => s.sessions);
  const storedLayout = useAppStore((s) => s.wallLayout);
  const locked = useAppStore((s) => s.wallLayoutLocked);
  const focusedPaneId = useAppStore((s) => s.focusedPaneId);
  const setWallLayout = useAppStore((s) => s.setWallLayout);

  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<GridStack | null>(null);
  const persistedLockedRef = useRef(locked);

  // Seed layout for first paint — every pinned id gets {x,y,w,h} from
  // the store or an auto-placed slot.
  const seededLayout = reconcileLayout(storedLayout.lg, pinnedIds, 'lg');

  // 1. Init gridstack once.
  useEffect(() => {
    if (!containerRef.current || gridRef.current) return;
    const grid = GridStack.init(
      { ...GS_OPTS, disableDrag: persistedLockedRef.current, disableResize: persistedLockedRef.current },
      containerRef.current,
    );
    grid.on('change', () => {
      // Read gridstack's current state and mirror to the store.
      const saved = (grid.save(false) as SavedNode[]) || [];
      const items: WallLayoutItem[] = saved
        .filter((n): n is SavedNode & { id: string } => typeof n.id === 'string')
        .map((n) => ({
          i: n.id,
          x: n.x ?? 0,
          y: n.y ?? 0,
          w: n.w ?? 4,
          h: n.h ?? 6,
        }));
      const current = useAppStore.getState().wallLayout;
      setWallLayout({ ...current, lg: items });
    });
    gridRef.current = grid;
    return () => {
      grid.destroy(false);
      gridRef.current = null;
    };
    // Mount once — subsequent state changes are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. Reconcile widgets when pinnedIds changes (add new, remove unpinned).
  useEffect(() => {
    const grid = gridRef.current;
    const container = containerRef.current;
    if (!grid || !container) return;
    grid.batchUpdate(true);
    try {
      const existingIds = new Set(
        grid.engine.nodes
          .map((n: GridStackNode) => (typeof n.id === 'string' ? n.id : null))
          .filter((x): x is string => x !== null),
      );
      // Add: any pinned id not yet a gridstack widget. React has already
      // rendered the DOM for it; makeWidget tells gridstack to adopt it.
      // makeWidget alone wires up resize but NOT drag in v12 — we must
      // explicitly re-enable movable on the adopted element. Without this,
      // newly-pinned tiles could be resized but not dragged until the wall
      // remounted and gridstack re-init scanned the DOM from scratch.
      for (const id of pinnedIds) {
        if (!existingIds.has(id)) {
          const el = container.querySelector<HTMLElement>(`.grid-stack-item[gs-id="${id}"]`);
          if (el) {
            grid.makeWidget(el);
            if (!locked) {
              grid.movable(el, true);
              grid.resizable(el, true);
            }
          }
        }
      }
      // Remove: any widget whose id is no longer pinned.
      for (const node of [...grid.engine.nodes]) {
        const nid = typeof node.id === 'string' ? node.id : null;
        if (nid && !pinnedIds.includes(nid) && node.el) {
          grid.removeWidget(node.el, false); // false = leave DOM; React owns it
        }
      }
    } finally {
      grid.batchUpdate(false);
    }
  }, [pinnedIds]);

  // 3. Lock toggle.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    grid.enableMove(!locked);
    grid.enableResize(!locked);
    persistedLockedRef.current = locked;
  }, [locked]);

  // 4. Click-outside-to-blur — when a tile owns focus, any mousedown that
  // lands outside its DOM clears the focus, which re-collapses its composer.
  // Clicks on a different tile's collapsed-composer button blur first
  // (mousedown) then re-focus (onClick), so focus shifts cleanly.
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  useEffect(() => {
    if (!focusedPaneId) return;
    const onDocDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const insideFocused = target.closest(`.grid-stack-item[gs-id="${focusedPaneId}"]`);
      if (!insideFocused) setFocusedPane(null);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [focusedPaneId, setFocusedPane]);

  if (pinnedIds.length === 0) {
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
        position: 'relative',
      }}
    >
      <WallToolbar pinnedIds={pinnedIds} gridRef={gridRef} />
      <div ref={containerRef} className="grid-stack">
        {pinnedIds.map((id) => {
          const session = sessions[id];
          if (!session) return null;
          const item = seededLayout.find((it) => it.i === id);
          const x = item?.x ?? 0;
          const y = item?.y ?? 0;
          const w = item?.w ?? 4;
          const h = item?.h ?? 6;
          return (
            <div
              key={id}
              className="grid-stack-item"
              gs-id={id}
              gs-x={x}
              gs-y={y}
              gs-w={w}
              gs-h={h}
              gs-min-w={2}
              gs-min-h={3}
            >
              <div className="grid-stack-item-content">
                <SessionTile sessionId={id} session={session} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export type SessionWallGridRef = RefObject<GridStack | null>;
