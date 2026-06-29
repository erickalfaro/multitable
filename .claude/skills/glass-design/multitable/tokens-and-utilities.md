# Tokens & utilities — the copy-paste block for globals.css

This is the exact code to land in `packages/web/src/styles/globals.css` when the
redesign begins. It's additive — it doesn't change existing tokens, and it keeps
`.mt-glass` working. After landing, frost surfaces per
[`surface-map.md`](surface-map.md).

> Status: the skill ships this as the **prescription**. Landing it in
> `globals.css` is a separate, deliberate step (it's real product CSS, not docs).

## 1. Tokens — add to the `:root` block (near the existing `--blur-glass`)

```css
  /* ── Matte glass material system (glass-design skill) ──────────────────────
     MATTE discipline: saturation ~1.05. Tints derive from --bg-* so they theme
     automatically. Grain is a static noise tile (NOT refraction). */
  --glass-saturate:    1.05;
  --glass-blur-chrome: 10px;
  --glass-blur-float:  18px;
  --glass-blur-scrim:  4px;
  --glass-tint-chrome: color-mix(in oklch, var(--bg-sidebar)  78%, transparent);
  --glass-tint-float:  color-mix(in oklch, var(--bg-elevated) 70%, transparent);
  --glass-scrim:       oklch(12% 0.01 280 / 0.55);
  --glass-border:      color-mix(in oklch, var(--text-primary) 12%, transparent);
  --glass-highlight:   color-mix(in oklch, white 7%, transparent);
  --glass-grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");

  /* Showcase glass — Pinned Session Wall only (the one slick exception). */
  --glass-blur-wall: 16px;
  --glass-tint-wall: color-mix(in oklch, var(--workspace-from, var(--bg-elevated)) 14%, var(--bg-elevated));
  --glass-sheen:     color-mix(in oklch, white 22%, transparent);
  --glass-rim:       color-mix(in oklch, white 14%, transparent);
```

## 2. Light-theme nudges — add to the `[data-theme="light"]` block

```css
  --glass-tint-chrome: color-mix(in oklch, var(--bg-sidebar)  82%, transparent);
  --glass-tint-float:  color-mix(in oklch, var(--bg-elevated) 76%, transparent);
  --glass-scrim:       oklch(18% 0.01 280 / 0.30);
  --glass-border:      color-mix(in oklch, var(--text-primary) 10%, transparent);
  --glass-highlight:   color-mix(in oklch, white 55%, transparent);
```

## 3. Utility classes — add near the existing `.mt-glass` block

```css
/* Tier 1 — frosted chrome */
.mt-glass-chrome {
  background: var(--glass-tint-chrome);
  -webkit-backdrop-filter: blur(var(--glass-blur-chrome)) saturate(var(--glass-saturate));
  backdrop-filter: blur(var(--glass-blur-chrome)) saturate(var(--glass-saturate));
  border-color: var(--glass-border);
}

/* Tier 2 — floating glass */
.mt-glass-float {
  position: relative;
  background: var(--glass-tint-float);
  -webkit-backdrop-filter: blur(var(--glass-blur-float)) saturate(var(--glass-saturate));
  backdrop-filter: blur(var(--glass-blur-float)) saturate(var(--glass-saturate));
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-soft);
  box-shadow: var(--shadow-lg), inset 0 1px 0 0 var(--glass-highlight);
}
.mt-glass-float::before {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  pointer-events: none;
  background-image: var(--glass-grain); opacity: 0.03; mix-blend-mode: soft-light;
}

/* Tier 3 — modal scrim */
.mt-glass-scrim {
  background: var(--glass-scrim);
  -webkit-backdrop-filter: blur(var(--glass-blur-scrim));
  backdrop-filter: blur(var(--glass-blur-scrim));
}

/* Showcase — Pinned Session Wall tiles (see reference/the-wall.md) */
.mt-glass-wall {
  position: relative; isolation: isolate; overflow: hidden;
  background:
    linear-gradient(150deg, color-mix(in oklch, white 8%, transparent) 0%, transparent 38%),
    var(--glass-tint-wall);
  -webkit-backdrop-filter: blur(var(--glass-blur-wall)) saturate(1.18);
  backdrop-filter: blur(var(--glass-blur-wall)) saturate(1.18);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-comfortable);
  box-shadow:
    var(--shadow-lg),
    inset 0 1px 0 0 var(--glass-rim),
    inset 0 0 0 1px color-mix(in oklch, white 4%, transparent);
  transform: translateZ(0);
  transition: transform var(--dur-med) var(--ease-out), box-shadow var(--dur-med) var(--ease-out);
}
.mt-glass-wall:hover {
  transform: translateY(-2px) scale(1.006);
  box-shadow: var(--shadow-xl), inset 0 1px 0 0 var(--glass-rim);
}
.mt-glass-wall::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  pointer-events: none; z-index: 1;
  background: linear-gradient(115deg, transparent 30%, var(--glass-sheen) 48%, transparent 62%);
  transform: translateX(-120%);
  transition: transform var(--dur-slow) var(--ease-out);
}
.mt-glass-wall:hover::after { transform: translateX(120%); }
```

## 4. Accessibility — add (or extend the existing reduced-motion block)

```css
@media (prefers-reduced-motion: reduce) {
  .mt-glass-wall { transition: none; }
  .mt-glass-wall:hover { transform: none; }
  .mt-glass-wall::after { display: none; }
}
@media (prefers-reduced-transparency: reduce) {
  .mt-glass-chrome { backdrop-filter: none; -webkit-backdrop-filter: none; background: var(--bg-sidebar); }
  .mt-glass-float  { backdrop-filter: none; -webkit-backdrop-filter: none; background: var(--bg-elevated); }
  .mt-glass-float::before { display: none; }
  .mt-glass-scrim  { backdrop-filter: none; background: var(--bg-overlay); }
  .mt-glass-wall   { backdrop-filter: none; -webkit-backdrop-filter: none;
                     background: color-mix(in oklch, var(--workspace-from, var(--accent)) 12%, var(--bg-elevated)); }
}
```

## Optional: Tailwind

`tailwind.config.js` maps CSS vars to color classes but defines no backdrop-blur
utilities. The tier classes above make Tailwind backdrop utilities unnecessary —
prefer the semantic classes (`.mt-glass-float`) over `backdrop-blur-lg bg-white/10`
so the material stays centralized and themable. Only add Tailwind `backdropBlur`
scale entries if a one-off surface genuinely needs a bespoke blur.

## Verification after landing

1. `npm run dev` (daemon + web) and open `http://127.0.0.1:3000`.
2. Confirm in **both** dark and light (toggle theme): modals/chrome read matte
   and legible; the Wall tiles show the sheen sweep + hover tilt.
3. Toggle OS "reduce motion" and "reduce transparency" — confirm the Wall stops
   animating and all glass falls back to solid.
4. `npm run build -w @multitable/web` — no CSS/build regressions.
5. Use the chrome-devtools MCP (`take_screenshot`) to capture before/after of the
   Wall and a modal for review.
