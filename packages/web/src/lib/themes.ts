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
  // accentBlue is the historical name for the single chromatic accent —
  // the value is lavender in Zen, amber in Obsidian. 70+ sites resolve via
  // the matching CSS variable `--accent-blue`; do not rename.
  accentBlue: string;
  statusRunning: string;
  statusIdle: string;
  statusWarning: string;
  statusError: string;
  statusStopped: string;
  bgHover: string;
  selectionBorder: string;
  // Per-alert-category tints for notification icons + sidebar badges.
  // Picked to sit at roughly the same perceived lightness as --text-secondary
  // so icons don't shout. See lib/alertVisuals.tsx for the icon mapping.
  catTurn: string;
  catTool: string;
  catPermission: string;
  catElicitation: string;
  catRateLimit: string;
  catAuth: string;
  catTask: string;
  catCompaction: string;
  catSync: string;
  catBudget: string;
  catStatus: string;
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
  { key: 'catTurn', label: 'Alert · turn', cssVar: '--cat-turn' },
  { key: 'catTool', label: 'Alert · tool', cssVar: '--cat-tool' },
  { key: 'catPermission', label: 'Alert · permission', cssVar: '--cat-permission' },
  { key: 'catElicitation', label: 'Alert · elicitation', cssVar: '--cat-elicitation' },
  { key: 'catRateLimit', label: 'Alert · rate limit', cssVar: '--cat-rate-limit' },
  { key: 'catAuth', label: 'Alert · auth', cssVar: '--cat-auth' },
  { key: 'catTask', label: 'Alert · task', cssVar: '--cat-task' },
  { key: 'catCompaction', label: 'Alert · compaction', cssVar: '--cat-compaction' },
  { key: 'catSync', label: 'Alert · sync', cssVar: '--cat-sync' },
  { key: 'catBudget', label: 'Alert · budget', cssVar: '--cat-budget' },
  { key: 'catStatus', label: 'Alert · status', cssVar: '--cat-status' },
];

// ─── Zen ──────────────────────────────────────────────────────────────
// All accent / status / category values are written in OKLCH with locked
// Lightness bands so every color is perceptually equivalent against the
// canvas. Dark band L=74±4 against bg L=20 → ΔL≈54 (well above APCA
// non-text decorative threshold). Light band L=48 against bg L=96 → ΔL≈48.
// Chroma 0.08–0.13 keeps everything in pastel territory. Hue varies only.
// See /home/erick/.claude/plans/i-want-to-reimagine-ticklish-wave.md §3.
export const BUILTIN_ZEN: Theme = {
  id: 'builtin-zen',
  name: 'Zen',
  isDark: true,
  builtIn: true,
  colors: {
    bgPrimary: 'oklch(20% 0.01 280)',
    bgSidebar: 'oklch(24% 0.01 280)',
    bgStatusbar: 'oklch(24% 0.01 280)',
    bgElevated: 'oklch(28% 0.012 280)',
    bgOverlay: 'oklch(12% 0.01 280 / 0.62)',
    bgHover: 'oklch(32% 0.014 280)',
    textPrimary: 'oklch(92% 0.005 280)',
    textSecondary: 'oklch(74% 0.01 280)',
    textMuted: 'oklch(55% 0.012 280)',
    border: 'oklch(100% 0 0 / 0.06)',
    borderStrong: 'oklch(100% 0 0 / 0.10)',
    // Accent = Lavender from the project hue ring.
    accentBlue: 'oklch(74% 0.10 285)',
    selectionBorder: 'oklch(74% 0.10 285)',
    statusRunning: 'oklch(76% 0.11 160)',
    statusIdle: 'oklch(60% 0.02 280)',
    statusWarning: 'oklch(78% 0.11 70)',
    statusError: 'oklch(70% 0.14 25)',
    // statusStopped intentionally drops below the L band — the only color
    // allowed to be quiet, because it signifies the absence of activity.
    statusStopped: 'oklch(45% 0.01 280)',
    // Category tints — all at the band, hue-spaced ≥25° apart from siblings.
    // Shifted 18° from the node hue wheel so they never collide in the same
    // UI region. Chroma 0.08 — slightly less saturated than projects so they
    // don't visually compete with workspace identity tints.
    catTurn: 'oklch(74% 0.08 298)',
    catTool: 'oklch(74% 0.08 268)',
    catPermission: 'oklch(74% 0.10 30)',
    catElicitation: 'oklch(74% 0.08 233)',
    catRateLimit: 'oklch(74% 0.10 350)',
    catAuth: 'oklch(74% 0.08 178)',
    catTask: 'oklch(74% 0.08 88)',
    catCompaction: 'oklch(74% 0.08 58)',
    catSync: 'oklch(74% 0.08 148)',
    catBudget: 'oklch(74% 0.10 12)',
    catStatus: 'oklch(74% 0.005 280)',
  },
};

