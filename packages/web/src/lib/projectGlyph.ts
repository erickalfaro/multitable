/**
 * Project rail glyphs — multi-set Iconify compendium (~48k icons offline).
 *
 * Catalog sources (synced from ericks_design_store → public/iconify/):
 *   Lucide, Phosphor, Tabler, Heroicons, Radix, Feather, Material Symbols,
 *   Remix, Bootstrap Icons, Iconoir, Boxicons.
 *
 * Stored id: `prefix:name` (e.g. `tabler:robot`). Legacy bare Lucide ids still work.
 * Domain-agnostic — any project type, not just tech.
 */

export type {
  IconRef as ProjectGlyphOption,
  IconSetMeta,
} from './iconifyCatalog';

export {
  normalizeGlyphId,
  parseGlyphId,
  formatGlyphId,
  loadNamesIndex,
  ensureIconSet,
  ensureIconSets,
  searchIcons as searchProjectGlyphs,
  featuredIcons,
  FEATURED_ICON_IDS,
  getCachedSets,
  getTotalIconCount as projectGlyphCount,
  matchIconQuery as matchGlyphQuery,
  iconReady,
  isSetLoaded,
} from './iconifyCatalog';

import {
  featuredIcons,
  normalizeGlyphId,
  parseGlyphId,
  type IconRef,
} from './iconifyCatalog';

/** @deprecated Use featuredIcons() / searchProjectGlyphs. */
export const PROJECT_GLYPHS: IconRef[] = [];

/** @deprecated Prefer featuredIcons(). */
export const FEATURED_GLYPHS = featuredIcons();

/** @deprecated Full catalog is async via searchProjectGlyphs after loadNamesIndex. */
export const ALL_PROJECT_GLYPHS: IconRef[] = [];

/**
 * Resolve a stored glyph id to a ref (label + qualified id). Does not load SVG.
 * Returns null if the id cannot be parsed.
 */
export function getProjectGlyph(id: string | null | undefined): IconRef | null {
  const norm = normalizeGlyphId(id);
  if (!norm) return null;
  const p = parseGlyphId(norm);
  if (!p) return null;
  const label = p.name
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
  return { id: norm, prefix: p.prefix, name: p.name, label };
}

export function isProjectGlyphId(id: string): boolean {
  return getProjectGlyph(id) != null;
}
