# Zen Design Reference

The design language MultiTable's frontend was rebuilt around in June 2026
(branch `feat/zen-redesign-pinned-wall`, commit `503e9dd`). Inspired by
[Zen Browser](https://zen-browser.app)'s calm-by-default philosophy and
adapted for multi-screen, multi-session agentic work.

This document is the canonical reference. Inline code comments cite it
("Zen §2", "plan §3.4"); when those breadcrumbs disagree with this file,
**this file wins**.

If you're about to touch one of these, re-read the relevant section first:
- a theme token, accent, status color, or category tint → §3
- `lib/projectColor.ts` or anything that reads a project color → §3.2 + §5
- `SessionPane`, `SessionWall`, `SessionTile`, `PinnedFeed`, `SessionFeedCard` → §6
- `SessionHeaderBar`, `StatusBar`, chrome that appears on hover/idle → §4
- `dotmatrix-core.tsx`, `SessionStatusLoader`, `LoaderNode` → §7
- mobile branches, `useIsMobile`, anything `hover`-dependent → §8

---

## 1. Origin

The pre-Zen UI ("Obsidian") was a dense, monospace, 80ms-snappy single-pane
console: optimized for piloting one agent. Users actually work in the
opposite shape — monitoring many long-running agentic sessions across
screens. The legacy `DashboardView` project grid wasn't a home, it was a
detour. Chrome (header bar, status bar, detail panel) was always on.
Project/accent colors were picked one-by-one as raw hex; some were nearly
invisible against the canvas, others screamed.

Zen rebuilds the visual language on calm/focus principles, makes
**multi-session side-by-side** a first-class homepage (the **Pinned
Session Wall**), and enforces **OKLCH band discipline** so paired colors
can no longer disagree.

## 2. Principles

The eight rules every Zen decision answers to. When in doubt, re-check.

1. **Chrome reveals on intent, not by default.** Header bar, status bar,
   resize handles, scrollbars rest at low opacity (or hidden) and emerge on
   hover-within-zone, keyboard focus, or active state. The session itself
   is the foreground.
2. **One color identifies one workspace.** Each project owns a hue. That
   hue appears as a subtle tint on its session surfaces and as a stroke on
   its dotmatrix loader. Never as a stripe or block.
3. **Density is a prop, not a fork.** A session rendered as the main pane,
   a Wall tile, or a Glance peek is the same component with a `density`
   prop. No parallel implementations.
4. **Motion is slowed and intentional.** ~80ms → ~160–200ms baseline.
   Motion implies elevation/depth, not speed. `prefers-reduced-motion`
   collapses everything to instant.
5. **Whitespace is structural.** Padding tokens roughly doubled from the
   Obsidian era.
6. **Surfaces are soft.** Radii bump (snug 2→4, soft 4→10, comfortable=14
   new); subtle 1-step shadow returns for floating things; borders fade
   toward "barely there."
7. **The Wall is the homepage.** Default-on. The user lands there, not on
   a project grid.
8. **Every color is engineered, not picked.** All accent / project /
   status colors are anchored to a perceptual lightness band that
   guarantees readability against the active theme's background.
   **No raw hex picked by eye.**

## 3. Color system

The single most load-bearing piece. Two earlier UI bugs both traced to
not having this:

- Project A's color and Project B's color in a Wall side-by-side, one
  vanishes into the canvas while the other shouts. (Different perceptual
  L despite matching HSL L.)
- A "muted slate" used for a category icon is invisible against
  `--bg-primary` on dark.

### 3.1 Why OKLCH

OKLCH separates **L**ightness (perceptual), **C**hroma (saturation), and
**H**ue. Equal L across hues = equal perceived brightness. HSL is the
trap: yellow at HSL L=50 is much brighter than blue at HSL L=50; pair them
in a gradient and one endpoint disappears.

Browser support: Chrome 111+, Firefox 113+, Safari 15.4+. Native on iOS
Safari 15.4+ and Android Chrome. MultiTable is local-only Electron-ish; we
ship `oklch(...)` with no hex fallback.

### 3.2 The bands

| Surface         | Dark `bg-primary` L | Light `bg-primary` L |
|-----------------|---------------------|----------------------|
| Canvas          | 20%                 | 96%                  |
| Sidebar         | 24%                 | 93%                  |
| Elevated        | 28%                 | 98%                  |
| Hover           | 32%                 | 89%                  |
| Text primary    | 92%                 | 18%                  |
| Text secondary  | 74%                 | 38%                  |
| Text muted      | 55%                 | 55%                  |

Slight 280° hue (cool violet) on dark, 80° hue (warm) on light — barely
perceptible (saturation 0.5–1.4%), keeps the canvas off pure gray.

**The accent band** is where every project, status, and category color
lives:

- **Dark theme accent band: `L = 74% ± 4`, `C = 0.08–0.13`.** ΔL≈54 against
  `bg-primary` — well above APCA non-text decorative threshold.
- **Light theme accent band: `L = 48% ± 4`, `C = 0.10–0.14`.** ΔL≈48 against
  the light canvas.

`--status-stopped` is the *only* color allowed to leave the band
(L=45 dark / L=72 light) — it deliberately reads as muted because it
signifies absence of activity.

### 3.3 The 8-hue project ring

[`packages/web/src/lib/projectColor.ts`](../../packages/web/src/lib/projectColor.ts):

| Name      | Hue  | Dark variant            | Light variant           |
|-----------|------|-------------------------|-------------------------|
| Lavender  | 285° | oklch(74% 0.10 285)     | oklch(48% 0.12 285)     |
| Iris      | 250° | oklch(74% 0.10 250)     | oklch(48% 0.12 250)     |
| Sky       | 215° | oklch(74% 0.10 215)     | oklch(48% 0.12 215)     |
| Sage      | 165° | oklch(74% 0.10 165)     | oklch(48% 0.12 165)     |
| Citrus    | 110° | oklch(74% 0.10 110)     | oklch(48% 0.12 110)     |
| Apricot   | 70°  | oklch(74% 0.10 70)      | oklch(48% 0.12 70)      |
| Coral     | 30°  | oklch(74% 0.10 30)      | oklch(48% 0.12 30)      |
| Rose      | 350° | oklch(74% 0.10 350)     | oklch(48% 0.12 350)     |

Hues are spaced 35–45° apart — adjacent projects are perceptually distinct
without being garish. **9th+ project wraps and shares Lavender**; each
project still has its own gradient stop pair, so they're not
indistinguishable, just same-hue family.

`getProjectColor(id, isDark)` returns `{ stripe, tint, dot, from, to, name }`.
`from`/`to` are same-hue gradient stops at ΔL=4 (used by the workspace
tint utility — see §5).

### 3.4 Workspace gradient rules

These three rules are why pairings can't disagree anymore.

**Rule 1 — Workspace tints are single-hue.** A project's workspace
gradient is `linear-gradient(135deg, var(--workspace-from), var(--workspace-to))`
where `from` and `to` are the **same hue, ΔL=4**. One hue per workspace.
No cross-project mixing in a single gradient surface.

**Rule 2 — Composite via `color-mix(in oklch)`, never raw rgba.** A
workspace tint over a surface is:
```css
background: color-mix(in oklch, var(--workspace-from) 7%, var(--bg-primary));
```
This guarantees a predictable landing L (7% of L=74 mixed into L=20 gives
~L=24, just visible as a wash). Raw `rgba(...)` over the canvas gave
inconsistent results across themes.

**Rule 3 — Adjacent-hue only for cross-project gradients.** The Wall keeps
tiles separated by gap — no cross-project gradient surface today. The rule
exists prophylactically: if any future surface mixes two projects,
restrict to projects whose hues are within 60° of each other at matching L/C.

### 3.5 Status and category tokens

Same band as projects, just different domain.

| Token             | Dark                    | Role                    |
|-------------------|-------------------------|-------------------------|
| `--status-running`| oklch(76% 0.11 160)     | mint — turn in flight   |
| `--status-warning`| oklch(78% 0.11 70)      | apricot                 |
| `--status-error`  | oklch(70% 0.14 25)      | coral                   |
| `--status-idle`   | oklch(60% 0.02 280)     | muted (intentional)     |
| `--status-stopped`| oklch(45% 0.01 280)     | quiet (intentional)     |

The 10 `--cat-*` (alert categories) and 10 `--node-*` (tool families) tokens
follow the same hue ring, shifted 18° between the two domains so they
never collide in the same UI region. All at `L=74, C=0.08` on dark
(slightly less saturated than projects to avoid competing with workspace
identity tints).

### 3.6 Boot-time guardrail

[`packages/web/src/lib/themes.ts`](../../packages/web/src/lib/themes.ts)'s
`assertBandDiscipline(theme)` runs in dev mode every time
`applyThemeToDocument` is called. It scans the built-in Zen themes for any
accent/status/category token whose L falls outside the expected band ±6 and
logs:

```
[zen-theme] builtin-zen.statusWarning L=85% is outside band (expected 74±6).
This is the "invisible color" trap — see plan §3.
```

If you add a token, add it to the `bandKeys` array in that function so
the assertion catches accidental drift.

## 4. Chrome on intent

The frontend used to scream all its chrome at the user at all times. Zen
flips that: chrome is present but dim, and reveals only when the user
moves intent toward it.

### 4.1 The `.mt-auto-hide` utility

[`packages/web/src/styles/globals.css`](../../packages/web/src/styles/globals.css):

```css
.mt-auto-hide {
  opacity: 0.45;
  transition: opacity var(--dur-med) var(--ease-out);
}
.mt-auto-hide:hover,
.mt-auto-hide:focus-within,
.mt-auto-hide[data-active='true'] {
  opacity: 1;
}
@media (hover: none) {
  .mt-auto-hide { opacity: 1; }
}
```

Three triggers reveal: hover, focus-within (composer focus rises through),
explicit `data-active="true"` (set by SessionPane when a turn is
streaming). Touch devices always-full per `@media (hover: none)`.

Applied to:
- [`SessionHeaderBar`](../../packages/web/src/components/main-pane/SessionHeaderBar.tsx)
  (desktop only — the mobile branch keeps the header always-visible per §8)
- [`StatusBar`](../../packages/web/src/components/status-bar/StatusBar.tsx)
- Wall tile headers (the project label / expand / unpin row)

Don't apply auto-hide to anything safety-critical: permission prompts,
error banners, modals. The user needs to see those without provoking them.

### 4.2 Detail panel = drawer, not column

The pre-Zen layout had `SessionDetailPanel` as a third always-visible
`PanelGroup` column. Zen converts it to a fixed-position right drawer
([`App.tsx`](../../packages/web/src/App.tsx)) with backdrop blur and
click-outside dismiss. Cmd+. still toggles. Defaults to closed.

Side effect: desktop and mobile now share the same structural pattern
(both are sheet overlays), one less branch in the layout.

### 4.3 Other chrome reductions

- Resize handles: 3px at rest, 5px on hover (was 6px always).
- Scrollbars: 6px wide, fade in on hover only (was 10px always-visible).

## 5. Workspace tint

The mechanism that puts §2 rule 2 ("one color identifies one workspace")
into a surface.

### 5.1 Two utility classes

[`globals.css`](../../packages/web/src/styles/globals.css):

```css
.mt-workspace-tinted {
  background-color: color-mix(
    in oklch,
    var(--workspace-from, transparent) 7%,
    var(--bg-elevated)
  );
}
.mt-workspace-gradient {
  background-image: linear-gradient(
    135deg,
    color-mix(in oklch, var(--workspace-from, transparent) 10%, var(--bg-elevated)),
    color-mix(in oklch, var(--workspace-to,   transparent)  6%, var(--bg-elevated))
  );
}
```

The element must have `--workspace-from` / `--workspace-to` set in its
inline style. If they're not set, the surface falls through cleanly to
`--bg-elevated` — no color at all, no broken state.

### 5.2 Two ways to set the vars

**A) `<WorkspaceTint>` wrapper** ([`components/theme/WorkspaceTint.tsx`](../../packages/web/src/components/theme/WorkspaceTint.tsx))
— for callers that want a quick wrap, no other behavior:

