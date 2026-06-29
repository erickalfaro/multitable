# Prior art — what we took, what we rejected

The design language was distilled from six requested references plus the two
canonical CSS-only glass generators. This file records what each contributes and
**why MultiTable rejected the heavy/glossy techniques** — so nobody re-litigates
"why aren't we doing real liquid glass?".

## The verdict up front

Two families of glass exist:

1. **CSS-only frosted** — `backdrop-filter: blur() saturate()` + tint + border +
   shadow. Cross-browser, cheap, calm. **This is our entire system.**
2. **Refraction "liquid glass"** — SVG `feDisplacementMap` or WebGL shaders that
   bend the background like a lens, plus specular highlights and chromatic
   aberration. Glossy, GPU-heavy, **largely Chrome-only**. **Rejected** for a
   dense, text-first, cross-browser dashboard.

We took the *recipe values* from family 1 and tuned them matte. We took *nothing
runtime* from family 2 — only the lesson that refraction = glossy = skip.

## CSS-only generators (what we adopted, tuned matte)

### ui.glass / themesberg/glass-ui — the canonical frosted recipe
Default output:
```css
background: rgba(255, 255, 255, 0.75);
backdrop-filter: blur(16px) saturate(180%);
border: 1px solid rgba(209, 213, 219, 0.3);
border-radius: 12px;
```
**Took:** the blur(16px) ballpark, the hairline `border`, the ~12px radius.
**Changed:** `saturate(180%)` → **`1.05`**. That one number is the entire
matte-vs-glossy difference (see [`material-system.md`](material-system.md)). We
also derive the fill from OKLCH `--bg-*` tokens instead of opaque white so it
themes.

### css.glass — the minimalist baseline
Defaults: transparency `0.2`, blur `5px`, outline `0.3`.
**Took:** confirmation that a *small* feature set (fill + blur + 1px border +
soft shadow) is the whole effect. **Changed:** more blur (5px reads too sharp /
glossy for us).

## Refraction libraries (studied, rejected — with the numbers)

### rdev/liquid-glass-react
`backdrop-filter` + SVG `feDisplacementMap`. Props (matte preset they document):
`blurAmount 0.10–0.15`, `displacementScale 50–60`, `saturation 110–120`,
`aberrationIntensity 0.5`, `elasticity`, `cornerRadius`.
**Rejected because:** the displacement refraction is **Chrome-only** (Safari /
Firefox drop the SVG-filter backdrop), and even its "matte" preset is glossier
than we want. We *did* borrow the insight that saturation ~110–120 is the matte
zone — our 1.05–1.18 sits just under it.

### Cao-Junqi/liquidglass-oss (`@ogtirth/liquid-glass-oss`)
WebGL renderer; presets `frosted | clear | dark | prism | dome`; physics props
`refraction`, `tintColor`, `tintStrength`. Requires a matching `backgroundImage`
to sample. **Rejected:** WebGL per glass element is far too heavy for chrome and
modals; needs a sampled background image, which doesn't fit a live app canvas.

### archisvaze/liquid-glass
SVG `feDisplacementMap` + index-of-refraction + specular highlights + inner/outer
shadow + tint. README states the **SVG version is Chrome/Chromium-only**.
**Rejected:** same Chrome-only refraction problem; specular highlights are
explicitly the glossy look we avoid.

### dashersw/liquid-glass-js
WebGL 2.0; edge/rim/base distortion intensities (defaults edge `0.02`, rim
`0.08`, base, `blurRadius 7`, `tintOpacity 0.3`); `borderRadius` default 48px.
**Rejected:** WebGL again; the high default border-radius (pill-ish) and rim
distortion read as glossy/playful, off-brand for a calm dashboard.

## The one SVG thing we DO use

A **static `feTurbulence` noise tile** as a data-URI, drawn as a flat `::before`
overlay at ~3% (`--glass-grain`). This is *not* refraction — it never touches the
backdrop, it's a cheap cross-browser texture that gives the "frosted" (vs "wet")
tell. See [`material-system.md`](material-system.md).

## If someone insists on liquid refraction later

Confine it to **one hero surface** (e.g. a single Wall hero tile), gate it behind
Chrome detection with the CSS-only `.mt-glass-wall` as the universal fallback,
and budget for the GPU cost. Do **not** make it the default material. That
boundary is the whole point of this design language.

## Sources

- ui.glass generator — https://ui.glass/generator/
- css.glass — https://css.glass/
- rdev/liquid-glass-react — https://github.com/rdev/liquid-glass-react
- Cao-Junqi/liquidglass-oss — https://github.com/Cao-Junqi/liquidglass-oss (demo: https://liquid-glass-oss.vercel.app/)
- archisvaze/liquid-glass — https://github.com/archisvaze/liquid-glass
- dashersw/liquid-glass-js — https://github.com/dashersw/liquid-glass-js
- themesberg/glass-ui — https://github.com/themesberg/glass-ui
