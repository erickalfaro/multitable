/**
 * Left rail geometry.
 *
 * The rail is a fixed RAIL_COLLAPSED-wide column; rows show only their mark,
 * centered in RAIL_MARK_COL. Labels live in the floating RailTooltip (shown
 * after a hover dwell) — the rail itself never widens.
 */
export const RAIL_COLLAPSED = 60;
/** Identity / mark column — equals the rail width. */
export const RAIL_MARK_COL = RAIL_COLLAPSED;
