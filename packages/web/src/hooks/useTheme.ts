import { useEffect, useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { terminalManager } from '../lib/terminalManager';
import { BUILTIN_THEMES, BUILTIN_DARK, applyThemeToDocument } from '../lib/themes';
import { useIsDark } from './useIsDark';
import { getProjectColor } from '../lib/projectColor';

export function useTheme() {
  const activeThemeId = useAppStore((s) => s.activeThemeId);
  const customThemes = useAppStore((s) => s.customThemes);

  const activeTheme = useMemo(() => {
    const all = [...BUILTIN_THEMES, ...customThemes];
    return all.find((t) => t.id === activeThemeId) ?? BUILTIN_DARK;
  }, [activeThemeId, customThemes]);

  useEffect(() => {
    applyThemeToDocument(activeTheme);
    terminalManager.updateThemeColors({
      background: activeTheme.colors.bgPrimary,
      foreground: activeTheme.colors.textPrimary,
      cursor: activeTheme.colors.textPrimary,
    });
  }, [activeTheme]);
}

/**
 * Binds the ambient backdrop bloom (`--space-accent`) to the active project's
 * hue from the 8-hue ring (glass-design §3a). The bloom, the second bloom, and
 * the shell edge-glow are all `color-mix(... var(--space-accent) ...)`, so this
 * single property write re-tints the whole ambient layer; `.mt-ambient`'s
 * transition cross-fades the hue on project switch. Falls back to the CSS
 * default (lavender) when no project is in scope.
 */
export function useAmbientAccent() {
  const dark = useIsDark();
  const projectId = useAppStore((s) => {
    const sel = s.selectedProcessId;
    const fromSession = sel ? s.sessions[sel]?.projectId : undefined;
    return fromSession ?? s.sidebarProjectId ?? s.focusedProjectId ?? null;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (projectId) {
      root.style.setProperty('--space-accent', getProjectColor(projectId, dark).stripe);
    } else {
      root.style.removeProperty('--space-accent');
    }
  }, [projectId, dark]);
}