export const BUILTIN_ZEN_LIGHT: Theme = {
  id: 'builtin-zen-light',
  name: 'Zen Light',
  isDark: false,
  builtIn: true,
  colors: {
    bgPrimary: 'oklch(96% 0.005 80)',
    bgSidebar: 'oklch(93% 0.005 80)',
    bgStatusbar: 'oklch(93% 0.005 80)',
    bgElevated: 'oklch(98% 0.004 80)',
    bgOverlay: 'oklch(18% 0.01 280 / 0.45)',
    bgHover: 'oklch(89% 0.006 80)',
    textPrimary: 'oklch(18% 0.01 280)',
    textSecondary: 'oklch(38% 0.012 280)',
    textMuted: 'oklch(55% 0.012 280)',
    border: 'oklch(20% 0.01 280 / 0.06)',
    borderStrong: 'oklch(20% 0.01 280 / 0.10)',
    accentBlue: 'oklch(48% 0.13 285)',
    selectionBorder: 'oklch(48% 0.13 285)',
    statusRunning: 'oklch(50% 0.14 160)',
    statusIdle: 'oklch(55% 0.02 280)',
    statusWarning: 'oklch(55% 0.14 60)',
    statusError: 'oklch(52% 0.18 25)',
    statusStopped: 'oklch(72% 0.01 280)',
    catTurn: 'oklch(48% 0.11 298)',
    catTool: 'oklch(48% 0.11 268)',
    catPermission: 'oklch(48% 0.13 30)',
    catElicitation: 'oklch(48% 0.11 233)',
    catRateLimit: 'oklch(48% 0.13 350)',
    catAuth: 'oklch(48% 0.11 178)',
    catTask: 'oklch(48% 0.11 88)',
    catCompaction: 'oklch(48% 0.11 58)',
    catSync: 'oklch(48% 0.11 148)',
    catBudget: 'oklch(48% 0.13 12)',
    catStatus: 'oklch(48% 0.008 280)',
  },
};

// ─── Obsidian (legacy) ────────────────────────────────────────────────
// Kept as opt-in themes for users who prefer the older high-contrast feel.
// Not loaded as default; see resolveDefaultThemeId().
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
    accentBlue: '#ff8a00',
    selectionBorder: '#ff8a00',
    statusRunning: '#1f9d55',
    statusIdle: '#7a7468',
    statusWarning: '#c46a00',
    statusError: '#c92a2a',
    statusStopped: '#a8a397',
    catTurn: '#5b6470',
    catTool: '#7a5a2a',
    catPermission: '#8a4a1f',
    catElicitation: '#4a6a8a',
    catRateLimit: '#7a5a8a',
    catAuth: '#2a6a7a',
    catTask: '#2f7a4a',
    catCompaction: '#6a5a4a',
    catSync: '#4a7a7a',
    catBudget: '#7a2a4a',
    catStatus: '#5a5a5a',
  },
};

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
    accentBlue: '#ff8a00',
    selectionBorder: '#ff8a00',
    statusRunning: '#2ecc71',
    statusIdle: '#7a7a87',
    statusWarning: '#ff8a00',
    statusError: '#ff4d4f',
    statusStopped: '#4a4a55',
    catTurn: '#9aa3b2',
    catTool: '#c2a371',
    catPermission: '#e08a4a',
    catElicitation: '#7eb0e6',
    catRateLimit: '#b89ad0',
    catAuth: '#5fb3c5',
    catTask: '#5ec88a',
    catCompaction: '#a89888',
    catSync: '#6fb5b5',
    catBudget: '#d06088',
    catStatus: '#909090',
  },
};

