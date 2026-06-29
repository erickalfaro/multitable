# Color & OKLCH band discipline (absorbed from Zen)

The color system carries over from the Zen redesign unchanged — glass sits on
*top* of it. Canonical source: `packages/web/src/lib/themes.ts`
(`assertBandDiscipline()` warns at boot in dev). The pre-JS fallback lives in
the `:root` / `[data-theme="light"]` blocks of
`packages/web/src/styles/globals.css`. Historical narrative:
[docs/reference/ZEN_DESIGN.md](../../../../docs/reference/ZEN_DESIGN.md) §3.

## The single rule that catches the most bugs

**Every accent / project / status / category color lives in a narrow OKLCH
Lightness band.**

- **Dark band:** L = 74 ± 6, C ≈ 0.08–0.16.
- **Light band:** L = 48 ± 6, C ≈ 0.10–0.19.

Equal L across hues = equal *perceived* brightness, so any two colors pair
without one shouting and the other vanishing. `statusStopped` intentionally sits
*below* the band (L=45 dark / L=72 light) to read as "no activity". If you add a
new accent token to the `bandKeys` allowlist in `assertBandDiscipline()`, you've
opted that token into the boot check.

## Surface ladder (dark, from globals.css `:root`)

```
--bg-primary:    oklch(20% 0.01 280)   /* canvas */
--bg-sidebar:    oklch(24% 0.01 280)   /* → --glass-tint-chrome derives from this */
--bg-statusbar:  oklch(24% 0.01 280)
--bg-elevated:   oklch(28% 0.012 280)  /* → --glass-tint-float derives from this */
--bg-hover:      oklch(32% 0.014 280)
--bg-overlay:    oklch(12% 0.01 280 / 0.62)

--text-primary:   oklch(92% 0.005 280) /* → --glass-border / --glass-highlight derive from this */
--text-secondary: oklch(74% 0.01 280)
--text-muted:     oklch(55% 0.012 280)

--border:        oklch(100% 0 0 / 0.06)
--border-strong: oklch(100% 0 0 / 0.10)

--accent / --accent-blue: oklch(74% 0.10 285)   /* lavender; --accent-blue kept for ABI */
```

Light theme mirrors this at L=96 canvas / L=48 accent (see `[data-theme="light"]`).

**Why this matters for glass:** all glass tokens are `color-mix()` derivations of
these `--bg-*` / `--text-primary` tokens. That's the whole reason glass
auto-themes between dark and light with only two small light-mode nudges (see
[`material-system.md`](material-system.md)). Don't hardcode `rgba(255,255,255,…)`
in glass — derive from the tokens so theme switches stay correct.

## The 8-hue project ring

`packages/web/src/lib/projectColor.ts`. Each project deterministically hashes to
one of 8 evenly-spaced OKLCH hues; all share C+L within the band, only hue
varies, so a 4-tile Wall never has one tile dominating:

```
Lavender 285°  Iris 250°  Sky 215°  Sage 165°
Citrus   110°  Apricot 70°  Coral 30°  Rose 350°
```

`getProjectColor(id, dark)` returns `{ stripe, tint, dot, from, to, name }`:
- Dark: L=74, C=0.16. Light: L=48, C=0.19.
- `from`/`to` are a same-hue gradient at ΔL=4 (`ramp(+2)` / `ramp(-2)`) — used
  by `WorkspaceTint` to set `--workspace-from` / `--workspace-to`.
- **One hue per workspace** — never blend two project colors in one gradient.

The Wall's `--glass-tint-wall` mixes `--workspace-from` into the glass, so each
tile wears its project hue (see [`the-wall.md`](the-wall.md)).

## Anti-patterns to refuse

- Picking a new accent from a hex picker. Always derive in OKLCH inside the band
  (convert hex via oklch.com / `culori`, check L ∈ [70,78] dark or [44,52]
  light). If it doesn't fit, push back.
- Hardcoding `getProjectColor(id, false)` to force the light variant — that made
  loaders invisible on the dark canvas. Always derive `isDark` from theme state.
- Adding a glass tint that isn't a `color-mix()` of `--bg-*` — it will break in
  the other theme.
