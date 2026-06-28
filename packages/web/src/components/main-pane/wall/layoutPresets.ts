import type { WallLayoutItem } from '../../../lib/types';

export type Breakpoint = 'lg' | 'md' | 'sm';

export const BREAKPOINT_COLS: Record<Breakpoint, number> = {
  lg: 12,
  md: 8,
  sm: 4,
};

const BREAKPOINTS: Breakpoint[] = ['lg', 'md', 'sm'];

const MIN_TILE_W = 2;
const MIN_TILE_H = 4;

export interface PresetGenerator {
  id: string;
  name: string;
  generate: (ids: string[], bp: Breakpoint) => WallLayoutItem[];
}

function distribute(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

export function equalGrid(ids: string[], bp: Breakpoint): WallLayoutItem[] {
  const n = ids.length;
  if (n === 0) return [];
  const cols = BREAKPOINT_COLS[bp];
  const gridCols = Math.min(n, Math.ceil(Math.sqrt(n)));
  const gridRows = Math.ceil(n / gridCols);
  const widths = distribute(cols, gridCols);
  const rowH = Math.max(MIN_TILE_H, Math.floor(20 / gridRows));
  return ids.map((id, i) => {
    const col = i % gridCols;
    const row = Math.floor(i / gridCols);
    const x = widths.slice(0, col).reduce((a, b) => a + b, 0);
    return {
      i: id,
      x,
      y: row * rowH,
      w: Math.max(MIN_TILE_W, widths[col]),
      h: rowH,
      minW: MIN_TILE_W,
      minH: MIN_TILE_H,
    };
  });
}

export function focusSidecars(ids: string[], bp: Breakpoint): WallLayoutItem[] {
  if (ids.length === 0) return [];
  const cols = BREAKPOINT_COLS[bp];
  if (ids.length === 1) return equalGrid(ids, bp);
  const heroW = Math.max(MIN_TILE_W, Math.floor((cols * 2) / 3));
  const sideW = Math.max(MIN_TILE_W, cols - heroW);
  const sideCount = ids.length - 1;
  const sideH = Math.max(MIN_TILE_H, Math.floor(16 / sideCount));
  const out: WallLayoutItem[] = [
    {
      i: ids[0],
      x: 0,
      y: 0,
      w: heroW,
      h: sideH * sideCount,
      minW: MIN_TILE_W,
      minH: MIN_TILE_H,
    },
  ];
  ids.slice(1).forEach((id, i) => {
    out.push({
      i: id,
      x: heroW,
      y: i * sideH,
      w: sideW,
      h: sideH,
      minW: MIN_TILE_W,
      minH: MIN_TILE_H,
    });
  });
  return out;
}

export function rows(ids: string[], bp: Breakpoint): WallLayoutItem[] {
  if (ids.length === 0) return [];
  const cols = BREAKPOINT_COLS[bp];
  const rowH = Math.max(MIN_TILE_H, Math.floor(20 / ids.length));
  return ids.map((id, i) => ({
    i: id,
    x: 0,
    y: i * rowH,
    w: cols,
    h: rowH,
    minW: MIN_TILE_W,
    minH: MIN_TILE_H,
  }));
}

export function columns(ids: string[], bp: Breakpoint): WallLayoutItem[] {
  if (ids.length === 0) return [];
  if (ids.length > 6) return equalGrid(ids, bp);
  const cols = BREAKPOINT_COLS[bp];
  const widths = distribute(cols, ids.length);
  return ids.map((id, i) => {
    const x = widths.slice(0, i).reduce((a, b) => a + b, 0);
    return {
      i: id,
      x,
      y: 0,
      w: Math.max(MIN_TILE_W, widths[i]),
      h: 16,
      minW: MIN_TILE_W,
      minH: MIN_TILE_H,
    };
  });
}

export const BUILTIN_PRESETS: PresetGenerator[] = [
  { id: 'equal-grid', name: 'Equal Grid', generate: equalGrid },
  { id: 'focus-sidecars', name: 'Focus + Sidecars', generate: focusSidecars },
  { id: 'rows', name: 'Rows', generate: rows },
  { id: 'columns', name: 'Columns', generate: columns },
];

export function buildPresetLayouts(
  generator: PresetGenerator,
  ids: string[],
): Record<Breakpoint, WallLayoutItem[]> {
  const out = {} as Record<Breakpoint, WallLayoutItem[]>;
  for (const bp of BREAKPOINTS) {
    out[bp] = generator.generate(ids, bp);
  }
  return out;
}

// Returns a layout that places every pinned id; for any id missing from the
// stored layout, append it via the equalGrid generator's next free slot.
// This means new pins land sensibly without wiping the user's hand-tuned tiles.
export function reconcileLayout(
  stored: WallLayoutItem[] | undefined,
  ids: string[],
  bp: Breakpoint,
): WallLayoutItem[] {
  if (!stored || stored.length === 0) return equalGrid(ids, bp);
  const known = new Map(stored.filter((it) => ids.includes(it.i)).map((it) => [it.i, it]));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length === 0) return Array.from(known.values());
  const cols = BREAKPOINT_COLS[bp];
  const maxY = Array.from(known.values()).reduce((m, it) => Math.max(m, it.y + it.h), 0);
  const tileW = Math.max(MIN_TILE_W, Math.floor(cols / Math.min(missing.length, 4)));
  const tileH = MIN_TILE_H + 2;
  missing.forEach((id, i) => {
    const col = (i * tileW) % cols;
    const rowOffset = Math.floor((i * tileW) / cols) * tileH;
    known.set(id, {
      i: id,
      x: col,
      y: maxY + rowOffset,
      w: tileW,
      h: tileH,
      minW: MIN_TILE_W,
      minH: MIN_TILE_H,
    });
  });
  return Array.from(known.values());
}
