import React from 'react';
import { useProcess } from '../../hooks/useProcess';
import { useAppStore } from '../../stores/appStore';
import { Settings, Bell, Bug } from 'lucide-react';
import { StatusDot } from '../sidebar/StatusDot';
import { IconButton } from '../ui';

export function StatusBar() {
  const {
    selectedProcessId,
    setGlobalSettingsOpen,
    setNotificationCenterOpen,
    devLogOpen,
    setDevLogOpen,
  } = useAppStore();
  const process = useProcess(selectedProcessId);
  const totalUnread = useAppStore((s) =>
    Object.values(s.unreadBySession).reduce((n, v) => n + v, 0),
  );
  const totalAlerts = useAppStore((s) => s.alerts.length);

  return (
    <div
      style={{
        height: 28,
        backgroundColor: 'var(--bg-statusbar)',
        borderTop: '1px solid var(--border)',
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
      {process && (
        <>
          <StatusDot state={process.state} size={11} />
          <span
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
            }}
          >
            {process.state}
          </span>
        </>
      )}
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
