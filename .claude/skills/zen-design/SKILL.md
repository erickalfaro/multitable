---
name: zen-design
description: Authoritative reference for MultiTable's Zen frontend design language — the calm-by-default visual rebuild done June 2026. Trigger when the user mentions Zen, the Zen redesign, OKLCH band discipline, the project hue ring, workspace tint, chrome-on-intent / .mt-auto-hide, the Pinned Session Wall, SessionPane density modes (comfortable / wall / card), SessionWall, SessionTile, PinnedFeed, SessionFeedCard, WorkspaceTint, the .mt-workspace-tinted / .mt-workspace-gradient utilities, or modifying anything under packages/web/src/lib/themes.ts, packages/web/src/lib/projectColor.ts, packages/web/src/styles/globals.css, packages/web/src/components/main-pane/wall/, packages/web/src/components/theme/, packages/web/src/components/main-pane/chat/SessionPane.tsx, the SessionHeaderBar / StatusBar auto-hide behavior, or the dotmatrix loader defaults.
allowed-tools: Bash, Read, Edit, Write, Grep
---

# Zen Design

The frontend was rebuilt in June 2026 around Zen Browser's calm-by-default
philosophy. **The canonical reference is
[docs/reference/ZEN_DESIGN.md](../../../docs/reference/ZEN_DESIGN.md) —
read it before changing anything color, density, or chrome-related.**

This skill is the pointer. It gives you the load-bearing one-liners; the
doc has the depth.

## The eight principles (from §2)

1. **Chrome reveals on intent, not by default.** `.mt-auto-hide`.
2. **One color identifies one workspace.** 8-hue project ring.
3. **Density is a prop, not a fork.** `SessionPaneDensity`.
4. **Motion is slowed and intentional.** 120/200/320 ms.
5. **Whitespace is structural.** Padding doubled from Obsidian.
6. **Surfaces are soft.** Radii 4/10/14, gentle shadows.
7. **The Wall is the homepage.** Default-on, replaces DashboardView.
8. **Every color is engineered, not picked.** OKLCH band discipline.

## The single rule that catches the most bugs

**Every accent / project / status / category color lives in a narrow OKLCH
Lightness band.** Dark band = L=74±4, C=0.08–0.13. Light band = L=48±4,
C=0.10–0.14. Equal L across hues = equal perceived brightness. Pre-Zen,
using raw hex meant pairings could disagree (one color shouts, the other
vanishes). Now they can't.

`lib/themes.ts`'s `assertBandDiscipline()` warns at boot in dev if a
built-in Zen token strays. **If you add a new accent token to the
`bandKeys` allowlist in that function, you've opted in to the check.**

## Task → file map

| Task                                              | File(s)                                                                              |
|---------------------------------------------------|--------------------------------------------------------------------------------------|
| Add / tweak a theme color                         | `packages/web/src/lib/themes.ts` (+ band assertion if it's an accent)                |
| Add / tweak a global CSS token (radius, motion)   | `packages/web/src/styles/globals.css` `:root` block                                  |
| Add a project hue                                 | `packages/web/src/lib/projectColor.ts` — extend `RING` (read §3.3 first)             |
| Add a workspace-tinted surface                    | Use `.mt-workspace-tinted` + inline `--workspace-from/to` vars, or `<WorkspaceTint>` |
| Build a new session view (full / mini / preview)  | `<SessionPane density="...">` — never fork SessionChat                               |
| Add a density mode                                | **Don't.** Three is the minimum. If you must, read §6 first                          |
| Add an auto-hide chrome surface                   | Apply `.mt-auto-hide` class; opt out on mobile via `@media (hover: none)` rule       |
| Add a Wall keyboard shortcut                      | `App.tsx`'s `onKeyDown` effect — preserve the `selectedProcessId` guard for digits   |
| Add a pin entry point                             | Call `togglePinSession(id)`; persists to store + localStorage + GlobalConfig         |
| Touch the dotmatrix loaders                       | `dotmatrix-core.tsx` defaults are intentional (size 16, speed 0.65); don't reset     |

## What ports to mobile (from §8)

| Concept                | Mobile behavior                                  |
|------------------------|--------------------------------------------------|
| OKLCH colors           | Works (iOS Safari 15.4+, Android Chrome)         |
| Tokens (radii, motion) | Ports as-is; prose font bumps to 14px ≤640px     |
| Workspace tint         | Ports                                            |
| `SessionPane` density  | `card` density is mobile-only (read-only feed)   |
| The Wall               | Becomes the `PinnedFeed` (vertical list)         |
| `.mt-auto-hide`        | Auto-disabled via `@media (hover: none)`         |
| Composer on Wall card  | **Dropped** — read-only; tap to drill in         |
| Cmd+P / Cmd+1..9       | Dropped — no keyboard                            |
| Side-by-side / split   | Dropped — physically impossible                  |

## Anti-patterns to refuse

- Picking a new accent color from a hex picker. **Always derive in OKLCH
  inside the band.** If a designer hands you a hex, convert it
  (https://oklch.com or `culori`) and check the L falls in [70, 78] dark
  or [44, 52] light. If not, push back.
- Adding `font-family: ...mono...` to a UI element that should read as
  prose. Body inherits `--font-prose` (Inter); code / terminal / composer
  opt back into `--font-mono` via class or element selector. Don't fork.
- Bringing back the old DashboardView as the no-selection homepage. The
  Wall is the homepage now; if DashboardView still has value, render it
  as a sub-surface or an overlay, not as the default.
- Hardcoding `getProjectColor(id, false)` to force the light-band variant.
  That was the bug that made loaders invisible on the Zen canvas. Always
  derive `isDark` from theme state (see §5.3).
- Adding a `.mt-auto-hide` to a permission prompt, modal, error banner,
  or anything safety-critical. The user must see those without provoking
  them.

## When NOT to use this skill

Skip when the work is purely backend (daemon adapters, transcripts, REST
handlers other than `/api/config`), purely about a provider's wire
shape, or pre-Zen frontend code that hasn't been migrated yet (xterm
terminal view, file viewer, etc.). The Zen rules apply to UI surfaces
that have been touched by the redesign; they're not retroactive law for
every legacy file.
