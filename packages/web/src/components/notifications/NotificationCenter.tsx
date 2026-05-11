import React, { useMemo } from 'react';
import { X, Trash2, ChevronRight, Bell, AlertTriangle, AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import type { SessionAlert, AlertSeverity } from '../../lib/types';
import { IconButton } from '../ui';

function severityIcon(severity: AlertSeverity): React.ReactNode {
  const size = 14;
  switch (severity) {
    case 'attention':
      return <Bell size={size} color="var(--accent)" />;
    case 'error':
      return <AlertCircle size={size} color="var(--status-error)" />;
    case 'warning':
      return <AlertTriangle size={size} color="var(--status-stopped)" />;
    case 'success':
      return <CheckCircle2 size={size} color="var(--status-running)" />;
    case 'info':
    default:
      return <Info size={size} color="var(--text-secondary)" />;
  }
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5000) return 'just now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleString();
}

interface RowProps {
  alert: SessionAlert;
  sessionName: string;
  onJump: () => void;
  onDismiss: () => void;
}

function NotificationRow({ alert, sessionName, onJump, onDismiss }: RowProps) {
  return (
    <div
      style={{
        padding: '10px 12px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
      }}
    >
      <div style={{ marginTop: 2, flexShrink: 0 }}>{severityIcon(alert.severity)}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {alert.title}
          </span>
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)', flexShrink: 0 }}>
            {formatRelative(alert.timestamp)}
          </span>
        </div>
        {alert.body && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-secondary)',
              marginTop: 3,
              wordBreak: 'break-word',
              maxHeight: 80,
              overflow: 'hidden',
            }}
          >
            {alert.body}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 6,
          }}
        >
          <button
            onClick={onJump}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontSize: 11,
              color: 'var(--accent)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
            }}
          >
            {sessionName}
            <ChevronRight size={11} />
          </button>
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{alert.category}</span>
        </div>
      </div>
      <IconButton size="sm" label="Dismiss" onClick={onDismiss}>
        <X size={11} />
      </IconButton>
    </div>
  );
}

export function NotificationCenter() {
  const open = useAppStore((s) => s.notificationCenterOpen);
  const alerts = useAppStore((s) => s.alerts);
  const sessions = useAppStore((s) => s.sessions);
  const setOpen = useAppStore((s) => s.setNotificationCenterOpen);
  const dismissAlert = useAppStore((s) => s.dismissAlert);
  const setSelected = useAppStore((s) => s.setSelectedProcess);
  const clearAllAlerts = useAppStore((s) => s.clearAllAlerts);

  const grouped = useMemo(() => {
    // Most-recent first; alerts are already prepended on add, so iterate as-is.
    return alerts;
  }, [alerts]);

  if (!open) return null;

  return (
    <>
      <div
        onClick={() => setOpen(false)}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'var(--bg-overlay)',
          backdropFilter: 'blur(4px) saturate(1.05)',
          WebkitBackdropFilter: 'blur(4px) saturate(1.05)',
          zIndex: 950,
          animation: 'mt-fade-in var(--dur-fast) var(--ease-out)',
        }}
      />
      <div
        className="mt-scroll"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 380,
          maxWidth: '94vw',
          zIndex: 951,
          backgroundColor: 'var(--bg-sidebar)',
          borderLeft: '1px solid var(--border)',
          boxShadow: 'var(--shadow-xl)',
          display: 'flex',
          flexDirection: 'column',
          animation: 'mt-slide-up var(--dur-med) var(--ease-out)',
        }}
      >
        <div
          style={{
            padding: '12px 14px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <Bell size={15} color="var(--text-primary)" />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
            Notifications {grouped.length > 0 && (
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 500 }}>
                ({grouped.length})
              </span>
            )}
          </span>
          {grouped.length > 0 && (
            <IconButton size="sm" label="Clear all" onClick={clearAllAlerts}>
              <Trash2 size={12} />
            </IconButton>
          )}
          <IconButton size="sm" label="Close" onClick={() => setOpen(false)}>
            <X size={13} />
          </IconButton>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {grouped.length === 0 ? (
            <div
              style={{
                padding: '32px 16px',
                textAlign: 'center',
                color: 'var(--text-muted)',
                fontSize: 12.5,
              }}
            >
              No notifications.
            </div>
          ) : (
            grouped.map((alert) => (
              <NotificationRow
                key={alert.alertId}
                alert={alert}
                sessionName={sessions[alert.sessionId]?.name ?? 'Session'}
                onJump={() => {
                  setSelected(alert.sessionId);
                  setOpen(false);
                }}
                onDismiss={() => dismissAlert(alert.alertId)}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
}
