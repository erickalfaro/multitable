import { toast } from 'react-hot-toast';
import type { SessionAlert, AlertSeverity } from './types';
import { useAppStore } from '../stores/appStore';
import {
  playAttentionChime,
  playDoneChime,
  playErrorChime,
  playPermissionChime,
  playWarningChime,
} from './sound';
import { showOsNotificationIfHidden } from './browserNotifications';
import { isCategoryMuted, isSeverityChimeMuted, loadPrefs } from './notificationPrefs';

const TOAST_STYLE_BY_SEVERITY: Record<AlertSeverity, Record<string, string>> = {
  info: { borderLeft: '3px solid var(--text-secondary)' },
  success: { borderLeft: '3px solid var(--status-running)' },
  warning: { borderLeft: '3px solid var(--status-stopped)' },
  error: { borderLeft: '3px solid var(--status-error)' },
  attention: { borderLeft: '3px solid var(--accent)' },
};

function chimeFor(severity: AlertSeverity): (() => void) | null {
  switch (severity) {
    case 'success':
      return playDoneChime;
    case 'warning':
      return playWarningChime;
    case 'error':
      return playErrorChime;
    case 'attention':
      return playAttentionChime;
    case 'info':
      return null;
  }
}

function sessionLabel(sessionId: string): string {
  const session = useAppStore.getState().sessions[sessionId];
  return session?.name ?? 'Agent';
}

/**
 * Single dispatch for any inbound SessionAlert. Routes by severity to:
 *   - in-app toast (always, unless OS notif fires for the same alert)
 *   - chime (severity-driven)
 *   - history store (persistent + per-session unread)
 *   - OS notification (Phase 9, only when document.hidden)
 *
 * Frontend preferences (sound mute, OS opt-in, per-category mute) gate each
 * stage in Phase 10. Phase 7 wires the dispatch and uses sensible defaults.
 */
export function handleSessionAlert(alert: SessionAlert): void {
  const store = useAppStore.getState();
  // History entry — always recorded, regardless of mute. Mute affects only
  // active surfaces (toast/sound/OS notif), not the audit trail.
  store.addAlert(alert);

  const prefs = loadPrefs();
  if (!prefs.enabled) return;
  if (isCategoryMuted(alert.category)) return;

  const label = sessionLabel(alert.sessionId);
  const headline = `${label}: ${alert.title}`;
  const body = alert.body;

  const osFired = showOsNotificationIfHidden({
    title: headline,
    body,
    severity: alert.severity,
    alertId: alert.alertId,
    sessionId: alert.sessionId,
  });

  if (!osFired) {
    const message = body ? `${headline}\n${body}` : headline;
    const opts = {
      duration: alert.ttlMs ?? (alert.severity === 'attention' ? Infinity : undefined),
      style: { ...TOAST_STYLE_BY_SEVERITY[alert.severity], maxWidth: 480 },
    };
    if (alert.severity === 'error') toast.error(message, opts);
    else if (alert.severity === 'success') toast.success(message, opts);
    else toast(message, opts);
  }

  // Special-case the permission category: the existing PermissionBar renders
  // the card and plays its own chime; don't double up.
  if (alert.category === 'permission') return;
  if (isSeverityChimeMuted(alert.severity)) return;

  const chime = chimeFor(alert.severity);
  if (chime) chime();
}

/**
 * Used by App.tsx for the legacy permission:prompt handler — exported so the
 * permission flow keeps using the dedicated chime even though it doesn't
 * route through handleSessionAlert.
 */
export { playPermissionChime };
