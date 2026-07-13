/**
 * Left rail geometry — first principles.
 *
 * INNER track is always RAIL_EXPANDED wide.
 * OUTER shell clips to RAIL_COLLAPSED when idle, expands to RAIL_EXPANDED on hover.
 *
 * Each row is:
 *   [ MARK_COL (60px, content centered) | LABEL (rest) ]
 *
 * Collapsed, you only see the mark column → everything is centered in the panel.
 * Expanded, labels appear to the right → marks never move.
 */
export const RAIL_COLLAPSED = 60;
export const RAIL_EXPANDED = 188;
/** Identity / mark column — equals collapsed shell width. */
export const RAIL_MARK_COL = RAIL_COLLAPSED;
