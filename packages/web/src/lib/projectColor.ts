// Zen Project Hue Ring (plan §3.2). Each project deterministically resolves
// to one of 8 hues evenly distributed on the OKLCH wheel. Every entry shares
// Chroma + Lightness within its band — only hue varies — so any two
// projects' colors are perceptually equivalent against the canvas and a
// 4-tile Wall never has one tile dominating because of brighter hue.
//
// Two variants per hue: dark-mode (L=74) for use against the dark canvas,
// light-mode (L=48) for the light canvas. The `dot` field returns a single
// pickable color; `tint` returns a semi-transparent overlay tuned for the
// canvas; `stripe` is a stronger fill for legacy callers (sidebar stripe).
// The new WorkspaceTint component reads `from`/`to` for the gradient stops.

interface RingEntry {
  name: string;
  hue: number;
}

const RING: RingEntry[] = [
  { name: 'Lavender', hue: 285 },
  { name: 'Iris', hue: 250 },
  { name: 'Sky', hue: 215 },
  { name: 'Sage', hue: 165 },
  { name: 'Citrus', hue: 110 },
  { name: 'Apricot', hue: 70 },
  { name: 'Coral', hue: 30 },
  { name: 'Rose', hue: 350 },
];

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface ProjectColor {
  /** Strong fill — sidebar stripe legacy callers. */
  stripe: string;
  /** Soft overlay — older callers using `rgba(..., 0.12)` style tints. */
  tint: string;
  /** Single pickable color — project dot in chrome. */
  dot: string;
  /** Workspace gradient `from` stop (same hue, slightly lifted lightness). */
  from: string;
  /** Workspace gradient `to` stop (same hue, slightly dropped lightness). */
  to: string;
  /** Hue name (debug / tooltips). */
  name: string;
}

export function getProjectColor(id: string, dark: boolean): ProjectColor {
  const entry = RING[hashString(id) % RING.length];
  const H = entry.hue;
  // Band-anchored L per theme (see plan §3.1–§3.4). Chroma stays inside the
  // pastel envelope (0.10–0.12) so the hue is identifiable without screaming.
  const L = dark ? 74 : 48;
  const C = dark ? 0.1 : 0.12;
  const ramp = (dl: number) => `oklch(${L + dl}% ${C} ${H})`;
  return {
    name: entry.name,
    stripe: ramp(0),
    // Tint composites via the canvas color at use site (preferred — see
    // .mt-workspace-tinted in globals.css). For the rare caller that needs a
    // standalone semi-transparent value, expose it at low alpha.
    tint: `oklch(${L}% ${C} ${H} / 0.12)`,
    dot: ramp(0),
    // Same-hue gradient: ΔL=4 (plan §3.4 Rule 1). One hue per workspace —
    // never blend two project colors in a single gradient.
    from: ramp(+2),
    to: ramp(-2),
  };
}