```tsx
<WorkspaceTint projectId={projectId}>
  <YourSurface />
</WorkspaceTint>
```

**B) Inline vars** — preferred when the consumer already has its own
behavior (click handler, focus state, etc.):

```tsx
const c = getProjectColor(session.projectId, isDark);
const vars: CSSProperties = {
  ['--workspace-from' as any]: c.from,
  ['--workspace-to' as any]: c.to,
};
return <article className="mt-wall-tile mt-workspace-tinted" style={vars}>...</article>;
```

`SessionTile` and `SessionFeedCard` use pattern B (they have click + focus
behavior). New leaf surfaces with no behavior should use A.

### 5.3 Theme awareness

`getProjectColor(id, isDark)` needs to know the active theme to pick the
right band. The cheap pattern (used by `SessionStatusLoader` and
`LoaderNode`) is reading the document attribute set by
`applyThemeToDocument`:

```ts
const isDark =
  typeof document === 'undefined' ||
  document.documentElement.getAttribute('data-theme') !== 'light';
```

For components that already subscribe to theme state (e.g. via the store),
read `activeThemeId` + `customThemes` and resolve `isDark` from there
(see `SessionTile`).

## 6. SessionPane and density

§2 rule 3 made flesh. The same React component renders a session in three
shapes; what changes is a config object.

