import React from 'react';
import { useProcess } from '../../hooks/useProcess';
import { useAppStore } from '../../stores/appStore';
import { api, stopProcessByType } from '../../lib/api';
import { Square, Palette, Settings, Bell, Terminal as TerminalIcon } from 'lucide-react';
import { StatusDot } from '../sidebar/StatusDot';
import { BUILTIN_THEMES } from '../../lib/themes';
import { IconButton } from '../ui';

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

const SPARK_GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

function sparkBlock(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return SPARK_GLYPHS[0];
  const idx = Math.min(SPARK_GLYPHS.length - 1, Math.floor((percent / 100) * SPARK_GLYPHS.length));
  return SPARK_GLYPHS[idx];
}

const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '0 8px',
  height: 18,
  fontSize: 10.5,
  fontFamily: 'inherit',
  color: 'var(--text-secondary)',
  backgroundColor: 'transparent',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-snug)',
  lineHeight: 1,
  letterSpacing: '0.04em',
  fontVariantNumeric: 'tabular-nums',
};

const ghostBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  background: 'transparent',
  border: '1px solid transparent',
  cursor: 'pointer',
  color: 'var(--text-muted)',
  fontFamily: 'inherit',
  fontSize: 10.5,
  padding: '0 8px',
  height: 22,
  borderRadius: 'var(--radius-snug)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  transition: 'background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
};

function useClock() {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function StatusBar() {
  const {
    selectedProcessId,
    activeThemeId,
    customThemes,
    setActiveTheme,
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
  const clock = useClock();

  const allThemes = [...BUILTIN_THEMES, ...customThemes];
  const activeTheme = allThemes.find((t) => t.id === activeThemeId) ?? allThemes[0];

  const cycleTheme = () => {
    const idx = allThemes.findIndex((t) => t.id === activeThemeId);
    const next = allThemes[(idx + 1) % allThemes.length];
    setActiveTheme(next.id);
  };

  const cpu = process?.metrics?.cpuPercent ?? 0;
  const mem = process?.metrics?.memoryBytes ?? 0;

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
      <span
        style={{
          fontSize: 9.5,
          fontWeight: 700,
          color: 'var(--text-primary)',
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
        }}
      >
        NORMAL
      </span>

      {process && (
        <>
          <StatusDot state={process.state} size={11} />
          <span
            style={{
              fontSize: 11,
              fontFamily: 'inherit',
              color: 'var(--text-primary)',
              fontWeight: 500,
            }}
          >
            {process.name}
          </span>
          <span
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
            }}
          >
            · {process.state}
          </span>

          {process.state === 'running' && (
            <IconButton
              size="sm"
              variant="danger"
              label={process.type === 'session' ? 'Stop turn' : 'Stop process'}
              onClick={() => {
                stopProcessByType(process).catch((err) => {
                  console.error('[status-bar] stop failed:', err);
                });
              }}
            >
              <Square size={11} />
            </IconButton>
          )}

          <div style={{ flex: 1 }} />

          <span
            style={{
              fontFamily: 'inherit',
              fontSize: 13,
              lineHeight: 1,
              color: 'var(--text-secondary)',
              letterSpacing: '-0.05em',
            }}
            title={`CPU ${cpu.toFixed(1)}%`}
          >
            {sparkBlock(cpu).repeat(8)}
          </span>
          <span style={chipStyle}>cpu {cpu.toFixed(1)}%</span>
          <span style={chipStyle}>mem {formatBytes(mem)}</span>
        </>
      )}
      {!process && <div style={{ flex: 1 }} />}

      <button
        onClick={cycleTheme}
        title={`Theme: ${activeTheme?.name ?? 'Light'} (click to cycle)`}
        style={ghostBtnStyle}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)';
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--bg-hover)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)';
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
        }}
      >
        <Palette size={12} />
        <span>{activeTheme?.name ?? 'Light'}</span>
      </button>

      <button
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
          transition: 'background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--bg-hover)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
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

      <button
        onClick={() => setDevLogOpen(!devLogOpen)}
        title="Dev Log (Ctrl+Shift+L)"
        style={{
          ...ghostBtnStyle,
          color: devLogOpen ? 'var(--accent-amber)' : 'var(--text-muted)',
          backgroundColor: devLogOpen ? 'var(--bg-hover)' : 'transparent',
        }}
        onMouseEnter={(e) => {
          if (devLogOpen) return;
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)';
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--bg-hover)';
        }}
        onMouseLeave={(e) => {
          if (devLogOpen) return;
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)';
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
        }}
      >
        <TerminalIcon size={12} />
        <span>Logs</span>
      </button>

      <IconButton size="sm" onClick={() => setGlobalSettingsOpen(true)} label="Customize themes">
        <Settings size={12} />
      </IconButton>

      <span
        style={{
          fontFamily: 'inherit',
          fontSize: 10.5,
          color: 'var(--text-faint)',
          letterSpacing: '0.04em',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {clock}
      </span>
    </div>
  );
}
