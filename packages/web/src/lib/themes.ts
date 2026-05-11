export interface ThemeColors {
  bgPrimary: string;
  bgSidebar: string;
  bgStatusbar: string;
  bgElevated: string;
  bgOverlay: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  borderStrong: string;
  accentBlue: string;
  statusRunning: string;
  statusIdle: string;
  statusWarning: string;
  statusError: string;
  statusStopped: string;
  bgHover: string;
  selectionBorder: string;
}

export interface Theme {
  id: string;
  name: string;
  isDark: boolean;
  builtIn?: boolean;
  colors: ThemeColors;
}

export const THEME_COLOR_KEYS: Array<{
  key: keyof ThemeColors;
  label: string;
  cssVar: string;
}> = [
  { key: 'bgPrimary', label: 'Background', cssVar: '--bg-primary' },
  { key: 'bgSidebar', label: 'Sidebar background', cssVar: '--bg-sidebar' },
  { key: 'bgStatusbar', label: 'Status bar background', cssVar: '--bg-statusbar' },
  { key: 'bgElevated', label: 'Elevated surface', cssVar: '--bg-elevated' },
  { key: 'bgOverlay', label: 'Modal overlay', cssVar: '--bg-overlay' },
  { key: 'bgHover', label: 'Hover background', cssVar: '--bg-hover' },
  { key: 'textPrimary', label: 'Primary text', cssVar: '--text-primary' },
  { key: 'textSecondary', label: 'Secondary text', cssVar: '--text-secondary' },
  { key: 'textMuted', label: 'Muted text', cssVar: '--text-muted' },
  { key: 'border', label: 'Border', cssVar: '--border' },
  { key: 'borderStrong', label: 'Strong border', cssVar: '--border-strong' },
  { key: 'accentBlue', label: 'Accent', cssVar: '--accent-blue' },
  { key: 'selectionBorder', label: 'Selection border', cssVar: '--selection-border' },
  { key: 'statusRunning', label: 'Running', cssVar: '--status-running' },
  { key: 'statusIdle', label: 'Idle', cssVar: '--status-idle' },
  { key: 'statusWarning', label: 'Warning', cssVar: '--status-warning' },
  { key: 'statusError', label: 'Error', cssVar: '--status-error' },
  { key: 'statusStopped', label: 'Stopped', cssVar: '--status-stopped' },
];

// Obsidian — light fallback (warm cream).
export const BUILTIN_LIGHT: Theme = {
  id: 'builtin-light',
  name: 'Obsidian Light',
  isDark: false,
  builtIn: true,
  colors: {
    bgPrimary: '#f5f1e8',
    bgSidebar: '#ebe6d8',
    bgStatusbar: '#ebe6d8',
    bgElevated: '#fbf8ef',
    bgOverlay: 'rgba(40, 30, 18, 0.45)',
    bgHover: '#e0d9c5',
    textPrimary: '#1a1a14',
    textSecondary: '#4a4538',
    textMuted: '#7a7468',
    border: '#d8d2c0',
    borderStrong: '#bcb4a0',
    // accentBlue is the historical name; the value is amber. All 70+ usage
    // sites continue to resolve via the same CSS variable.
    accentBlue: '#ff8a00',
    selectionBorder: '#ff8a00',
    statusRunning: '#1f9d55',
    statusIdle: '#7a7468',
    statusWarning: '#c46a00',
    statusError: '#c92a2a',
    statusStopped: '#a8a397',
  },
};

// Obsidian — canonical dark.
export const BUILTIN_DARK: Theme = {
  id: 'builtin-dark',
  name: 'Obsidian',
  isDark: true,
  builtIn: true,
  colors: {
    bgPrimary: '#08080b',
    bgSidebar: '#0e0e12',
    bgStatusbar: '#0e0e12',
    bgElevated: '#16161c',
    bgOverlay: 'rgba(0, 0, 0, 0.7)',
    bgHover: '#1f1f27',
    textPrimary: '#e6e6ed',
    textSecondary: '#b8b8c4',
    textMuted: '#7a7a87',
    border: '#1a1a22',
    borderStrong: '#2a2a35',
    // accentBlue is the historical name; the value is amber.
    accentBlue: '#ff8a00',
    selectionBorder: '#ff8a00',
    statusRunning: '#2ecc71',
    statusIdle: '#7a7a87',
    statusWarning: '#ff8a00',
    statusError: '#ff4d4f',
    statusStopped: '#4a4a55',
  },
};

export const BUILTIN_THEMES: Theme[] = [BUILTIN_LIGHT, BUILTIN_DARK];

/**
 * Backfill missing keys on older custom themes loaded from localStorage so
 * legacy saves still render correctly after new tokens land. Missing keys
 * inherit from the appropriate built-in (dark or light).
 */
function withDefaults(colors: Partial<ThemeColors>, isDark: boolean): ThemeColors {
  const base = isDark ? BUILTIN_DARK.colors : BUILTIN_LIGHT.colors;
  return { ...base, ...colors } as ThemeColors;
}

export function applyThemeToDocument(theme: Theme) {
  const root = document.documentElement;
  const filled = withDefaults(theme.colors, theme.isDark);
  for (const { key, cssVar } of THEME_COLOR_KEYS) {
    root.style.setProperty(cssVar, filled[key]);
  }
  root.setAttribute('data-theme', theme.isDark ? 'dark' : 'light');
}

export function cloneTheme(base: Theme, name: string): Theme {
  return {
    id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    isDark: base.isDark,
    colors: { ...base.colors },
  };
}

export function loadCustomThemesFromStorage(): Theme[] {
  try {
    const raw = localStorage.getItem('mt:customThemes');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is Theme =>
          !!t &&
          typeof t.id === 'string' &&
          typeof t.name === 'string' &&
          typeof t.isDark === 'boolean' &&
          !!t.colors &&
          typeof t.colors === 'object'
      )
      .map((t) => ({ ...t, colors: withDefaults(t.colors, t.isDark) }));
  } catch {
    return [];
  }
}

export function saveCustomThemesToStorage(themes: Theme[]) {
  try {
    localStorage.setItem('mt:customThemes', JSON.stringify(themes));
  } catch {
    /* ignore */
  }
}

export function loadActiveThemeIdFromStorage(): string | null {
  try {
    return localStorage.getItem('mt:activeThemeId');
  } catch {
    return null;
  }
}

export function saveActiveThemeIdToStorage(id: string) {
  try {
    localStorage.setItem('mt:activeThemeId', id);
  } catch {
    /* ignore */
  }
}
