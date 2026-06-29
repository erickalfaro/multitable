# MultiTable surface map — which surface gets which glass

This is the prescriptive map for the redesign: for every UI surface, the glass
tier and the class to apply. **Tier 0 (solid) is a decision, not an absence** —
dense reading surfaces stay solid on purpose.

## The base layer (do this first)

Glass blurs whatever is *behind* it. For glass to read as glass (not a flat
tint), the canvas behind it must have texture. So:

- **`MainPane` / app canvas** wears the workspace-tinted wallpaper:
  `.mt-workspace-gradient` (already in globals.css), driven by `--workspace-from`
  / `--workspace-to` from `WorkspaceTint` / `getProjectColor`.
- Without this, every glass panel over a flat `--bg-primary` looks like a tinted
  box. This is the #1 "glass looks wrong" cause (see [`../pitfalls.md`](../pitfalls.md)).

## The map

| Surface (component / path) | Tier | Class | Notes |
|---|---|---|---|
| App canvas / `MainPane` background | 0 base | `.mt-workspace-gradient` | textured wallpaper so glass has something to blur |
| `Sidebar`, `PastAgentsList`, `SidebarFileViewerSection` | 1 | `.mt-glass-chrome` | composes with `.mt-auto-hide` |
| `SessionHeaderBar`, status / footer bars | 1 | `.mt-glass-chrome` | |
| **Pinned Session Wall tiles** (`wall/SessionTile`, `SessionFeedCard`, `WallRegion`) | **Showcase** | **`.mt-glass-wall`** | the marquee — sheen, rim, tilt; see [`../reference/the-wall.md`](../reference/the-wall.md) |
| `MessageList` transcript body, `AssistantMessage` / `UserMessage` prose | **0 solid** | — | **never frost reading text** |
| `CodeBlock`, xterm `TerminalView` | **0 solid** | — | **never frost code/terminal** |
| `ToolCallCard`, `ReasoningCard` | 1 (subtle, optional) | `.mt-glass-chrome` | only if it doesn't hurt readability; default solid |
| `ChatInputCM` / `ExpandedComposer` (floating composer) | 2 | `.mt-glass-float` | reuses `--shadow-composer` feel |
| Modals: `AddAgentModal`, `GlobalSettingsModal`, `AddProjectModal`, `PastAgentsBrowser` | 2 + 3 | `.mt-glass-float` panel over `.mt-glass-scrim` backdrop | |
| Command palette (`command-palette/`) | 2 | `.mt-glass-float` | |
| Context menus, dropdowns, tooltips, popovers | 2 | `.mt-glass-float` | smaller radius ok |
| Permission prompts (`permission/`), `ElicitationModal` | 2 | `.mt-glass-float` | **never** `.mt-auto-hide` |
| `NotificationCenter`, App detail drawer | 2 | `.mt-glass-float` | migrate the drawer's ad-hoc `.mt-glass` here |
| `ConnectionOverlay` | 3 | `.mt-glass-scrim` | migrate its ad-hoc `backdrop-filter` |

## Migration of existing ad-hoc glass

These already use raw `backdrop-filter` and should move to the tier classes:

- `App.tsx` detail drawer — `blur(6px) saturate(1.1)` + `.mt-glass` → `.mt-glass-float`.
- `ConnectionOverlay.tsx` — `blur(6px)` / `blur(8px) saturate(1.1)` → `.mt-glass-scrim`.
- `CommandConsole` — `blur(4px) saturate(1.05)` → `.mt-glass-chrome` or `.mt-glass-float` per role.

Keep `.mt-glass` defined for back-compat; new work uses the tiers.

## The readability rule (non-negotiable)

Tier 0 surfaces — **chat transcript text, code blocks, terminals** — never get
`backdrop-filter`. Glass behind moving/scrolling text both tanks performance and
hurts contrast. Frost the *container* (the sidebar, the header, the modal shell);
keep the *content* solid. If you want depth on a reading surface, use a solid
`--bg-elevated` + a shadow, not glass.

## Applying a class in this codebase

Components style chrome via inline `style={{ }}` with `var(--…)` and/or utility
classes in globals.css. To frost a surface:

```tsx
// add the class; keep existing layout/inline styles
<div className="mt-glass-float" style={{ /* layout only */ }}>…</div>
```

The class supplies background + `backdrop-filter` + border + shadow + radius.
Don't duplicate those in the inline style — let the class own the material so the
look stays consistent and themable.
