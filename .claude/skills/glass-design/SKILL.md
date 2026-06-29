---
name: glass-design
description: Authoritative reference for MultiTable's frontend design language — the matte-frosted glassmorphism rebuild that absorbs and supersedes the earlier Zen language. Trigger when the user mentions glass, glassmorphism, frosted / matte glass, backdrop-filter, blur, the glass material tiers, the .mt-glass / .mt-glass-chrome / .mt-glass-float / .mt-glass-scrim / .mt-glass-wall utilities, the Pinned Session Wall "showcase" look, the sheen sweep / rim-light / hover tilt, OKLCH band discipline, the project hue ring, workspace tint, chrome-on-intent / .mt-auto-hide, SessionPane density, the design redesign, or modifying anything under packages/web/src/lib/themes.ts, packages/web/src/lib/projectColor.ts, packages/web/src/styles/globals.css, packages/web/src/components/main-pane/wall/, packages/web/src/components/theme/, or any chrome / modal / overlay surface that should wear glass.
allowed-tools: Bash, Read, Edit, Write, Grep
---

# Glass Design — MultiTable's matte-frosted design language

MultiTable's frontend is being redesigned around **matte frosted glass**. This
skill is the single authority for that visual language. It **absorbs** the
earlier Zen design principles (OKLCH band discipline, the project hue ring,
chrome-on-intent, density-as-prop, slowed motion, soft surfaces, the Wall as
homepage) and **supersedes** them with a glass *material* layer on top.

> The old `zen-design` skill is now a deprecation pointer to this one. The
> historical narrative still lives in
> [docs/reference/ZEN_DESIGN.md](../../../docs/reference/ZEN_DESIGN.md) — read it
> for the *why* behind colors/density; read **this skill** for what to build.

## The one fact that shapes everything

**Matte ≠ glossy, and the difference is one knob: saturation.** Every glass
surface in MultiTable uses CSS `backdrop-filter` with **low saturation
(~1.05)**. The popular glass generators (ui.glass uses `saturate(180%)`) crank
saturation to make glass look wet/vivid — that is the glossy look we are *not*
doing. We get the calm matte read with: **high blur + low saturation + a faint
grain overlay + flat (no specular) highlights + hairline low-alpha borders.**

We deliberately **do not** use SVG `feDisplacementMap` refraction or WebGL
"liquid glass" (rdev / archisvaze / dashersw / liquidglass-oss). That path is
glossy, GPU-heavy, and largely **Chrome-only** — wrong for a dense, text-first,
cross-browser dev dashboard. See [`reference/prior-art.md`](reference/prior-art.md)
for what we took from each library and what we rejected, with the numbers.

## The single deliberate exception: the Wall

The **Pinned Session Wall is the marquee surface** and gets a *slicker*
showcase treatment — animated specular sheen sweep on hover, edge rim-light,
hover tilt/parallax lift, brighter workspace-tinted glass. It is still **pure
CSS/transform** (cross-browser, GPU-cheap) — no SVG/WebGL. Everything else in
the app stays matte. See [`reference/the-wall.md`](reference/the-wall.md).

## The glass tiers (the core system)

Five tiers. Tiers 0–3 are matte; the Wall is the one slick exception.

| Tier | Class | Where | Blur / saturate |
|---|---|---|---|
| 0 — base | *(none)* | App canvas, **all dense text/code** (chat transcript, CodeBlock, xterm) | — solid, never glass over reading surfaces |
| 1 — chrome | `.mt-glass-chrome` | Sidebar, header/status bars | 10px / 1.05 |
| 2 — float | `.mt-glass-float` | Modals, drawers, palette, popovers, composer | 18px / 1.05 |
| 3 — scrim | `.mt-glass-scrim` | Backdrop behind modals | 4px |
| Showcase | `.mt-glass-wall` | **Pinned Session Wall tiles only** | 16px / 1.18 + sheen/rim/tilt |

