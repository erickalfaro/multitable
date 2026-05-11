import React, { useEffect, useState } from 'react';
import { Bell, BellOff, AlertTriangle } from 'lucide-react';
import {
  loadPrefs,
  savePrefs,
  subscribePrefs,
  type NotificationPrefs,
} from '../../lib/notificationPrefs';
import {
  fireTestNotification,
  getPermissionState,
  requestPermission,
  subscribePermissionState,
  type NotificationPermissionState,
} from '../../lib/browserNotifications';
import type { AlertCategory, AlertSeverity } from '../../lib/types';
import { Button } from '../ui';
import toast from 'react-hot-toast';

const SEVERITIES: AlertSeverity[] = ['info', 'success', 'warning', 'error', 'attention'];

const CATEGORIES: { id: AlertCategory; label: string }[] = [
  { id: 'turn', label: 'Turn' },
  { id: 'tool', label: 'Tool' },
  { id: 'permission', label: 'Permission' },
  { id: 'elicitation', label: 'Elicitation' },
  { id: 'rate-limit', label: 'Rate limit' },
  { id: 'auth', label: 'Auth' },
  { id: 'task', label: 'Task' },
  { id: 'compaction', label: 'Compaction' },
  { id: 'sync', label: 'Sync' },
  { id: 'budget', label: 'Budget' },
  { id: 'status', label: 'Status' },
];

function detectOs(): 'mac' | 'windows' | 'linux' | 'other' {
  if (typeof navigator === 'undefined') return 'other';
  const platform = (navigator.platform || '').toLowerCase();
  const ua = (navigator.userAgent || '').toLowerCase();
  if (platform.startsWith('mac') || ua.includes('mac os x')) return 'mac';
  if (platform.startsWith('win') || ua.includes('windows')) return 'windows';
  if (platform.includes('linux') || ua.includes('linux')) return 'linux';
  return 'other';
}

function PermissionHint({ state }: { state: NotificationPermissionState }) {
  const os = detectOs();
  if (state === 'unsupported') {
    return (
      <div style={hintStyle('warning')}>
        <AlertTriangle size={12} />
        Your browser does not support OS-level notifications.
      </div>
    );
  }
  if (state === 'denied') {
    let osHint = '';
    if (os === 'mac') osHint = 'Open System Settings → Notifications → Browser, and allow notifications.';
    else if (os === 'windows') osHint = 'Open Settings → System → Notifications & actions, and enable for your browser.';
    else if (os === 'linux') osHint = 'Make sure your notification daemon (dunst, mako, GNOME Shell, KDE Plasma, etc.) is running, then re-allow site notifications in your browser.';
    else osHint = 'Re-allow notifications for this site in your browser settings.';
    return (
      <div style={hintStyle('warning')}>
        <AlertTriangle size={12} />
        Notifications were denied. {osHint}
      </div>
    );
  }
  return null;
}

function hintStyle(kind: 'warning' | 'info'): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 6,
    fontSize: 11.5,
    color: kind === 'warning' ? 'var(--status-stopped)' : 'var(--text-muted)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    padding: '6px 8px',
    marginTop: 6,
    lineHeight: 1.45,
  };
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--text-secondary)',
  marginBottom: 6,
};

const checkboxRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12.5,
  color: 'var(--text-primary)',
  cursor: 'pointer',
  padding: '3px 6px',
  borderRadius: 'var(--radius-sm)',
};

