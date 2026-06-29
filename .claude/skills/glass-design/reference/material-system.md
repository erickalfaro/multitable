# The matte glass material system

This is the canonical recipe for MultiTable's frosted glass. Every value here
is a `color-mix()` / blur derivation of tokens that **already exist** in
`packages/web/src/styles/globals.css`, so glass auto-themes across BUILTIN_ZEN
(dark) and BUILTIN_ZEN_LIGHT (light) with no per-theme overrides.

## Why matte, mechanically

Glassmorphism = a semi-transparent fill + `backdrop-filter: blur()` + a subtle
border + soft shadow. The look slides from **matte** to **glossy** on a few
axes. We pin every axis to the matte end:

| Axis | Glossy (avoid) | **Matte (ours)** | Why |
|---|---|---|---|
| `saturate()` | 1.8 (ui.glass default) | **1.05** | Saturation is what makes glass read "wet". The single biggest lever. |
| Blur | 5–8px | **10–18px** | More blur = softer, frostier, less mirror-like. |
| Fill alpha | low (see-through, sharp) | **moderate** (28–30% transparent tint) | A milky fill diffuses the background instead of refracting it. |
| Highlights | specular rim-light, gradients | **single flat top hairline** | No bright "shine"; just enough edge to define the plane. |
| Grain | none (smooth/wet) | **faint noise overlay (~3%)** | Micro-texture kills the glossy sheen — this is the "frosted" tell. |
| Refraction | SVG/WebGL displacement | **none** | Refraction is inherently glossy + Chrome-only. |

## The tokens (proposed additions to `:root` in globals.css)

```css
/* ── Matte glass material system ───────────────────────────────────────────
   MATTE discipline: saturation stays ~1.05. ui.glass's saturate(180%) is what
   makes glass look glossy/wet — we do the opposite. Blur does the work. */
--glass-saturate:      1.05;
--glass-blur-chrome:   10px;   /* Tier 1: sidebar, header, status bars */
--glass-blur-float:    18px;   /* Tier 2: modals, drawers, palette, popovers */
--glass-blur-scrim:    4px;    /* Tier 3: backdrop behind modals */

/* Tints derive from the SAME --bg-* tokens the solid surfaces use, so light
   and dark themes both work with no override. ~28–30% transparent. */
--glass-tint-chrome:   color-mix(in oklch, var(--bg-sidebar)  78%, transparent);
--glass-tint-float:    color-mix(in oklch, var(--bg-elevated) 70%, transparent);
--glass-scrim:         oklch(12% 0.01 280 / 0.55);

/* Hairline border + single flat top highlight (NO specular). */
--glass-border:        color-mix(in oklch, var(--text-primary) 12%, transparent);
--glass-highlight:     color-mix(in oklch, white 7%, transparent);

/* Faint frosted grain — a tiny tiled feTurbulence noise as a data-URI, drawn
   via ::before at ~3% over soft-light. This is the matte "tell". */
--glass-grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
```

Note: the grain is the *only* SVG we use, and it's a static noise tile — **not**
`feDisplacementMap` refraction. It never touches the backdrop; it's a flat
overlay. Cheap and cross-browser.

## The utility classes (Tiers 1–3)

```css
/* Tier 1 — frosted chrome (sidebars, header/status bars). No own shadow;
   these sit flush against the canvas. */
.mt-glass-chrome {
  background: var(--glass-tint-chrome);
  -webkit-backdrop-filter: blur(var(--glass-blur-chrome)) saturate(var(--glass-saturate));
  backdrop-filter: blur(var(--glass-blur-chrome)) saturate(var(--glass-saturate));
  border-color: var(--glass-border);
}

/* Tier 2 — floating glass (modals, drawers, palette, popovers, composer).
   Carries elevation + a flat top highlight + grain. */
.mt-glass-float {
  position: relative;
  background: var(--glass-tint-float);
  -webkit-backdrop-filter: blur(var(--glass-blur-float)) saturate(var(--glass-saturate));
  backdrop-filter: blur(var(--glass-blur-float)) saturate(var(--glass-saturate));
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-soft);                 /* 10px */
  box-shadow: var(--shadow-lg), inset 0 1px 0 0 var(--glass-highlight);
}
.mt-glass-float::before {                            /* matte grain overlay */
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  pointer-events: none;
  background-image: var(--glass-grain);
  opacity: 0.03; mix-blend-mode: soft-light;
}

/* Tier 3 — modal backdrop scrim. Light blur so the app reads as "behind frosted
   glass" while the modal sits on top. */
.mt-glass-scrim {
  background: var(--glass-scrim);
  -webkit-backdrop-filter: blur(var(--glass-blur-scrim));
  backdrop-filter: blur(var(--glass-blur-scrim));
}
```

