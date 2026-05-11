import type { AlertSeverity } from './types';
import { loadPrefs } from './notificationPrefs';

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

interface ShowOptions {
  title: string;
  body?: string;
  severity: AlertSeverity;
  alertId: string;
  sessionId: string;
}

// Listeners notified when the permission state changes (settings UI subscribes
// to live-update its toggle/hint).
type Listener = (state: NotificationPermissionState) => void;
const listeners = new Set<Listener>();

function isSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getPermissionState(): NotificationPermissionState {
  if (!isSupported()) return 'unsupported';
  return Notification.permission as NotificationPermissionState;
}

export function subscribePermissionState(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  const state = getPermissionState();
  for (const l of listeners) {
    try { l(state); } catch { /* ignore */ }
  }
}

export async function requestPermission(): Promise<NotificationPermissionState> {
  if (!isSupported()) return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    emit();
    return Notification.permission as NotificationPermissionState;
  }
  try {
    const result = await Notification.requestPermission();
    emit();
    return result as NotificationPermissionState;
  } catch {
    return 'denied';
  }
}

// In Phase 9 / Phase 10 this consults user prefs. Phase 7 keeps it conservative:
// only fire OS notifs when (a) supported, (b) permission granted, (c) the tab
// is hidden, (d) severity warrants it. When OS notif fires, the caller should
// suppress its in-app toast to avoid double-up.
export function showOsNotificationIfHidden(opts: ShowOptions): boolean {
  if (!isSupported()) return false;
  if (Notification.permission !== 'granted') return false;
  const prefs = loadPrefs();
  if (!prefs.os.enabled) return false;
  if (prefs.os.onlyWhenUnfocused && (typeof document === 'undefined' || !document.hidden)) return false;
  // Only severities that reflect "the user actually needs to look".
  if (opts.severity === 'info' || opts.severity === 'success') return false;
  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.alertId,
      requireInteraction: opts.severity === 'attention' || opts.severity === 'error',
    });
    n.onclick = () => {
      try { window.focus(); } catch { /* ignore */ }
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

// Manually trigger a test notification — used by GlobalSettingsModal's
// "Send test notification" button so users can verify cross-OS plumbing.
export function fireTestNotification(): boolean {
  if (!isSupported()) return false;
  if (Notification.permission !== 'granted') return false;
  try {
    const n = new Notification('MultiTable test notification', {
      body: 'If you see this, OS notifications are working on your machine.',
      tag: 'mt-test',
    });
    n.onclick = () => { try { window.focus(); } catch { /* ignore */ } n.close(); };
    return true;
  } catch {
    return false;
  }
}
