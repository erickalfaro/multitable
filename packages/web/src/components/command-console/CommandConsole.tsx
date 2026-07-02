import React, { useEffect, useState } from 'react';
import { X, Trash2, Bell, Inbox } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { IconButton } from '../ui';
import { PendingActionsTab, usePendingCount } from './PendingActionsTab';
import { AlertsTab } from './AlertsTab';
import { emphasisFill } from '../../lib/emphasis';

type TabKey = 'pending' | 'alerts';

interface TabConfig {
  key: TabKey;
  label: string;
  icon: React.ReactNode;
  count: number;
}

function TabButton({
  config,
  active,
  onClick,
}: {
  config: TabConfig;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 26,
        margin: '5px 4px',
        padding: '0 10px',
        border: 'none',
        borderRadius: 'var(--radius-pill)',
        // Active tab = filled glass pill (segmented-control style).
        ...(active
          ? emphasisFill('var(--accent-amber)', { fill: 12, ring: 40 })
          : { background: 'transparent' }),
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
        transition: 'color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out)',
      }}
    >
      {config.icon}
      <span>{config.label}</span>
      {config.count > 0 && (
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            padding: '1px 6px',
            borderRadius: 'var(--radius-pill)',
            backgroundColor: active
              ? 'color-mix(in srgb, var(--accent-amber) 80%, transparent)'
              : 'color-mix(in srgb, var(--text-secondary) 25%, transparent)',
            color: active ? '#0a0a0a' : 'var(--text-secondary)',
            fontVariantNumeric: 'tabular-nums',
            minWidth: 16,
            textAlign: 'center',
          }}
        >
          {config.count}
        </span>
      )}
    </button>
  );
}

/**
 * The Command Console — a tabbed slide-out that aggregates *every* blocking
 * prompt across every project (Pending Actions tab) plus the rolling alert
 * history (Alerts tab). Mounted globally; opens via the StatusBar bell, the
 * same control that opened the old `NotificationCenter`.
 *
 * Resolving a prompt here goes through the same `wsClient.*` methods + store
 * mutators used by the per-session `PermissionBar`, so the two surfaces stay
 * in sync via the shared `pendingPermissions` / `pendingElicitations` slices.
 */
export function CommandConsole() {
  const open = useAppStore((s) => s.notificationCenterOpen);
  const setOpen = useAppStore((s) => s.setNotificationCenterOpen);
  const setSelected = useAppStore((s) => s.setSelectedProcess);
  const clearAllAlerts = useAppStore((s) => s.clearAllAlerts);
  const alertsCount = useAppStore((s) => s.alerts.length);
  const pendingCount = usePendingCount();

  const [tab, setTab] = useState<TabKey>('pending');

  // When the Console pops open and there's a pending prompt, jump straight to
  // the Pending tab so the user can act immediately. Otherwise fall back to
  // Alerts if there's something to read.
  useEffect(() => {
    if (!open) return;
    if (pendingCount > 0) setTab('pending');
    else if (alertsCount > 0) setTab('alerts');
  }, [open, pendingCount, alertsCount]);

  if (!open) return null;

  const jumpToSession = (id: string) => {
    setSelected(id);
    setOpen(false);
  };

  const tabs: TabConfig[] = [
    {
      key: 'pending',
      label: 'Pending',
      icon: <Inbox size={13} />,
      count: pendingCount,
    },
    {
      key: 'alerts',
      label: 'Alerts',
      icon: <Bell size={13} />,
      count: alertsCount,
    },
  ];

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
        className="mt-glass-strong mt-scroll"
        style={{
          position: 'fixed',
          top: 'var(--shell-inset)',
          right: 'var(--shell-inset)',
          bottom: 'var(--shell-inset)',
          width: 420,
          maxWidth: '94vw',
          borderRadius: 'var(--shell-radius)',
          zIndex: 951,
          boxShadow: 'var(--shadow-xl)',
          display: 'flex',
          flexDirection: 'column',
          animation: 'mt-slide-up var(--dur-med) var(--ease-out)',
        }}
      >
        <div
          style={{
            padding: '12px 14px 8px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
          }}
        >
          <Inbox size={15} color="var(--text-primary)" />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
            Command Console
          </span>
          {tab === 'alerts' && alertsCount > 0 && (
            <IconButton size="sm" label="Clear all alerts" onClick={clearAllAlerts}>
              <Trash2 size={12} />
            </IconButton>
          )}
          <IconButton size="sm" label="Close" onClick={() => setOpen(false)}>
            <X size={13} />
          </IconButton>
        </div>
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          {tabs.map((t) => (
            <TabButton
              key={t.key}
              config={t}
              active={tab === t.key}
              onClick={() => setTab(t.key)}
            />
          ))}
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {tab === 'pending' ? (
            <PendingActionsTab onJumpToSession={jumpToSession} />
          ) : (
            <AlertsTab onJumpToSession={jumpToSession} />
          )}
        </div>
      </div>
    </>
  );
}
