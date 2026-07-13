import type React from 'react';

export type EmphasisTone = 'soft' | 'medium' | 'strong';

/** Shared stroke used by rail mark + sections panel so they read as one outline. */
export const OUTLINE_WIDTH = 1;
export function outlineColor(hue: string): string {
  return `color-mix(in oklch, ${hue} 48%, transparent)`;
}
/** CSS border value — identical on rail dock marks and the sections frame. */
export function outlineBorder(hue: string): string {
  return `${OUTLINE_WIDTH}px solid ${outlineColor(hue)}`;
}

/**
 * Open-right outline for a docked *session* list row: left/top/bottom only.
 * Right edge stays open so the stroke connects into the panel gap / main pane.
 *
 * Implemented with inset box-shadows (not CSS borders) so a right stroke can
 * never reappear via border shorthand collapse, UA button styles, or radius.
 */
export function dockOutline(hue: string): React.CSSProperties {
  const c = outlineColor(hue);
  const w = OUTLINE_WIDTH;
  return {
    // Kill any border stroke on every side — shadows carry the open-right frame.
    border: 'none',
    borderTop: 'none',
    borderRight: 'none',
    borderBottom: 'none',
    borderLeft: 'none',
    borderRadius: 0,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    // Left + top + bottom only. No right inset, no closed rim.
    boxShadow: [
      `inset ${w}px 0 0 0 ${c}`,
      `inset 0 ${w}px 0 0 ${c}`,
      `inset 0 -${w}px 0 0 ${c}`,
    ].join(', '),
    outline: 'none',
  };
}

/**
 * Selection fill that stays open on the right — solid on the left, dissolves
 * toward the open edge so the row never reads as a closed card.
 */
export function dockPool(
  hue: string,
  opts: { fill?: number; tone?: EmphasisTone } = {},
): React.CSSProperties {
  const { fill = 10, tone = 'medium' } = opts;
  const scale = tone === 'strong' ? 1.15 : tone === 'soft' ? 0.72 : 1;
  const peak = Math.min(Math.round(fill * scale) + 2, 22);
  const mid = Math.min(Math.round(fill * scale), 16);
  // Long soft dissolve — no mid-row hard edge that would read as a right border.
  return {
    background: `linear-gradient(
      90deg,
      color-mix(in oklch, ${hue} ${peak}%, transparent) 0%,
      color-mix(in oklch, ${hue} ${mid}%, transparent) 40%,
      color-mix(in oklch, ${hue} ${Math.max(Math.round(mid * 0.55), 3)}%, transparent) 70%,
      color-mix(in oklch, ${hue} 2%, transparent) 88%,
      transparent 100%
    )`,
  };
}

/** Shared mix %s so selection pools stay consistent. */
function emphasisToneMix(tone: EmphasisTone) {
  if (tone === 'strong') return { edge: 28, specular: 34, bloom: 24 };
  if (tone === 'soft') return { edge: 14, specular: 14, bloom: 10 };
  return { edge: 22, specular: 24, bloom: 16 };
}

/**
 * Premium selection / hover pool — a luminous hue wash with soft metal depth.
 * Active rows read as lit surfaces, not flat tints or hard frames.
 *
 * `hue` accepts any color string (oklch() or CSS var()).
 * `fill` is the base color-mix percentage (default 10).
 * `tone` scales the stack: soft (multi-select / remote), medium (default),
 * strong (primary selected row).
 */
export function emphasisPool(
  hue: string,
  opts: { fill?: number; tone?: EmphasisTone } = {},
): React.CSSProperties {
  const { fill = 10, tone = 'medium' } = opts;
  const scale = tone === 'strong' ? 1.15 : tone === 'soft' ? 0.72 : 1;
  const top = Math.min(Math.round(fill * scale) + 3, 24);
  const mid = Math.min(Math.round(fill * scale), 20);
  const bot = Math.max(Math.round(fill * scale) - 2, 4);
  const { edge, specular, bloom } = emphasisToneMix(tone);
  // Row-scale: slightly quieter edge than panel frames; keep outer bloom.
  const rowEdge = Math.max(edge - 6, 8);

  return {
    background: `linear-gradient(
      165deg,
      color-mix(in oklch, ${hue} ${top}%, transparent) 0%,
      color-mix(in oklch, ${hue} ${mid}%, transparent) 48%,
      color-mix(in oklch, ${hue} ${bot}%, transparent) 100%
    )`,
    boxShadow: [
      // Top-lit metal edge
      `inset 0 1px 0 color-mix(in oklch, ${hue} ${specular}%, var(--metal-specular-soft))`,
      // Whisper hue rim (no hard card border)
      `inset 0 0 0 1px color-mix(in oklch, ${hue} ${rowEdge}%, transparent)`,
      // Soft ambient bloom so the row feels selected in depth
      `0 0 18px -6px color-mix(in oklch, ${hue} ${Math.min(bloom + 8, 32)}%, transparent)`,
    ].join(', '),
  };
}

/**
 * Tinted emphasis with optional ring. Defaults are pool-like so call sites
 * that haven't migrated stay quiet. Pass `ring` / `metal: true` only when a
 * true outline is required.
 */
export function emphasisFill(
  hue: string,
  opts: {
    fill?: number;
    ring?: number;
    on?: string;
    highlight?: boolean;
    metal?: boolean;
    tone?: 'soft' | 'medium' | 'strong';
  } = {},
): React.CSSProperties {
  const {
    fill = 10,
    ring = 0,
    on = 'transparent',
    highlight = false,
    metal = false,
    tone = 'medium',
  } = opts;

  if (ring <= 0 && !metal && !highlight) {
    // Pure pool — same recipe as emphasisPool when mixing into transparent.
    if (on === 'transparent') {
      return emphasisPool(hue, { fill, tone });
    }
    return {
      background: `color-mix(in oklch, ${hue} ${fill}%, ${on})`,
      boxShadow: 'none',
    };
  }

  const layers: string[] = [];
  if (ring > 0) {
    layers.push(`inset 0 0 0 1px color-mix(in oklch, ${hue} ${ring}%, transparent)`);
  }
  if (metal) {
    layers.push('inset 0 1px 0 var(--metal-specular)');
    layers.push('inset 0 -1px 0 oklch(0% 0 0 / 0.18)');
  } else if (highlight) {
    layers.push('inset 0 1px 0 var(--glass-highlight)');
  }

  return {
    background: `color-mix(in oklch, ${hue} ${fill}%, ${on})`,
    boxShadow: layers.length ? layers.join(', ') : 'none',
  };
}
