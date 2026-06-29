# Motion, radii, spacing & density (absorbed from Zen)

These tokens carry over from the Zen redesign and are what the glass classes
build on. Source: the `:root` block of
`packages/web/src/styles/globals.css`. Narrative:
[docs/reference/ZEN_DESIGN.md](../../../../docs/reference/ZEN_DESIGN.md) §6.

## Radii — soft surfaces (now also frosted)

```
--radius-none: 0          structural seams (status bar, panel dividers)
--radius-snug: 4px        interactive primitives (buttons, inputs, badges, kbd)
--radius-soft: 10px       content containers (cards, modals, tool cards)  ← .mt-glass-float
--radius-comfortable: 14px  drawers, wall tiles, the composer             ← .mt-glass-wall
--radius-pill: 9999px     true circles (status dots, avatars)
```

Glass surfaces reuse these directly — `.mt-glass-float` uses `--radius-soft`,
`.mt-glass-wall` uses `--radius-comfortable`. Don't invent new radii for glass.

## Motion — slowed and intentional

```
--ease-out:  cubic-bezier(0.16, 1, 0.3, 1)
--ease-snap: cubic-bezier(0.22, 1, 0.36, 1)
--dur-fast: 120ms    --dur-med: 200ms    --dur-slow: 320ms
```

Glass motion mapping:
- Tile hover lift / box-shadow → `--dur-med` `--ease-out`.
- The Wall **sheen sweep** → `--dur-slow` `--ease-out` (the slow, luxe slide).
- `.mt-auto-hide` chrome fade → `--dur-med` (already in globals.css).

Everything collapses under the existing `@media (prefers-reduced-motion: reduce)`
block (~line 526). Any new animated glass part **must** add its reduced-motion
opt-out there or beside the class.

## Shadows — elevation tokens glass reuses

```
--shadow-sm / --shadow-md / --shadow-lg / --shadow-xl   (lg/xl used by glass)
--shadow-inset: inset 0 1px 0 oklch(100% 0 0 / 0.04)
```

`.mt-glass-float` = `--shadow-lg` + inset highlight. `.mt-glass-wall` hover =
`--shadow-xl`. Don't write bespoke `box-shadow` values for glass panels; compose
these.

## Spacing

```
--space-1: 4px   --space-2: 8px   --space-3: 12px
--space-4: 16px  --space-5: 24px  --space-6: 32px
```

Whitespace is structural — glass panels should breathe (generous internal
padding). Frosted chrome that's too tight reads as a smudged bar, not a surface.

## Density is a prop, not a fork

`SessionPaneDensity` (`comfortable` / `wall` / `card`) drives how a session
renders; the Wall uses the `wall` density inside each glass tile. **Never fork
`SessionChat` to make a glass variant** — pass density and let the one component
adapt. `card` density is the mobile read-only feed.

## Chrome on intent

`.mt-auto-hide` rests at 0.45 opacity, full on hover/focus/active; auto-disabled
on touch via `@media (hover: none)`. Glass chrome (`.mt-glass-chrome` on the
sidebar / header) composes with `.mt-auto-hide` — the surface frosts *and*
fades. **Never** put `.mt-auto-hide` on safety-critical surfaces (permission
prompts, modals, error banners).
