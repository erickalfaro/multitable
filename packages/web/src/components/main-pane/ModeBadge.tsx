import React, { useState, useRef, useEffect } from 'react';
import {
  ChevronDown,
  Zap,
  Compass,
  CheckCheck,
  Rocket,
  MessageCircle,
  Eye,
  type LucideIcon,
} from 'lucide-react';
import toast from 'react-hot-toast';
import type { Session, SessionMode, ProviderCapabilities } from '../../lib/types';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';

interface Props {
  session: Session;
  /** Where the menu opens relative to the trigger. Defaults to 'top' (pop up)
   * since the badge usually lives in the chat composer at the bottom of the
   * viewport. Use 'bottom' when the badge is near the top edge. */
  placement?: 'top' | 'bottom';
}

interface ModeMeta {
  value: SessionMode;
  label: string;
  description: string;
  Icon: LucideIcon;
  /** Tone keys: muted (default), info (plan), success (accept-edits), danger (auto), purple (chat), warning (read-only). */
  tone: 'muted' | 'info' | 'success' | 'danger' | 'purple' | 'warning';
}

const MODE_OPTIONS: ModeMeta[] = [
  {
    value: 'default',
    label: 'Default',
    description: 'Tools execute, prompts on demand.',
    Icon: Zap,
    tone: 'muted',
  },
  {
    value: 'plan',
    label: 'Plan',
    description: 'Read-only research; produces a plan, no edits.',
    Icon: Compass,
    tone: 'info',
  },
  {
    value: 'accept-edits',
    label: 'Accept edits',
    description: 'Auto-approve all tool calls.',
    Icon: CheckCheck,
    tone: 'success',
  },
  {
    value: 'auto',
    label: 'Auto',
    description: 'Bypass all permissions (advanced).',
    Icon: Rocket,
    tone: 'danger',
  },
  {
    value: 'chat',
    label: 'Chat',
    description: 'Conversation only, no tools.',
    Icon: MessageCircle,
    tone: 'purple',
  },
  {
    value: 'read-only',
    label: 'Read-only',
    description: 'No mutations; read tools still run.',
    Icon: Eye,
    tone: 'warning',
  },
];

interface Tone {
  fg: string;
  bg: string;
  bgHover: string;
  border: string;
  accent: string;
}

const TONES: Record<ModeMeta['tone'], Tone> = {
  muted: {
    fg: 'var(--text-secondary)',
    bg: 'var(--bg-elevated, rgba(255,255,255,0.03))',
    bgHover: 'var(--bg-hover, rgba(255,255,255,0.06))',
    border: 'var(--border-strong)',
    accent: 'var(--text-tertiary)',
  },
  info: {
    fg: '#7c9bff',
    bg: 'rgba(99, 132, 255, 0.10)',
    bgHover: 'rgba(99, 132, 255, 0.18)',
    border: 'rgba(99, 132, 255, 0.45)',
    accent: '#7c9bff',
  },
  success: {
    fg: '#34d27a',
    bg: 'rgba(34, 197, 94, 0.10)',
    bgHover: 'rgba(34, 197, 94, 0.18)',
    border: 'rgba(34, 197, 94, 0.45)',
    accent: '#34d27a',
  },
  danger: {
    fg: '#f87171',
    bg: 'rgba(239, 68, 68, 0.10)',
    bgHover: 'rgba(239, 68, 68, 0.18)',
    border: 'rgba(239, 68, 68, 0.45)',
    accent: '#f87171',
  },
  purple: {
    fg: '#c084fc',
    bg: 'rgba(168, 85, 247, 0.10)',
    bgHover: 'rgba(168, 85, 247, 0.18)',
    border: 'rgba(168, 85, 247, 0.45)',
    accent: '#c084fc',
  },
  warning: {
    fg: 'var(--accent-amber, #f59e0b)',
    bg: 'rgba(245, 158, 11, 0.10)',
    bgHover: 'rgba(245, 158, 11, 0.18)',
    border: 'rgba(245, 158, 11, 0.45)',
    accent: 'var(--accent-amber, #f59e0b)',
  },
};

