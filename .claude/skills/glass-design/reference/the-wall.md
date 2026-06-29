# The Wall — slick showcase glass

The **Pinned Session Wall** (`packages/web/src/components/main-pane/wall/`) is
MultiTable's homepage and marquee surface. It is the **one deliberate exception**
to the matte-everywhere rule: its tiles get a *slick* showcase treatment so the
product's front door feels premium.

**Still pure CSS/transform.** No SVG `feDisplacementMap`, no WebGL. Everything
here works in Chrome, Safari, and Firefox and is GPU-cheap. We get "slick"
from: a layered top highlight, an edge rim-light, an **animated specular sheen
sweep on hover**, a **depth shadow + hover tilt/parallax lift**, and a slightly
higher saturation (1.18, the only place we go above matte's 1.05) plus the
workspace hue mixed into the glass tint.

## Existing substrate

The wall already ships `.mt-wall-tile` in globals.css:

```css
.mt-wall-tile {
  position: relative; display: flex; flex-direction: column; flex: 1;
  background: color-mix(in oklch, var(--accent) 10%, var(--bg-elevated));
  border-color: color-mix(in oklch, var(--accent) 35%, var(--border));
}
```

`.mt-glass-wall` below is the showcase upgrade — apply it to the tile element
(the `SessionTile` / `SessionFeedCard` container under `WallRegion`), composing
with or replacing `.mt-wall-tile`'s background.

## The tokens

```css
/* ── Showcase glass: Pinned Session Wall tiles ───────────────────────────── */
--glass-blur-wall:  16px;
/* Workspace hue mixed INTO the glass — each tile wears its project color.
   --workspace-from comes from the WorkspaceTint wrapper (projectColor.ts). */
--glass-tint-wall:  color-mix(in oklch, var(--workspace-from, var(--bg-elevated)) 14%, var(--bg-elevated));
--glass-sheen:      color-mix(in oklch, white 22%, transparent);  /* the moving highlight */
--glass-rim:        color-mix(in oklch, white 14%, transparent);  /* bright top/left edge */
```

## The class

```css
.mt-glass-wall {
  position: relative; isolation: isolate; overflow: hidden;
  background:
    linear-gradient(150deg,
      color-mix(in oklch, white 8%, transparent) 0%,
      transparent 38%),                                 /* soft top highlight */
    var(--glass-tint-wall);
  -webkit-backdrop-filter: blur(var(--glass-blur-wall)) saturate(1.18);
  backdrop-filter: blur(var(--glass-blur-wall)) saturate(1.18);  /* the one glossy carve-out */
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-comfortable);             /* 14px — wall tile radius */
  box-shadow:
    var(--shadow-lg),
    inset 0 1px 0 0 var(--glass-rim),                   /* rim-light */
    inset 0 0 0 1px color-mix(in oklch, white 4%, transparent);
  transform: translateZ(0);                             /* own compositing layer */
  transition: transform var(--dur-med) var(--ease-out),
              box-shadow var(--dur-med) var(--ease-out);
}

.mt-glass-wall:hover {
  transform: translateY(-2px) scale(1.006);             /* lift / parallax */
  box-shadow: var(--shadow-xl), inset 0 1px 0 0 var(--glass-rim);
}

/* Animated sheen sweep — a diagonal highlight that slides across on hover. */
.mt-glass-wall::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  pointer-events: none; z-index: 1;
  background: linear-gradient(115deg, transparent 30%, var(--glass-sheen) 48%, transparent 62%);
  transform: translateX(-120%);
  transition: transform var(--dur-slow) var(--ease-out);
}
.mt-glass-wall:hover::after { transform: translateX(120%); }
```

## Optional: pointer-reactive tilt

For the "tile follows the cursor" parallax, set two CSS vars from an
`onMouseMove` handler and consume them in the transform. Pure transform, still
cross-browser:

```tsx
// on the tile element
const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
  const r = e.currentTarget.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width - 0.5;   // -0.5 … 0.5
  const py = (e.clientY - r.top) / r.height - 0.5;
  e.currentTarget.style.setProperty('--mx', `${px}`);
  e.currentTarget.style.setProperty('--my', `${py}`);
};
const onLeave = (e: React.MouseEvent<HTMLDivElement>) => {
  e.currentTarget.style.setProperty('--mx', '0');
  e.currentTarget.style.setProperty('--my', '0');
};
```

```css
.mt-glass-wall { transform-style: preserve-3d; }
.mt-glass-wall:hover {
  transform: translateY(-2px)
             perspective(800px)
             rotateX(calc(var(--my, 0) * -4deg))
             rotateY(calc(var(--mx, 0) *  4deg));
}
```

Keep the tilt subtle (±4° max) — this is a dashboard, not a casino.

## Accessibility — mandatory

The sheen sweep and tilt are motion; the blur is transparency. Both must
degrade. Extend the existing media blocks:

```css
@media (prefers-reduced-motion: reduce) {
  .mt-glass-wall { transition: none; }
  .mt-glass-wall:hover { transform: none; }
  .mt-glass-wall::after { display: none; }   /* no sheen sweep */
}
@media (prefers-reduced-transparency: reduce) {
  .mt-glass-wall {
    backdrop-filter: none; -webkit-backdrop-filter: none;
    background: color-mix(in oklch, var(--workspace-from, var(--accent)) 12%, var(--bg-elevated));
  }
}
```

## Constraints

- The Wall is the **only** surface allowed `saturate > 1.1` and the only one
  with a sheen animation. Don't sprinkle the sheen elsewhere — its scarcity is
  what makes the homepage feel special.
- Tiles need the workspace-tinted wallpaper behind them (canvas wears
  `.mt-workspace-gradient`) so the blur has texture and each tile's
  `--workspace-from` reads. See [`../multitable/surface-map.md`](../multitable/surface-map.md).
- On mobile the Wall becomes the `PinnedFeed` (vertical list, read-only). Drop
  the hover sheen/tilt there (no hover); keep the static glass + rim-light.
- Respect the OKLCH equal-brightness guarantee: the per-tile hue comes from
  `getProjectColor(id, dark)` (`projectColor.ts`), so no tile dominates. Don't
  hand-pick tile colors. See [`color-and-oklch.md`](color-and-oklch.md).