export function NotificationsSection() {
  const [prefs, setPrefs] = useState<NotificationPrefs>(loadPrefs());
  const [permissionState, setPermissionState] = useState<NotificationPermissionState>(getPermissionState());

  useEffect(() => {
    const a = subscribePrefs(setPrefs);
    const b = subscribePermissionState(setPermissionState);
    return () => {
      a();
      b();
    };
  }, []);

  function update(patch: Partial<NotificationPrefs>): void {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(next);
  }

  function updateSounds(patch: Partial<NotificationPrefs['sounds']>): void {
    update({ sounds: { ...prefs.sounds, ...patch } });
  }

  function updateOs(patch: Partial<NotificationPrefs['os']>): void {
    update({ os: { ...prefs.os, ...patch } });
  }

  function toggleSeverityMute(s: AlertSeverity): void {
    const muted = prefs.sounds.mutedSeverities.includes(s)
      ? prefs.sounds.mutedSeverities.filter((x) => x !== s)
      : [...prefs.sounds.mutedSeverities, s];
    updateSounds({ mutedSeverities: muted });
  }

  function toggleCategoryMute(c: AlertCategory): void {
    const muted = prefs.mutedCategories.includes(c)
      ? prefs.mutedCategories.filter((x) => x !== c)
      : [...prefs.mutedCategories, c];
    update({ mutedCategories: muted });
  }

  async function handleEnableOs(): Promise<void> {
    const result = await requestPermission();
    if (result === 'granted') {
      updateOs({ enabled: true });
      toast.success('OS notifications enabled');
    } else if (result === 'denied') {
      updateOs({ enabled: false });
      toast.error('OS notifications blocked by browser');
    } else if (result === 'unsupported') {
      toast.error('Browser does not support notifications');
    }
  }

  function handleTest(): void {
    if (permissionState !== 'granted' || !prefs.os.enabled) {
      toast.error('Enable OS notifications first');
      return;
    }
    const ok = fireTestNotification();
    if (!ok) toast.error('Could not show test notification — check OS settings');
  }

  return (
    <div>
      <label style={{ ...checkboxRow, marginBottom: 10 }}>
        <input
          type="checkbox"
          checked={prefs.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        <Bell size={13} />
        Master toggle — enable in-app notifications, sounds, and OS notifications
      </label>

      <div style={{ opacity: prefs.enabled ? 1 : 0.5, pointerEvents: prefs.enabled ? 'auto' : 'none' }}>
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Sounds</label>
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={prefs.sounds.enabled}
              onChange={(e) => updateSounds({ enabled: e.target.checked })}
            />
            Play chimes
          </label>
          <div
            style={{
              display: 'flex',
              gap: 4,
              marginTop: 6,
              marginLeft: 18,
              flexWrap: 'wrap',
              opacity: prefs.sounds.enabled ? 1 : 0.5,
              pointerEvents: prefs.sounds.enabled ? 'auto' : 'none',
            }}
          >
            {SEVERITIES.map((s) => (
              <label key={s} style={checkboxRow}>
                <input
                  type="checkbox"
                  checked={!prefs.sounds.mutedSeverities.includes(s)}
                  onChange={() => toggleSeverityMute(s)}
                />
                {s}
              </label>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>OS notifications</label>
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={prefs.os.enabled}
              disabled={permissionState !== 'granted'}
              onChange={(e) => updateOs({ enabled: e.target.checked })}
            />
            {prefs.os.enabled ? <Bell size={13} /> : <BellOff size={13} />}
            Show OS notifications
          </label>
          <label style={{ ...checkboxRow, marginLeft: 18 }}>
            <input
              type="checkbox"
              checked={prefs.os.onlyWhenUnfocused}
              onChange={(e) => updateOs({ onlyWhenUnfocused: e.target.checked })}
            />
            Only when the window is not focused
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {permissionState !== 'granted' && (
              <Button size="sm" variant="secondary" onClick={handleEnableOs}>
                Allow OS notifications
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={handleTest}>
              Send test notification
            </Button>
          </div>
          <PermissionHint state={permissionState} />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Categories shown</label>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {CATEGORIES.map((c) => (
              <label key={c.id} style={checkboxRow}>
                <input
                  type="checkbox"
                  checked={!prefs.mutedCategories.includes(c.id)}
                  onChange={() => toggleCategoryMute(c.id)}
                />
                {c.label}
              </label>
            ))}
          </div>
        </div>

        <div>
          <label style={checkboxRow}>
            <input
              type="checkbox"
              checked={prefs.showCenterBadge}
              onChange={(e) => update({ showCenterBadge: e.target.checked })}
            />
            Show unread badge in tab title and status bar
          </label>
        </div>
      </div>
    </div>
  );
}