[`packages/web/src/components/main-pane/chat/SessionPane.tsx`](../../packages/web/src/components/main-pane/chat/SessionPane.tsx):

```ts
type SessionPaneDensity = 'comfortable' | 'wall' | 'card';
```

| Aspect         | `comfortable`    | `wall`          | `card`         |
|----------------|------------------|-----------------|----------------|
| SessionHeaderBar | shown          | hidden (tile chrome) | hidden       |
| ProcessBanner    | shown          | shown (on err)  | hidden         |
| PermissionBar    | shown          | shown           | hidden         |
| Composer         | full            | full            | **hidden**     |
| PinnedUserPrompt | shown           | hidden          | hidden         |
| Message tail     | unlimited       | 12              | 3              |
| Prose-only filter| no             | no              | **yes** (no tool/reasoning) |
| In-flight reasoning | passed       | passed          | suppressed     |
| In-flight tool   | passed          | passed          | suppressed     |

**Comfortable** = the main pane view; this is what `SessionChat` (now a
thin wrapper) renders.

**Wall** = the desktop tile body inside `SessionTile`. Trimmed but still
interactive — you can type into the focused tile's composer.

**Card** = the mobile feed item inside `SessionFeedCard`. Read-only. The
whole card is a tap target into the full pane.

**Don't add a fourth density without a good reason.** Three is the
minimum that covers the use cases; four invites parallel-implementation
drift.

