import type React from 'react';

/**
 * Tinted-glass emphasis: hue-tinted translucent fill + hairline inset ring +
 * top highlight. The app-wide replacement for edge accent bars (left/top
 * stripes, tab underlines). The ring is an inset box-shadow — not a border —
 * so toggling emphasis never shifts layout.
 *
 * `hue` accepts any color string (an oklch() literal or a CSS var()).
 * `fill`/`ring` are color-mix percentages; `on` is the base surface the fill
 * mixes into. The same percentages read correctly on both dark and light
 * glass surfaces.
 */
export function emphasisFill(
  hue: string,
  opts: { fill?: number; ring?: number; on?: string; highlight?: boolean } = {},
): React.CSSProperties {
  const { fill = 12, ring = 40, on = 'var(--glass-bg)', highlight = true } = opts;
  return {
    background: `color-mix(in oklch, ${hue} ${fill}%, ${on})`,
    boxShadow:
      `inset 0 0 0 1px color-mix(in oklch, ${hue} ${ring}%, transparent)` +
      (highlight ? ', inset 0 1px 0 var(--glass-highlight)' : ''),
  };
}
