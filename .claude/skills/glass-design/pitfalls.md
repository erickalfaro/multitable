# Glass-design pitfalls

Scan before a PR that touches glass surfaces, the theme, or the Wall.

## 1. Glass with nothing behind it (the #1 "it looks wrong")
`backdrop-filter` blurs the layer *below*. Over a flat `--bg-primary`, a glass
panel is just a tinted box — no glassiness. **Fix:** ensure a textured/tinted
layer sits behind it. The canvas wears `.mt-workspace-gradient`; do that first.
See [`multitable/surface-map.md`](multitable/surface-map.md).

## 2. Frosting reading surfaces
Glass over chat transcript text, `CodeBlock`, or the xterm terminal wrecks
contrast and performance. **Those stay Tier 0 solid — always.** Frost the
container (sidebar/header/modal shell), keep the content solid.

## 3. Cranking saturation to make it "pop"
`saturate()` above ~1.1 is the glossy look we reject (ui.glass uses 1.8). The
only allowed exception is the Wall (1.18). If matte glass looks flat, add **blur
or tint alpha**, never saturation.

## 4. Reaching for SVG `feDisplacementMap` / WebGL
That's refraction "liquid glass": glossy, GPU-heavy, **Chrome-only** (Safari /
Firefox drop SVG-filter backdrops). Not in this design language. The only SVG we
use is a *static* noise tile for grain (`--glass-grain`), which never touches the
backdrop. See [`reference/prior-art.md`](reference/prior-art.md).

## 5. `backdrop-filter` on a fast-scrolling element
It re-rasterizes the layer beneath on every paint. Putting it on an inner
scrolling list = jank. **Frost the stable chrome around the list, not the list.**
Cap concurrent glass panels.

## 6. Hardcoding `rgba(255,255,255,…)` in glass
Breaks the other theme. All glass tokens are `color-mix()` of `--bg-*` /
`--text-primary` so they auto-theme. Derive from tokens, not literal white.
(The Wall's tiny `white 8%`/`22%` highlights are intentional and theme-safe via
`color-mix` over the tint; full-white *fills* are the bug.)

## 7. Forgetting the a11y fallbacks
Every glass surface needs a `prefers-reduced-transparency` solid fallback; every
animated glass part (Wall sheen/tilt) needs a `prefers-reduced-motion` opt-out.
Missing these is an accessibility regression. Block is in
[`multitable/tokens-and-utilities.md`](multitable/tokens-and-utilities.md) §4.

## 8. `.mt-auto-hide` on safety-critical surfaces
Permission prompts, modals, error banners must be visible without hover. Glass is
fine on them (`.mt-glass-float`); auto-hide is not.

## 9. Sprinkling the Wall sheen elsewhere
The animated sheen sweep + tilt belong to the Wall *only*. Their scarcity is what
makes the homepage feel special. Don't add them to modals or chrome.

## 10. Breaking OKLCH band discipline for a tile
Wall tile hues come from `getProjectColor(id, dark)` (equal perceived
brightness). Hand-picking a tile color makes one tile dominate the mosaic.
`assertBandDiscipline()` will warn at boot if a built-in token strays. See
[`reference/color-and-oklch.md`](reference/color-and-oklch.md).

## 11. Duplicating material in inline styles
The tier classes own background + blur + border + shadow + radius. Re-declaring
those inline drifts surfaces out of sync and defeats theming. Class owns the
material; inline owns layout only.

## 12. Light-theme scrim too dark
The dark `--glass-scrim` (alpha 0.55) over a light app reads as a heavy gray
veil. The `[data-theme="light"]` nudge drops it to a light, lower-alpha scrim —
don't skip it.