// Order matters: BUILTIN_ZEN first so it appears as the natural default in
// theme pickers, with the Obsidian legacy themes available as opt-in.
export const BUILTIN_THEMES: Theme[] = [BUILTIN_ZEN, BUILTIN_ZEN_LIGHT, BUILTIN_DARK, BUILTIN_LIGHT];

export const DEFAULT_THEME_ID = 'builtin-zen';

/**
 * Backfill missing keys on older custom themes loaded from localStorage so
 * legacy saves still render correctly after new tokens land. Missing keys
 * inherit from the matching Zen built-in (dark or light).
 */
function withDefaults(colors: Partial<ThemeColors>, isDark: boolean): ThemeColors {
  const base = isDark ? BUILTIN_ZEN.colors : BUILTIN_ZEN_LIGHT.colors;
  return { ...base, ...colors } as ThemeColors;
}

export function applyThemeToDocument(theme: Theme) {
  const root = document.documentElement;
  const filled = withDefaults(theme.colors, theme.isDark);
  for (const { key, cssVar } of THEME_COLOR_KEYS) {
    root.style.setProperty(cssVar, filled[key]);
  }
  // Mirror `--accent-blue` onto `--accent-amber` so legacy references that
  // hard-code amber continue to resolve to the active theme's accent.
  root.style.setProperty('--accent-amber', filled.accentBlue);
  root.style.setProperty('--accent-amber-dim', filled.accentBlue);
  // Single accent alias used by Zen-era code.
  root.style.setProperty('--accent', filled.accentBlue);
  root.setAttribute('data-theme', theme.isDark ? 'dark' : 'light');
  if (import.meta.env?.DEV) {
    assertBandDiscipline(theme);
  }
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

/**
 * Dev-only guardrail: warn if a built-in Zen theme's color value falls
 * outside its expected OKLCH lightness band. Catches accidental edits that
 * would reintroduce the "pairings that don't make sense" bug.
 *
 * Only applies to BUILTIN_ZEN / BUILTIN_ZEN_LIGHT — Obsidian themes and
 * user customs are exempt.
 */
function assertBandDiscipline(theme: Theme) {
  if (theme.id !== BUILTIN_ZEN.id && theme.id !== BUILTIN_ZEN_LIGHT.id) return;
  const expectedAccentL = theme.isDark ? 74 : 48;
  // Status, accent, and category tokens (excluding statusStopped which is
  // intentionally below the band, and statusIdle which is intentionally muted).
  const bandKeys: Array<keyof ThemeColors> = [
    'accentBlue',
    'statusRunning',
    'statusWarning',
    'statusError',
    'catTurn',
    'catTool',
    'catPermission',
    'catElicitation',
    'catRateLimit',
    'catAuth',
    'catTask',
    'catCompaction',
    'catSync',
    'catBudget',
  ];
  for (const key of bandKeys) {
    const value = theme.colors[key];
    const match = /oklch\(\s*([\d.]+)%/.exec(value);
    if (!match) {
      // eslint-disable-next-line no-console
      console.warn(`[zen-theme] ${theme.id}.${key} is not OKLCH: ${value}`);
      continue;
    }
    const L = parseFloat(match[1]);
    if (Math.abs(L - expectedAccentL) > 6) {
      // eslint-disable-next-line no-console
      console.warn(
        `[zen-theme] ${theme.id}.${key} L=${L}% is outside band (expected ${expectedAccentL}±6). ` +
          `This is the "invisible color" trap — see plan §3.`
      );
    }
  }
}