### 6.1 The Wall

[`packages/web/src/components/main-pane/wall/SessionWall.tsx`](../../packages/web/src/components/main-pane/wall/SessionWall.tsx)
— responsive CSS grid (`auto-fit, minmax(360px, 1fr)`, gap = `--space-3`).
On a 14" laptop renders 2-up; on a 27" monitor 4–5-up. Empty state nudges
the user toward pinning.

`focusedPaneId` (store) determines which tile owns input. Other tiles dim
to 0.72 via `.mt-wall[data-has-focus='true'] .mt-wall-tile:not([data-focused])`.

### 6.2 The mobile Feed

[`packages/web/src/components/main-pane/wall/PinnedFeed.tsx`](../../packages/web/src/components/main-pane/wall/PinnedFeed.tsx)
— vertical scroll list. `SessionFeedCard` wraps `<SessionPane density="card">`
in a tap-target. **No composer.** Replying requires drilling in (taps
`setSelectedProcess(id)`).

[`MainPane.tsx`](../../packages/web/src/components/main-pane/MainPane.tsx)
picks Wall vs Feed via `useIsMobile()`.

### 6.3 Pin persistence

Three-layer store:
1. `useAppStore.pinnedSessionIds` — in-memory, source of truth for the UI.
2. `localStorage['mt:pinnedSessionIds']` — survives reload, hydrates the
   store synchronously on init (no flash).
