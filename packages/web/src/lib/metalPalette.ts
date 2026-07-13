/**
 * Derive a restrained metallic MeshGradient palette from a project hue.
 * Paper Shaders wants sRGB-ish CSS color strings (hex/rgb/hsl) — not OKLCH.
 *
 * Recipe (dark): deep gunmetal base + low-chroma project + lifted project +
 * cool neighbor (±30°). Light mode stays brighter / lower chroma so type
 * over frosted plate stays clean.
 */

import { getProjectColor } from './projectColor';

/** Parse hue degrees from an oklch() string; falls back to lavender 285. */
function hueFromOklch(oklch: string): number {
  // oklch(74% 0.16 285) or oklch(74% 0.16 285 / 0.12)
  const m = oklch.match(/oklch\(\s*[\d.]+%?\s+[\d.]+\s+([\d.]+)/i);
  return m ? Number(m[1]) : 285;
}

/** OKLCH → approximate sRGB hex via CSS Color Level 4 (browser runtime). */
let _canvas: HTMLCanvasElement | null = null;
function oklchToHex(oklch: string): string {
  if (typeof document === 'undefined') {
    // SSR / first-paint fallback — deep gunmetal
    return '#14121c';
  }
  if (!_canvas) _canvas = document.createElement('canvas');
  const ctx = _canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '#14121c';
  ctx.fillStyle = '#000000';
  ctx.fillStyle = oklch;
  const resolved = ctx.fillStyle as string;
  // ctx.fillStyle normalizes to #rrggbb or rgba(...)
  if (resolved.startsWith('#')) {
    return resolved.length === 9 ? resolved.slice(0, 7) : resolved;
  }
  const m = resolved.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return '#14121c';
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(+m[1])}${hex(+m[2])}${hex(+m[3])}`;
}

function clampHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

/**
 * Four mesh stops for the ambient living-metal field, keyed by project id.
 * Always returns hex so Paper Shaders never sees OKLCH.
 */
export function meshPaletteForProject(
  projectId: string | null | undefined,
  dark: boolean,
): string[] {
  // Default lavender when nothing is in scope (dashboard / empty).
  const hue = projectId
    ? hueFromOklch(getProjectColor(projectId, dark).stripe)
    : 285;

  if (dark) {
    // Deep gunmetal with a readable hue lift — still restrained, but bright
    // enough that MeshGradient survives shell blur + translucent plate.
    const base = oklchToHex(`oklch(12% 0.02 ${hue})`);
    const low = oklchToHex(`oklch(24% 0.055 ${hue})`);
    const mid = oklchToHex(`oklch(40% 0.10 ${hue})`);
    const lift = oklchToHex(`oklch(48% 0.08 ${clampHue(hue + 28)})`);
    return [base, low, mid, lift];
  }

  // Light: brushed silver-paper — keep chroma low.
  const base = oklchToHex(`oklch(94% 0.012 ${hue})`);
  const low = oklchToHex(`oklch(88% 0.03 ${hue})`);
  const mid = oklchToHex(`oklch(82% 0.05 ${hue})`);
  const lift = oklchToHex(`oklch(86% 0.035 ${clampHue(hue - 25)})`);
  return [base, low, mid, lift];
}

/** Shared selection / capsule hue string (OKLCH) for emphasisFill. */
export function projectHueCss(
  projectId: string | null | undefined,
  dark: boolean,
): string {
  if (!projectId) return 'var(--accent)';
  return getProjectColor(projectId, dark).dot;
}
