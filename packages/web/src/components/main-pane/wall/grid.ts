import type { WallLayout, WallLayoutItem, WallRegion, WallTile } from '../../../lib/types';

// ── Constants ────────────────────────────────────────────────────────────────
// The wall is a vertical stack of regions; each region is a `WALL_COLS`-wide
// free-float grid. WIDTH is fractional (cols of the measured region width) so
// it's viewport-independent; HEIGHT is in rows of fixed pitch, so a region
// grows to fit its content and the wall scrolls. Gaps live "inside" the pitch
// (each tile is GAP smaller than its cell footprint), which keeps the drop /
// render math a single multiply with no per-gap accumulation.

export const WALL_COLS = 12;
export const ROW_PX = 30; // vertical pitch per row, in px
export const GAP = 6; // gap between tiles, in px
export const MIN_W = 2;
export const MIN_H = 3;
export const DEFAULT_W = 4;
export const DEFAULT_H = 7;
/** Minimum visible height of a region (empty regions still need a drop band). */
export const MIN_REGION_PX = 72;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

let _regionSeq = 0;
export function makeRegionId(): string {
  // Only Workflow scripts ban Date.now()/Math.random(); app code is fine.
  return `region-${Date.now().toString(36)}-${(_regionSeq++).toString(36)}`;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

/** Column pitch (px per column, including the gap) for a measured region width. */
export function colPitch(regionWidth: number, cols: number): number {
  return regionWidth / Math.max(1, cols);
}

export interface TileBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Absolute px box for a tile given the region's column pitch. */
export function tileBox(tile: WallTile, pitch: number): TileBox {
  return {
    left: tile.x * pitch,
    top: tile.y * ROW_PX,
    width: Math.max(0, tile.w * pitch - GAP),
    height: Math.max(0, tile.h * ROW_PX - GAP),
  };
}

/** How many rows tall a region's content is (0 for empty). */
export function regionRows(region: WallRegion): number {
  return region.tiles.reduce((m, t) => Math.max(m, t.y + t.h), 0);
}

/** Rendered px height of a region (auto-grows with content; min for empties). */
export function regionHeightPx(region: WallRegion): number {
  const rows = regionRows(region);
  return rows === 0 ? MIN_REGION_PX : rows * ROW_PX;
}

/** Convert a pointer position inside a region's grid to a snapped (x, y) cell. */
export function pointToCell(
  localX: number,
  localY: number,
  pitch: number,
  cols: number,
  w: number,
): { x: number; y: number } {
  const x = clamp(Math.round(localX / pitch), 0, Math.max(0, cols - w));
  const y = Math.max(0, Math.round(localY / ROW_PX));
  return { x, y };
}

// ── Collision + compaction (float:false gravity-up) ──────────────────────────

export function collides(a: WallTile, b: WallTile): boolean {
  if (a.sessionId === b.sessionId) return false;
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

const byPosition = (tiles: WallTile[]) =>
  [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);

/**
 * Pack tiles to the top (gravity-up), preserving their reading order. If
 * `priorityId` is given, that tile stays exactly where it is and everything
 * else gravitates around it — this is how a freshly dropped/resized tile holds
 * its slot while neighbours reflow. Mirrors react-grid-layout's `compact`.
 */
export function compact(tiles: WallTile[], priorityId: string | null = null): WallTile[] {
  const placed: WallTile[] = [];
  const priority = priorityId ? tiles.find((t) => t.sessionId === priorityId) : undefined;
  if (priority) placed.push({ ...priority });
  for (const t of byPosition(tiles.filter((x) => x.sessionId !== priorityId))) {
    let y = 0;
    // lowest y (from the top) where this tile doesn't overlap a placed one
    // eslint-disable-next-line no-loop-func
    while (placed.some((o) => collides({ ...t, y }, o))) y += 1;
    placed.push({ ...t, y });
  }
  // Return in the input's id order so React keys stay stable across reflows.
  const order = new Map(tiles.map((t, i) => [t.sessionId, i]));
  return placed.sort((a, b) => (order.get(a.sessionId)! - order.get(b.sessionId)!));
}

/** Guard a tile against a region's column count (used on migrate/normalize). */
function clampTile(t: WallTile, cols: number): WallTile {
  const w = clamp(Math.round(t.w) || DEFAULT_W, MIN_W, cols);
  const h = Math.max(MIN_H, Math.round(t.h) || DEFAULT_H);
  const x = clamp(Math.round(t.x) || 0, 0, cols - w);
  const y = Math.max(0, Math.round(t.y) || 0);
  return { sessionId: t.sessionId, x, y, w, h };
}

// ── Single-region mutations ──────────────────────────────────────────────────

export function moveTile(
  tiles: WallTile[],
  id: string,
  x: number,
  y: number,
  cols = WALL_COLS,
): WallTile[] {
  const moving = tiles.find((t) => t.sessionId === id);
  if (!moving) return tiles;
  const nx = clamp(x, 0, cols - moving.w);
  const ny = Math.max(0, y);
  const next = tiles.map((t) => (t.sessionId === id ? { ...t, x: nx, y: ny } : t));
  return compact(next, id);
}

export function resizeTile(
  tiles: WallTile[],
  id: string,
  w: number,
  h: number,
  cols = WALL_COLS,
): WallTile[] {
  const t0 = tiles.find((t) => t.sessionId === id);
  if (!t0) return tiles;
  const nw = clamp(w, MIN_W, cols - t0.x);
  const nh = Math.max(MIN_H, h);
  const next = tiles.map((t) => (t.sessionId === id ? { ...t, w: nw, h: nh } : t));
  return compact(next, id);
}

/** Append a new tile at the bottom of a region, packed. */
export function appendTile(tiles: WallTile[], id: string, cols = WALL_COLS): WallTile[] {
  const maxY = tiles.reduce((m, t) => Math.max(m, t.y + t.h), 0);
  const w = Math.min(DEFAULT_W, cols);
  return compact([...tiles, { sessionId: id, x: 0, y: maxY, w, h: DEFAULT_H }]);
}

/** Auto-arrange a flat id list into a packed grid (default / reset). */
export function autoPack(ids: string[], cols = WALL_COLS): WallTile[] {
  const w = Math.min(DEFAULT_W, cols);
  const perRow = Math.max(1, Math.floor(cols / w));
  return ids.map((id, i) => ({
    sessionId: id,
    x: (i % perRow) * w,
    y: Math.floor(i / perRow) * DEFAULT_H,
    w,
    h: DEFAULT_H,
  }));
}

// ── Region-tree mutations ────────────────────────────────────────────────────

function findRegionOf(regions: WallRegion[], sessionId: string): WallRegion | undefined {
  return regions.find((r) => r.tiles.some((t) => t.sessionId === sessionId));
}

/** Remove a tile from whichever region holds it. */
function extractTile(
  regions: WallRegion[],
  sessionId: string,
): { regions: WallRegion[]; tile: WallTile | null } {
  let tile: WallTile | null = null;
  const next = regions.map((r) => {
    const found = r.tiles.find((t) => t.sessionId === sessionId);
    if (!found) return r;
    tile = found;
    return { ...r, tiles: r.tiles.filter((t) => t.sessionId !== sessionId) };
  });
  return { regions: next, tile };
}

/** Drop a tile into an existing region at a snapped (x, y). Prunes an emptied source. */
export function moveTileToRegion(
  layout: WallLayout,
  sessionId: string,
  targetRegionId: string,
  x: number,
  y: number,
): WallLayout {
  const sourceId = findRegionOf(layout.regions, sessionId)?.id ?? null;
  const { regions, tile } = extractTile(layout.regions, sessionId);
  if (!tile) return layout;
  let next = regions.map((r) => {
    if (r.id !== targetRegionId) return r;
    const w = Math.min(tile!.w, r.cols);
    const placed: WallTile = {
      ...tile!,
      w,
      x: clamp(x, 0, r.cols - w),
      y: Math.max(0, y),
    };
    return { ...r, tiles: compact([...r.tiles, placed], sessionId) };
  });
  if (sourceId && sourceId !== targetRegionId) {
    next = next.filter((r) => !(r.id === sourceId && r.tiles.length === 0));
  }
  return { version: 2, regions: next };
}

/** Pull a tile into a brand-new region inserted at `boundaryIndex`. */
export function splitWithTile(
  layout: WallLayout,
  boundaryIndex: number,
  sessionId: string,
): WallLayout {
  const sourceId = findRegionOf(layout.regions, sessionId)?.id ?? null;
  const { regions, tile } = extractTile(layout.regions, sessionId);
  if (!tile) return layout;
  const newRegion: WallRegion = {
    id: makeRegionId(),
    cols: WALL_COLS,
    tiles: [{ ...tile, x: 0, y: 0, w: Math.min(tile.w, WALL_COLS) }],
  };
  const bi = clamp(boundaryIndex, 0, regions.length);
  let next = [...regions.slice(0, bi), newRegion, ...regions.slice(bi)];
  if (sourceId) next = next.filter((r) => !(r.id === sourceId && r.tiles.length === 0));
  return { version: 2, regions: next };
}

/** Insert an empty region at `boundaryIndex` (the "+ Split" affordance). */
export function addEmptyRegion(layout: WallLayout, boundaryIndex: number): WallLayout {
  const bi = clamp(boundaryIndex, 0, layout.regions.length);
  const region: WallRegion = { id: makeRegionId(), cols: WALL_COLS, tiles: [] };
  return {
    version: 2,
    regions: [...layout.regions.slice(0, bi), region, ...layout.regions.slice(bi)],
  };
}

function mergeRegions(above: WallRegion, below: WallRegion): WallRegion {
  const offsetY = regionRows(above);
  const moved = below.tiles.map((t) => ({
    ...clampTile(t, above.cols),
    y: t.y + offsetY,
  }));
  return { ...above, tiles: compact([...above.tiles, ...moved]) };
}

/**
 * Delete the section divider that sits above region index `belowIndex`, rolling
 * that region's chats UP into the region above it. No-op for the top end-cap
 * (nothing above) or when there's only one region.
 */
export function mergeAtBoundary(layout: WallLayout, belowIndex: number): WallLayout {
  const regions = layout.regions;
  if (belowIndex <= 0 || belowIndex >= regions.length) return layout;
  const merged = mergeRegions(regions[belowIndex - 1], regions[belowIndex]);
  return {
    version: 2,
    regions: [
      ...regions.slice(0, belowIndex - 1),
      merged,
      ...regions.slice(belowIndex + 1),
    ],
  };
}

// ── Normalize + migrate ──────────────────────────────────────────────────────

/**
 * Reconcile the tree against the live pinned set: drop tiles that are no longer
 * pinned or whose session is gone, de-dupe, clamp to each region's columns,
 * re-pack, and append any newly-pinned ids to the last region. Empty regions
 * are intentionally PRESERVED (so "+ Split" placeholders survive); incidental
 * empties from moves are pruned at the mutation site instead.
 */
export function normalizeWallLayout(
  layout: WallLayout,
  pinnedIds: string[],
  // null = don't drop for being non-live (used at render before sessions load);
  // a Set = ghost-prune against the live session ids.
  liveIds: Set<string> | null = null,
): WallLayout {
  const pinned = new Set(pinnedIds);
  const seen = new Set<string>();
  const regions: WallRegion[] = layout.regions.map((r) => {
    const cols = r.cols || WALL_COLS;
    const kept: WallTile[] = [];
    for (const t of r.tiles) {
      if (
        !pinned.has(t.sessionId) ||
        (liveIds && !liveIds.has(t.sessionId)) ||
        seen.has(t.sessionId)
      ) {
        continue;
      }
      seen.add(t.sessionId);
      kept.push(clampTile(t, cols));
    }
    return { ...r, cols, tiles: compact(kept) };
  });

  const missing = pinnedIds.filter((id) => (!liveIds || liveIds.has(id)) && !seen.has(id));
  if (missing.length) {
    if (regions.length === 0) {
      // Fresh layout — grid-pack everything into one region.
      regions.push({ id: makeRegionId(), cols: WALL_COLS, tiles: autoPack(missing, WALL_COLS) });
    } else {
      const last = regions[regions.length - 1];
      // An empty trailing region (a "+ Split" placeholder, or first load into
      // one) grid-packs; an already-populated region takes appends at the
      // bottom so existing tiles don't reflow.
      const tiles =
        last.tiles.length === 0
          ? autoPack(missing, last.cols)
          : missing.reduce((acc, id) => appendTile(acc, id, last.cols), last.tiles);
      regions[regions.length - 1] = { ...last, tiles };
    }
  }
  return { version: 2, regions };
}

/** Whether the normalized tree dropped anything vs the stored one (ghost prune). */
export function layoutTileIds(layout: WallLayout): string[] {
  return layout.regions.flatMap((r) => r.tiles.map((t) => t.sessionId));
}

/**
 * Read any persisted value (v2, legacy v1 `{lg:[…]}`, or junk) into a v2 tree.
 * The legacy layout was already a 12-col free grid, so v1 → one region with no
 * fidelity loss. Callers should still `normalizeWallLayout` the result.
 */
export function migrateWallLayout(raw: unknown): WallLayout {
  if (
    raw &&
    typeof raw === 'object' &&
    (raw as WallLayout).version === 2 &&
    Array.isArray((raw as WallLayout).regions)
  ) {
    return raw as WallLayout;
  }
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    const items = (Array.isArray(rec.lg)
      ? rec.lg
      : Array.isArray(rec.md)
        ? rec.md
        : Array.isArray(rec.sm)
          ? rec.sm
          : []) as WallLayoutItem[];
    const tiles = items
      .filter((it) => it && typeof it.i === 'string')
      .map<WallTile>((it) =>
        clampTile(
          { sessionId: it.i, x: Number(it.x) || 0, y: Number(it.y) || 0, w: Number(it.w) || DEFAULT_W, h: Number(it.h) || DEFAULT_H },
          WALL_COLS,
        ),
      );
    if (tiles.length) {
      return { version: 2, regions: [{ id: makeRegionId(), cols: WALL_COLS, tiles: compact(tiles) }] };
    }
  }
  return { version: 2, regions: [] };
}