3. `GlobalConfig.pinnedSessionIds` — server-persisted via `PATCH /api/config`,
   fire-and-forget from `togglePinSession`. Survives browser swap.

Pin UI surfaces:
- Sidebar right-click context menu ("Pin to Wall" / "Unpin from Wall").
- `SessionHeaderBar` icon (the `<PinToggle>` next to the detail-panel
  chevron).
- Cmd+P on whichever session is focused (Wall tile focus, or selected).
- Tile X-icon in the SessionTile header.

## 7. Dotmatrix evolution

The 60-variant per-session avatar system survives Zen but is restyled.

[`packages/web/src/components/ui/dotmatrix-core.tsx`](../../packages/web/src/components/ui/dotmatrix-core.tsx)
default parameters:

| Parameter   | Pre-Zen | Zen   | Why                          |
|-------------|---------|-------|------------------------------|
| `size`      | 24      | 16    | Smaller — calm not punchy    |
| `dotSize`   | 3       | 2.5   | Proportional to size         |
| `speed`     | 1       | 0.65  | Slower — Zen's motion target |

[`SessionStatusLoader`](../../packages/web/src/components/sidebar/SessionStatusLoader.tsx)
and [`LoaderNode`](../../packages/web/src/components/main-pane/chat/LoaderNode.tsx)
now resolve `color` against the active theme's band (was hardcoded
`isDark=false`, which gave the light-band L=48 value — too dark on the
Zen canvas).

If you add a new loader callsite, derive the color via `getProjectColor`
not via `currentColor` — keeps the workspace-identity rule consistent.

## 8. Mobile

The desktop Zen patterns port cleanly *except* anything that depends on
hover. Touch devices have no hover state; `:hover` rules silently no-op.

### 8.1 What ports cleanly

- The entire color system (OKLCH supported in iOS Safari 15.4+).
- All non-color tokens (radii, shadows, motion, typography). Prose font
  bumps to 14px under `@media (max-width: 640px)` for arm's-length
  legibility.
- The `SessionPane` density abstraction.
- Workspace tints.
- Dotmatrix loaders.

### 8.2 What transforms

- **The Wall becomes the Pinned Feed.** A 2-column grid at 375px gives
  165px per tile — unusable. The feed is the same store, same pins,
  different layout primitive.
