import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import type { Session, SessionMode, ProviderCapabilities } from '../../lib/types';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';

interface Props {
  session: Session;
}

// All possible modes + display labels. UI hides any not present in the
// session's adapter capabilities.modes.
const MODE_OPTIONS: Array<{
  value: SessionMode;
  label: string;
  description: string;
}> = [
  {
    value: 'default',
    label: 'Default',
    description: 'Normal — tools execute, prompts on demand.',
  },
  {
    value: 'plan',
    label: 'Plan',
    description: 'Read-only research; agent produces a plan, no edits.',
  },
  {
    value: 'accept-edits',
    label: 'Accept edits',
    description: 'Auto-approve all tool calls (use with caution).',
  },
  {
    value: 'auto',
    label: 'Auto',
    description: 'Bypass all permissions (advanced).',
  },
  {
    value: 'chat',
    label: 'Chat',
    description: 'Conversation only, no tool execution.',
  },
  {
    value: 'read-only',
    label: 'Read-only',
    description: 'No mutations; read tools still run.',
  },
];

const MODE_COLORS: Record<SessionMode, { bg: string; fg: string; border: string }> = {
  default: {
    bg: 'transparent',
    fg: 'var(--text-secondary)',
    border: 'var(--border-strong)',
  },
  plan: {
    bg: 'rgba(99, 132, 255, 0.10)',
    fg: 'var(--accent-blue, #6384ff)',
    border: 'rgba(99, 132, 255, 0.45)',
  },
  'accept-edits': {
    bg: 'rgba(34, 197, 94, 0.10)',
    fg: '#22c55e',
    border: 'rgba(34, 197, 94, 0.45)',
  },
  auto: {
    bg: 'rgba(239, 68, 68, 0.10)',
    fg: '#ef4444',
    border: 'rgba(239, 68, 68, 0.45)',
  },
  chat: {
    bg: 'rgba(168, 85, 247, 0.10)',
    fg: '#a855f7',
    border: 'rgba(168, 85, 247, 0.45)',
  },
  'read-only': {
    bg: 'rgba(245, 158, 11, 0.10)',
    fg: 'var(--accent-amber)',
    border: 'rgba(245, 158, 11, 0.45)',
  },
};

const chipBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  padding: '2px 8px',
  border: '1px solid',
  borderRadius: 999,
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
};

export function ModeBadge({ session }: Props) {
  // ALL hooks must run unconditionally — capabilities can arrive after the
  // first render (the WS attaches them after the initial REST fetch settles).
  // Early-returning before useEffect would change the hook order on the next
  // render and crash the component tree (Rules of Hooks).
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const upsertSession = useAppStore((s) => s.upsertSession);

  // Close popover on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const caps: ProviderCapabilities | null | undefined = session.capabilities;
  const currentMode: SessionMode = session.mode ?? 'default';

  // Only after every hook has fired do we decide whether to render.
  // If the adapter only supports 'default', there's nothing to switch.
  const supportedModes: SessionMode[] = caps?.modes ?? ['default'];
  if (supportedModes.length <= 1) return null;

  const visibleOptions = MODE_OPTIONS.filter((o) => supportedModes.includes(o.value));
  const current = MODE_OPTIONS.find((o) => o.value === currentMode) ?? MODE_OPTIONS[0];
  const colors = MODE_COLORS[currentMode];

  const setMode = async (mode: SessionMode) => {
    setOpen(false);
    if (mode === currentMode) return;
    // Optimistic update — daemon's session:mode-changed broadcast will
    // confirm. Roll back on error.
    upsertSession({ ...session, mode });
    try {
      await api.sessions.setMode(session.id, mode);
      toast.success(`Mode → ${MODE_OPTIONS.find((o) => o.value === mode)?.label}`, {
        duration: 1500,
      });
    } catch (err: any) {
      upsertSession({ ...session, mode: currentMode });
      toast.error(err?.message || 'Failed to set mode');
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          ...chipBase,
          background: colors.bg,
          color: colors.fg,
          borderColor: colors.border,
        }}
        title={`${current.description} — click to change`}
      >
        {current.label}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 50,
            background: 'var(--surface-elevated, var(--bg-secondary))',
            border: '1px solid var(--border-strong)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.20)',
            minWidth: 240,
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {visibleOptions.map((opt) => {
            const optColors = MODE_COLORS[opt.value];
            const isCurrent = opt.value === currentMode;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setMode(opt.value)}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: isCurrent ? 'var(--bg-tertiary)' : 'transparent',
                  border: 'none',
                  textAlign: 'left',
                  cursor: 'pointer',
                  color: 'var(--text-primary)',
                  fontSize: 12,
                  width: '100%',
                  transition: 'background var(--dur-fast) var(--ease-out)',
                }}
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-tertiary)')
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLButtonElement).style.background = isCurrent
                    ? 'var(--bg-tertiary)'
                    : 'transparent')
                }
              >
                <span style={{ width: 14, paddingTop: 2 }}>
                  {isCurrent && <Check size={12} style={{ color: optColors.fg }} />}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
                  <span style={{ color: optColors.fg, fontWeight: 500 }}>{opt.label}</span>
                  <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>
                    {opt.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