export function ModeBadge({ session, placement = 'top' }: Props) {
  // All hooks must run unconditionally — capabilities can arrive after the
  // first render, and Rules of Hooks forbids early-returning before useEffect.
  const [open, setOpen] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [triggerHover, setTriggerHover] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const upsertSession = useAppStore((s) => s.upsertSession);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', escHandler);
    };
  }, [open]);

  const caps: ProviderCapabilities | null | undefined = session.capabilities;
  const currentMode: SessionMode = session.mode ?? 'default';
  const supportedModes: SessionMode[] = caps?.modes ?? ['default'];
  if (supportedModes.length <= 1) return null;

  const visibleOptions = MODE_OPTIONS.filter((o) => supportedModes.includes(o.value));
  const current = MODE_OPTIONS.find((o) => o.value === currentMode) ?? MODE_OPTIONS[0];
  const currentTone = TONES[current.tone];
  const CurrentIcon = current.Icon;

  const setMode = async (mode: SessionMode) => {
    setOpen(false);
    if (mode === currentMode) return;
    upsertSession({ ...session, mode });
    try {
      await api.sessions.setMode(session.id, mode);
      toast.success(`Mode → ${MODE_OPTIONS.find((o) => o.value === mode)?.label}`, {
        duration: 1500,
      });
    } catch (err) {
      upsertSession({ ...session, mode: currentMode });
      const msg = err instanceof Error ? err.message : 'Failed to set mode';
      toast.error(msg);
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setTriggerHover(true)}
        onMouseLeave={() => setTriggerHover(false)}
        title={`${current.description} — click to change mode`}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 26,
          padding: '0 9px 0 8px',
          fontFamily: 'inherit',
          fontSize: 11.5,
          fontWeight: 500,
          letterSpacing: '0.01em',
          color: currentTone.fg,
          background: open || triggerHover ? currentTone.bgHover : currentTone.bg,
          border: `1px solid ${currentTone.border}`,
          borderRadius: 999,
          cursor: 'pointer',
          outline: 'none',
          boxShadow: open
            ? `0 0 0 3px ${currentTone.bg}, 0 1px 2px rgba(0,0,0,0.18)`
            : 'none',
          transition:
            'background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
        }}
      >
        <CurrentIcon size={12} strokeWidth={2.2} />
        <span style={{ lineHeight: 1 }}>{current.label}</span>
        <ChevronDown
          size={12}
          strokeWidth={2.2}
          style={{
            opacity: 0.75,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform var(--dur-fast) var(--ease-out)',
          }}
        />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            ...(placement === 'top'
              ? { bottom: 'calc(100% + 8px)' }
              : { top: 'calc(100% + 8px)' }),
            left: 0,
            zIndex: 50,
            minWidth: 264,
            padding: 4,
            background: 'var(--surface-elevated, var(--bg-secondary, #1a1a1d))',
            border: '1px solid var(--border-strong)',
            borderRadius: 12,
            boxShadow:
              '0 12px 32px rgba(0,0,0,0.32), 0 2px 6px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.04)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            display: 'flex',
            flexDirection: 'column',
            animation: 'mt-slide-up var(--dur-fast, 120ms) var(--ease-out, cubic-bezier(.2,.8,.2,1))',
            transformOrigin: placement === 'top' ? 'bottom left' : 'top left',
          }}
        >
          <div
            style={{
              padding: '6px 10px 4px',
              fontSize: 9.5,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--text-muted, var(--text-tertiary))',
              fontWeight: 600,
            }}
          >
            Agent mode
          </div>
          {visibleOptions.map((opt, idx) => {
            const tone = TONES[opt.tone];
            const isCurrent = opt.value === currentMode;
            const isHover = hoverIdx === idx;
            const Icon = opt.Icon;
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                onClick={() => setMode(opt.value)}
                onMouseEnter={() => setHoverIdx(idx)}
                onMouseLeave={() => setHoverIdx(null)}
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '8px 10px 8px 12px',
                  borderRadius: 8,
                  background: isHover
                    ? 'var(--bg-hover, rgba(255,255,255,0.04))'
                    : 'transparent',
                  border: 'none',
                  textAlign: 'left',
                  cursor: 'pointer',
                  width: '100%',
                  fontFamily: 'inherit',
                  transition: 'background var(--dur-fast) var(--ease-out)',
                }}
              >
                {isCurrent && (
                  <span
                    aria-hidden
                    style={{
                      position: 'absolute',
                      left: 4,
                      top: 10,
                      bottom: 10,
                      width: 2,
                      borderRadius: 2,
                      background: tone.accent,
                    }}
                  />
                )}
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 22,
                    height: 22,
                    flexShrink: 0,
                    borderRadius: 6,
                    background: tone.bg,
                    color: tone.fg,
                    border: `1px solid ${tone.border}`,
                  }}
                >
                  <Icon size={12} strokeWidth={2.2} />
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      color: 'var(--text-primary)',
                      fontSize: 12.5,
                      fontWeight: 500,
                      lineHeight: 1.2,
                    }}
                  >
                    {opt.label}
                  </span>
                  <span
                    style={{
                      color: 'var(--text-tertiary)',
                      fontSize: 11,
                      lineHeight: 1.35,
                    }}
                  >
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