## Light theme

The tints are driven by themed `--bg-*`, so the classes work unchanged in light
mode. Two small nudges, added under the `[data-theme="light"]` block, keep
contrast:

```css
[data-theme="light"] {
  --glass-tint-chrome: color-mix(in oklch, var(--bg-sidebar)  82%, transparent);
  --glass-tint-float:  color-mix(in oklch, var(--bg-elevated) 76%, transparent);
  --glass-scrim:       oklch(18% 0.01 280 / 0.30);   /* light scrim, lower alpha */
  --glass-border:      color-mix(in oklch, var(--text-primary) 10%, transparent);
  --glass-highlight:   color-mix(in oklch, white 55%, transparent);
}
```

## Accessibility — required fallbacks

`backdrop-filter` and the grain are progressive enhancement. Always degrade to a
solid surface when the user opts out:

```css
@media (prefers-reduced-transparency: reduce) {
  .mt-glass-chrome { backdrop-filter: none; -webkit-backdrop-filter: none;
                     background: var(--bg-sidebar); }
  .mt-glass-float  { backdrop-filter: none; -webkit-backdrop-filter: none;
                     background: var(--bg-elevated); }
  .mt-glass-float::before { display: none; }
  .mt-glass-scrim  { backdrop-filter: none; background: var(--bg-overlay); }
}
```

Pair with the existing `@media (prefers-reduced-motion: reduce)` block (already
in globals.css around line 526) for the Wall's animated parts — see
[`the-wall.md`](the-wall.md).

## Browser / performance matrix

| Technique | Chrome | Safari | Firefox | Cost | Verdict |
|---|---|---|---|---|---|
| `backdrop-filter: blur() saturate()` | ✅ | ✅ | ✅ (115+) | low–med | **our whole system** |
| static SVG noise overlay (`::before`) | ✅ | ✅ | ✅ | negligible | our grain |
| CSS transform tilt / translate (Wall) | ✅ | ✅ | ✅ | low (GPU) | Wall slickness |
| SVG `feDisplacementMap` backdrop refraction | ✅ | ❌ | ❌ | high | **rejected** |
| WebGL liquid glass | ✅ | ✅ | ✅ | very high | **rejected** |

Rules of thumb:
- `backdrop-filter` is the cost driver — it re-rasterizes the layer beneath on
  scroll/resize. **Cap concurrent glass panels** (don't frost every list row;
  frost the *container*).
- Put `backdrop-filter` on a stable, infrequently-repainting element. Never on a
  fast-scrolling inner list — frost the chrome around it.
- Glass needs **something textured behind it** or it reads as a flat tint. The
  base canvas wears `.mt-workspace-gradient` for exactly this reason (see
  [`../multitable/surface-map.md`](../multitable/surface-map.md)).

## Relationship to the existing `.mt-glass`

`globals.css` already ships `.mt-glass` (`--glass-tint` + `blur(14px) saturate(1.1)`)
and uses it on the App detail drawer. The new tier classes are the forward path;
`.mt-glass` stays working for back-compat. Migrate ad-hoc `backdrop-filter`
sites (ConnectionOverlay, CommandConsole, the detail drawer) to the tier classes
over time — see [`../multitable/surface-map.md`](../multitable/surface-map.md).
