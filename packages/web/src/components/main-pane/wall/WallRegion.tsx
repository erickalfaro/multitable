import { useEffect, useRef, useState } from 'react';
import type { WallRegion as WallRegionT } from '../../../lib/types';
import { useAppStore } from '../../../stores/appStore';
import { SessionTile } from './SessionTile';
import { useWallDrag } from './WallDragContext';
import {
  GAP,
  MIN_REGION_PX,
  ROW_PX,
  colPitch,
  regionRows,
  tileBox,
} from './grid';

/**
 * One region of the wall — its own free-float grid coordinate space. Tiles are
 * absolutely positioned from their {x,y,w,h} cells against a column pitch
 * derived from the region's measured width. Height auto-grows to the tallest
 * content (the wall scrolls). Exposes `data-*` so the drag controller can
 * hit-test drops without a rect registry.
 */
export function WallRegion({ region }: { region: WallRegionT; index: number }) {
  const { drag, drop, resize, beginDrag, beginResize, locked } = useWallDrag();
  const sessions = useAppStore((s) => s.sessions);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);

  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pitch = width > 0 ? colPitch(width, region.cols) : 0;

  // Apply the live resize preview (if a tile in this region is being resized).
  const tiles = region.tiles.map((t) =>
    resize && resize.sessionId === t.sessionId ? { ...t, w: resize.w, h: resize.h } : t,
  );

  const placeholder =
    drag && drop && drop.kind === 'region' && drop.regionId === region.id
      ? { x: drop.x, y: drop.y, w: drag.w, h: drag.h }
      : null;

  const contentRows = Math.max(
    regionRows({ ...region, tiles }),
    placeholder ? placeholder.y + placeholder.h : 0,
  );
  const heightPx = Math.max(MIN_REGION_PX, contentRows * ROW_PX);
  const isEmpty = region.tiles.length === 0;

  return (
    <div
      ref={ref}
      className="mt-wall-region"
      data-wall-region={region.id}
      data-cols={region.cols}
      data-col-pitch={pitch || ''}
      data-empty={isEmpty ? 'true' : undefined}
      style={{ position: 'relative', height: heightPx }}
    >
      {isEmpty && <div className="mt-wall-region-empty">Drag a chat here to fill this section</div>}

      {pitch > 0 &&
        tiles.map((t) => {
          const session = sessions[t.sessionId];
          if (!session) return null; // not-yet-loaded or pruned; ghost-prune cleans up
          const box = tileBox(t, pitch);
          return (
            <div
              key={t.sessionId}
              className="mt-wall-tile-wrap"
              data-tile-id={t.sessionId}
              data-x={t.x}
              data-y={t.y}
              data-w={t.w}
              data-h={t.h}
              data-dragging={drag?.sessionId === t.sessionId ? 'true' : undefined}
              onClick={() => setFocusedPane(t.sessionId)}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                transform: `translate(${box.left}px, ${box.top}px)`,
                width: box.width,
                height: box.height,
              }}
            >
              <SessionTile
                sessionId={t.sessionId}
                session={session}
                locked={locked}
                onDragStart={beginDrag}
                onResizeStart={beginResize}
              />
            </div>
          );
        })}

      {placeholder && pitch > 0 && (
        <div
          className="mt-wall-placeholder"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transform: `translate(${placeholder.x * pitch}px, ${placeholder.y * ROW_PX}px)`,
            width: Math.max(0, placeholder.w * pitch - GAP),
            height: Math.max(0, placeholder.h * ROW_PX - GAP),
          }}
        />
      )}
    </div>
  );
}
