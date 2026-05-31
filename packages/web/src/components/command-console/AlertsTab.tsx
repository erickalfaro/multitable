import React from 'react';
import { X, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import type { SessionAlert } from '../../lib/types';
import { IconButton } from '../ui';
import { categoryIcon, SEVERITY_BORDER_VAR } from '../../lib/alertVisuals';

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
        // Severity stays the urgency channel (red on error, amber on attention,
        // green on success) so the at-a-glance vocabulary survives even as the
        // icon shape now encodes category instead.
        borderLeft: `3px solid ${SEVERITY_BORDER_VAR[alert.severity]}`,
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
      }}
    >
      <div style={{ marginTop: 2, flexShrink: 0 }}>{categoryIcon(alert.category)}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
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

/**
 * The Alerts tab — kept structurally identical to the legacy
 * `NotificationCenter` body so the existing per-category icon + per-severity
 * border vocabulary established in `alertVisuals.tsx` carries over unchanged.
 */
export function AlertsTab({ onJumpToSession }: { onJumpToSession: (id: string) => void }) {
  const alerts = useAppStore((s) => s.alerts);
  const sessions = useAppStore((s) => s.sessions);
  const dismissAlert = useAppStore((s) => s.dismissAlert);

  if (alerts.length === 0) {
    return (
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
    );
  }

  return (
    <div>
      {alerts.map((alert) => (
        <NotificationRow
          key={alert.alertId}
          alert={alert}
          sessionName={sessions[alert.sessionId]?.name ?? 'Session'}
          onJump={() => onJumpToSession(alert.sessionId)}
          onDismiss={() => dismissAlert(alert.alertId)}
        />
      ))}
    </div>
  );
}
