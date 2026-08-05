import React from 'react';
import { useAppStore } from '../../stores/appStore';
import { Settings, Bell, Bug } from 'lucide-react';
import { IconButton } from '../ui';

export function StatusBar() {
  // Narrow selectors — destructuring a selector-less useAppStore() subscribes
  // to every store write, re-rendering this always-mounted bar per WS event.
  const setGlobalSettingsOpen = useAppStore((s) => s.setGlobalSettingsOpen);
  const setNotificationCenterOpen = useAppStore((s) => s.setNotificationCenterOpen);
  const devLogOpen = useAppStore((s) => s.devLogOpen);
  const setDevLogOpen = useAppStore((s) => s.setDevLogOpen);
  const totalUnread = useAppStore((s) =>
    Object.values(s.unreadBySession).reduce((n, v) => n + v, 0),
  );
  const totalAlerts = useAppStore((s) => s.alerts.length);

  return (
    <div
      className="mt-auto-hide"
      // Zen: rests at low opacity, full on hover. Notification badge stays
      // legible enough at 0.45 that the user can still register count-state
      // without needing to look directly at the bar.
      style={{
        height: 28,
        // Faint frosted strip — a translucent fill (no extra blur; the shell
        // already blurs the ambient beneath) with a hairline top seam.
        backgroundColor: 'var(--glass-bg-soft)',
        borderTop: '1px solid var(--glass-border)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 10px',
        flexShrink: 0,
        gap: 10,
        userSelect: 'none',
        WebkitUserSelect: 'none',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ flex: 1 }} />

      <button
        className="mt-toolbar-button"
        onClick={() => setNotificationCenterOpen(true)}
        title={
          totalUnread > 0
            ? `${totalUnread} unread alert${totalUnread === 1 ? '' : 's'}`
            : totalAlerts > 0
              ? `${totalAlerts} notification${totalAlerts === 1 ? '' : 's'} in history`
              : 'No notifications'
        }
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 22,
          background: 'transparent',
          border: '1px solid transparent',
          borderRadius: 'var(--radius-snug)',
          cursor: 'pointer',
          color: totalUnread > 0 ? 'var(--accent-amber)' : 'var(--text-muted)',
          padding: 0,
        }}
      >
        <Bell size={12} />
        {totalUnread > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -2,
              right: -2,
              minWidth: 13,
              height: 13,
              padding: '0 3px',
              borderRadius: 'var(--radius-snug)',
              background: 'transparent',
              border: '1px solid var(--accent-amber)',
              color: 'var(--accent-amber)',
              fontSize: 8.5,
              fontWeight: 500,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
              fontFamily: 'inherit',
            }}
          >
            {totalUnread > 99 ? '99+' : totalUnread}
          </span>
        )}
      </button>

      <IconButton
        size="sm"
        onClick={() => setDevLogOpen(!devLogOpen)}
        label="Dev Log (Ctrl+Shift+L)"
        className={devLogOpen ? 'is-active' : undefined}
      >
        <Bug size={12} />
      </IconButton>

      <IconButton size="sm" onClick={() => setGlobalSettingsOpen(true)} label="Settings">
        <Settings size={12} />
      </IconButton>
    </div>
  );
}
