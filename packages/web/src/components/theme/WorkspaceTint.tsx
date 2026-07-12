import React, { useMemo } from 'react';
import { useAppStore } from '../../stores/appStore';
import { getProjectColor } from '../../lib/projectColor';

interface Props {
  projectId: string | null | undefined;
  /** Render a gradient (135deg, from→to) instead of a flat tint. */
  gradient?: boolean;
  /**
   * Tint strength/base: 'tinted' (7% over --bg-elevated, default),
   * 'gradient' (same as the boolean prop), or 'washed' — a barely-there 4%
   * wash over --bg-primary for large surfaces (chat scroll area, sidebar
   * column). Takes precedence over `gradient` when set.
   */
  variant?: 'tinted' | 'gradient' | 'washed';
  /** Container tag — defaults to <div>. */
  as?: keyof React.JSX.IntrinsicElements;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/**
 * Resolves the project's band-anchored hue and exposes it on the subtree
 * as `--workspace-from` / `--workspace-to` CSS variables. Pair with one of:
 *
 *   - `.mt-workspace-tinted` — flat 7% color-mix wash over `--bg-elevated`.
 *   - `.mt-workspace-gradient` — diagonal gradient, two stops same-hue.
 *
 * Or read the variables directly in inline styles for finer control.
 *
 * Plan §3.4 — workspace tints composite via `color-mix(in oklch)` so the
 * landing lightness is predictable across themes. The component itself
 * doesn't apply the tint background — that's the caller's job via class.
 * This separation lets the same tint subtree wrap a card AND a header
 * without double-applying.
 */
export function WorkspaceTint({
  projectId,
  gradient,
  variant,
  as,
  className,
  style,
  children,
}: Props) {
  const isDark = useAppStore((s) => {
    const themeId = s.activeThemeId;
    const all = [...s.customThemes];
    const t = all.find((x) => x.id === themeId);
    if (t) return t.isDark;
    // Default to dark when the theme isn't a custom (it's a built-in — Zen
    // dark is the default). Lookup of built-ins by id would require importing
    // themes.ts which is more entanglement than this hot path warrants.
    return !themeId.endsWith('-light');
  });
  // Manual hue override for this project — subscribing to the scalar keeps
  // the tint live when the user picks a new color from the rail.
  const overrideName = useAppStore((s) =>
    projectId ? s.projectNav.colors?.[projectId] ?? null : null,
  );

  const vars = useMemo<React.CSSProperties | null>(() => {
    if (!projectId) return null;
    // overrideName participates via the module-level override map inside
    // getProjectColor; referencing it keeps the memo (and the lint) honest.
    void overrideName;
    const color = getProjectColor(projectId, isDark);
    return {
      ['--workspace-from' as any]: color.from,
      ['--workspace-to' as any]: color.to,
    };
  }, [projectId, isDark, overrideName]);

  const resolvedVariant = variant ?? (gradient ? 'gradient' : 'tinted');
  const Tag = (as ?? 'div') as React.ElementType;
  const composedClass = [
    className,
    projectId ? `mt-workspace-${resolvedVariant}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Tag className={composedClass || undefined} style={{ ...vars, ...style }}>
      {children}
    </Tag>
  );
}
