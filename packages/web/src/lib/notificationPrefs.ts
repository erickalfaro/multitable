import type { AlertCategory, AlertSeverity } from './types';

const STORAGE_KEY = 'mt:notificationPrefs';

export interface NotificationPrefs {
  enabled: boolean;
  sounds: {
    enabled: boolean;
    mutedSeverities: AlertSeverity[];
  };
  os: {
    enabled: boolean;
    onlyWhenUnfocused: boolean;
  };
  mutedCategories: AlertCategory[];
  showCenterBadge: boolean;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  sounds: {
    enabled: true,
    mutedSeverities: [],
  },
  os: {
    enabled: false,
    onlyWhenUnfocused: true,
  },
  mutedCategories: [],
  showCenterBadge: true,
};

let cached: NotificationPrefs | null = null;
const listeners = new Set<(p: NotificationPrefs) => void>();

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export function loadPrefs(): NotificationPrefs {
  if (cached) return cached;
  if (typeof localStorage === 'undefined') {
    cached = deepClone(DEFAULT_PREFS);
    return cached;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      cached = mergeWithDefaults(parsed);
      return cached;
    }
  } catch {
    /* corrupt — fall through */
  }
  cached = deepClone(DEFAULT_PREFS);
  return cached;
}

function mergeWithDefaults(parsed: unknown): NotificationPrefs {
  const base = deepClone(DEFAULT_PREFS);
  if (!parsed || typeof parsed !== 'object') return base;
  const p = parsed as Record<string, any>;
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
    sounds: {
      enabled: typeof p.sounds?.enabled === 'boolean' ? p.sounds.enabled : base.sounds.enabled,
      mutedSeverities: Array.isArray(p.sounds?.mutedSeverities)
        ? p.sounds.mutedSeverities.filter((s: unknown): s is AlertSeverity =>
            s === 'info' || s === 'success' || s === 'warning' || s === 'error' || s === 'attention',
          )
        : base.sounds.mutedSeverities,
    },
    os: {
      enabled: typeof p.os?.enabled === 'boolean' ? p.os.enabled : base.os.enabled,
      onlyWhenUnfocused:
        typeof p.os?.onlyWhenUnfocused === 'boolean' ? p.os.onlyWhenUnfocused : base.os.onlyWhenUnfocused,
    },
    mutedCategories: Array.isArray(p.mutedCategories)
      ? p.mutedCategories.filter((c: unknown): c is AlertCategory => typeof c === 'string')
      : base.mutedCategories,
    showCenterBadge:
      typeof p.showCenterBadge === 'boolean' ? p.showCenterBadge : base.showCenterBadge,
  };
}

export function savePrefs(prefs: NotificationPrefs): void {
  cached = prefs;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    }
  } catch {
    /* ignore quota errors */
  }
  for (const l of listeners) {
    try { l(prefs); } catch { /* ignore */ }
  }
}

export function subscribePrefs(listener: (p: NotificationPrefs) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isCategoryMuted(category: AlertCategory): boolean {
  return loadPrefs().mutedCategories.includes(category);
}

export function isSeverityChimeMuted(severity: AlertSeverity): boolean {
  const prefs = loadPrefs();
  if (!prefs.sounds.enabled) return true;
  return prefs.sounds.mutedSeverities.includes(severity);
}