Full recipe, exact tokens, light/dark variants, a11y fallbacks:
[`reference/material-system.md`](reference/material-system.md). Copy-paste
`globals.css` additions: [`multitable/tokens-and-utilities.md`](multitable/tokens-and-utilities.md).

## The eight absorbed Zen principles (still law)

1. **Chrome reveals on intent, not by default.** `.mt-auto-hide`.
2. **One color identifies one workspace.** 8-hue project ring.
3. **Density is a prop, not a fork.** `SessionPaneDensity`.
4. **Motion is slowed and intentional.** 120/200/320 ms.
5. **Whitespace is structural.** Generous padding.
6. **Surfaces are soft.** Radii 4/10/14, gentle shadows — **and now frosted.**
7. **The Wall is the homepage** — and the showcase glass surface.
8. **Every color is engineered in OKLCH bands.** Dark L=74±6, Light L=48±6.

Depth: [`reference/color-and-oklch.md`](reference/color-and-oklch.md) and
[`reference/motion-radii-density.md`](reference/motion-radii-density.md).

## Quick task → file map

| Task | Read / edit |
|---|---|
| Apply glass to a chrome / modal / overlay surface | [`multitable/surface-map.md`](multitable/surface-map.md) — find the tier, apply the class |
| Add the glass tokens + utility classes to the codebase | [`multitable/tokens-and-utilities.md`](multitable/tokens-and-utilities.md) → `packages/web/src/styles/globals.css` |
| Tune / understand the matte recipe | [`reference/material-system.md`](reference/material-system.md) |
| Touch the Wall showcase look (sheen, tilt, rim) | [`reference/the-wall.md`](reference/the-wall.md) → `packages/web/src/components/main-pane/wall/` |
| Add / tweak a theme color | `packages/web/src/lib/themes.ts` (+ `assertBandDiscipline`) — see [`reference/color-and-oklch.md`](reference/color-and-oklch.md) |
| Add a project hue | `packages/web/src/lib/projectColor.ts` — extend `RING` |
| Motion / radii / spacing tokens | `packages/web/src/styles/globals.css` `:root` — see [`reference/motion-radii-density.md`](reference/motion-radii-density.md) |
| Justify why we're not doing liquid/refraction glass | [`reference/prior-art.md`](reference/prior-art.md) |
| Scan known glass bugs before a PR | [`pitfalls.md`](pitfalls.md) |

## Anti-patterns to refuse

- **Glass over dense text or code.** Chat transcript bodies, `CodeBlock`, and
  the xterm terminal stay Tier 0 solid. Frosting reading surfaces destroys
  legibility. (See [`pitfalls.md`](pitfalls.md).)
- **Cranking saturation for "richer" glass.** `saturate()` above ~1.1 (except
  the Wall's 1.18) makes it glossy. If a surface looks flat, add blur or tint
  alpha — not saturation.
- **Reaching for SVG `feDisplacementMap` / WebGL refraction.** Chrome-only,
  GPU-heavy, glossy. Not in this design language. (`reference/prior-art.md`.)
- **Glass with nothing behind it.** `backdrop-filter` blurs the layer *below*.
  A glass panel over a flat solid color looks like a tinted box. Ensure a
  textured/tinted layer (the workspace-tinted wallpaper) sits behind it.
- **Picking an accent from a hex picker.** Always derive in OKLCH inside the
  band (L 70–78 dark / 44–52 light). See `reference/color-and-oklch.md`.
- **`.mt-auto-hide` on anything safety-critical** (permission prompts, modals,
  error banners). The user must see those without provoking them.

## When NOT to use this skill

Skip for purely-backend work (daemon adapters, transcripts, REST handlers
other than `/api/config`), provider wire-shape questions, or legacy frontend
not yet migrated to the design language (file viewer internals, etc.). Glass is
for chrome / floating / overlay surfaces and the Wall — not retroactive law for
every legacy file.