- **Chrome on intent → chrome always-on.** `@media (hover: none)` in
  `.mt-auto-hide` flips opacity to 1. Mobile gets a stationary 52px top
  bar (in `App.tsx`'s `showAppTopBar` branch); the desktop
  `SessionHeaderBar` auto-hide is *not* applied to the mobile branch of
  that component.
- **Composer-on-card is dropped.** Mobile card density = read-only, tap
  to drill in. Avoids the keyboard-shows-up-and-eats-the-screen problem.
- **Pin gestures.** No hover-to-reveal pin icon on the feed; pin lives in
  the right-click menu (desktop) or in the SessionHeaderBar (after
  drilling in on mobile).

### 8.3 What's dropped

- Side-by-side / split view at mobile widths — physically impossible.
- `Cmd+1..9` / `Cmd+P` shortcuts — no keyboard.

## 9. What to grep before adding X

| If you're about to add…              | Grep first for…                            |
|--------------------------------------|--------------------------------------------|
| A new color anywhere                 | `oklch(` to see the band you're joining    |
| A new project hue                    | `RING` in `lib/projectColor.ts`            |
| A new density mode                   | `SessionPaneDensity` — and reconsider      |
| A new auto-hide chrome surface       | `.mt-auto-hide` usages                     |
| A new gradient                       | `.mt-workspace-gradient` — same hue only   |
| A new pin entry point                | `togglePinSession` usages                  |
| A new loader callsite                | `getProjectColor` + `SessionStatusLoader`  |
| A new keyboard shortcut              | `onKeyDown` in `App.tsx`                   |
| A new mobile branch                  | `useIsMobile()` + plan §8                  |

## 10. Files at a glance

The Zen-defining files. If you're new and want to read code, start here:

- [`packages/web/src/lib/themes.ts`](../../packages/web/src/lib/themes.ts)
  — `BUILTIN_ZEN`, `BUILTIN_ZEN_LIGHT`, `assertBandDiscipline`.
- [`packages/web/src/lib/projectColor.ts`](../../packages/web/src/lib/projectColor.ts)
  — the 8-hue ring.
- [`packages/web/src/styles/globals.css`](../../packages/web/src/styles/globals.css)
  — every CSS token; `.mt-auto-hide`, `.mt-glass`, `.mt-wall-tile`,
  `.mt-workspace-tinted`, `.mt-workspace-gradient`.
- [`packages/web/src/components/main-pane/chat/SessionPane.tsx`](../../packages/web/src/components/main-pane/chat/SessionPane.tsx)
  — the density-aware primitive.
- [`packages/web/src/components/main-pane/wall/SessionWall.tsx`](../../packages/web/src/components/main-pane/wall/SessionWall.tsx)
  — desktop grid.
- [`packages/web/src/components/main-pane/wall/PinnedFeed.tsx`](../../packages/web/src/components/main-pane/wall/PinnedFeed.tsx)
  — mobile feed.
- [`packages/web/src/components/theme/WorkspaceTint.tsx`](../../packages/web/src/components/theme/WorkspaceTint.tsx)
  — the workspace-tint wrapper.
- [`packages/web/src/stores/appStore.ts`](../../packages/web/src/stores/appStore.ts)
  — `pinnedSessionIds`, `focusedPaneId`, `togglePinSession`.
- [`packages/daemon/src/types.ts`](../../packages/daemon/src/types.ts)
  + [`packages/daemon/src/api/config.ts`](../../packages/daemon/src/api/config.ts)
  — server-side `GlobalConfig.pinnedSessionIds` + `ui.{themeId, chromeAutoHide, wallDensity}`.

## 11. Glossary

- **Band** — the narrow OKLCH Lightness range every Zen accent color must
  live in. Dark band = L=74±4. Light band = L=48±4.
- **Hue ring** — the 8-color project palette (Lavender → Iris → … → Rose).
- **Workspace** — a project, in Zen terminology. Each workspace owns one
  hue from the ring.
- **Workspace tint** — the soft `color-mix` of a workspace hue over the
  canvas, applied to surfaces that belong to that workspace.
- **Density** — the size/feature tier a `SessionPane` renders at.
  `comfortable` | `wall` | `card`.
- **Chrome on intent** — the rule that UI chrome (headers, status bars,
  scrollbars) sits dim and emerges only when the user moves intent toward
  it. Implemented via `.mt-auto-hide`.
- **The Wall** — the desktop homepage; the responsive grid of pinned
  SessionTiles.
- **The Feed** — the mobile counterpart of the Wall; vertical
  scroll list of read-only SessionFeedCards.
- **Focused pane** — the Wall tile that owns keyboard input. Click a tile
  to focus it. `focusedPaneId` in the store.
