import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Brain, Sparkles, Flame, type LucideIcon } from 'lucide-react';
import toast from 'react-hot-toast';
import type {
  Session,
  ProviderCapabilities,
  ThinkingEffort,
  DiscoveredModel,
} from '../../lib/types';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';

interface Props {
  session: Session;
  /** Where the menu opens relative to the trigger. Defaults to 'top'
   * since the badge lives in the chat composer. */
  placement?: 'top' | 'bottom';
}

interface Option {
  value: ThinkingEffort;
  label: string;
  description: string;
  Icon: LucideIcon;
  tone: 'muted' | 'info' | 'warning' | 'purple' | 'danger';
}

// Rendering metadata for the SDK's EffortLevel enum
// (sdk.d.ts:465). Each option's availability per model is decided by the
// catalog's DiscoveredModel.effortLevels — this array is only the
// label/icon/tone source.
const OPTIONS: Option[] = [
  {
    value: 'low',
    label: 'Low',
    description: 'Minimal thinking — fastest, cheapest.',
    Icon: Brain,
    tone: 'muted',
  },
  {
    value: 'medium',
    label: 'Medium',
    description: 'Balanced reasoning depth.',
    Icon: Brain,
    tone: 'info',
  },
  {
    value: 'high',
    label: 'High',
    description: 'Deep reasoning. SDK default for capable models.',
    Icon: Brain,
    tone: 'warning',
  },
  {
    value: 'xhigh',
    label: 'X-High',
    description: 'Deeper than high — supported on top-tier models only.',
    Icon: Sparkles,
    tone: 'purple',
  },
  {
    value: 'max',
    label: 'Max',
    description: 'Maximum effort — Opus 4.6 / 4.7 only.',
    Icon: Flame,
    tone: 'danger',
  },
];

interface Tone {
  fg: string;
  bg: string;
  bgHover: string;
  border: string;
  accent: string;
}

const TONES: Record<Option['tone'], Tone> = {
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
  warning: {
    fg: 'var(--accent-amber, #f59e0b)',
    bg: 'rgba(245, 158, 11, 0.10)',
    bgHover: 'rgba(245, 158, 11, 0.18)',
    border: 'rgba(245, 158, 11, 0.45)',
    accent: 'var(--accent-amber, #f59e0b)',
  },
  purple: {
    fg: '#c084fc',
    bg: 'rgba(168, 85, 247, 0.10)',
    bgHover: 'rgba(168, 85, 247, 0.18)',
    border: 'rgba(168, 85, 247, 0.45)',
    accent: '#c084fc',
  },
  danger: {
    fg: '#f87171',
    bg: 'rgba(239, 68, 68, 0.10)',
    bgHover: 'rgba(239, 68, 68, 0.18)',
    border: 'rgba(239, 68, 68, 0.45)',
    accent: '#f87171',
  },
};

export function ThinkingEffortBadge({ session, placement = 'top' }: Props) {
  const [open, setOpen] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [triggerHover, setTriggerHover] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const upsertSession = useAppStore((s) => s.upsertSession);
  const provider = session.agentProvider;
  const catalog = useAppStore((s) => s.modelCatalog[provider]);
  const catalogStatus = useAppStore((s) => s.modelCatalogStatus[provider]);
  const loadModelCatalog = useAppStore((s) => s.loadModelCatalog);

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

  // Lazily fetch the model catalog so we can gate on per-model effort support.
  // Idempotent — the store guards against duplicate in-flight loads.
  useEffect(() => {
    if (catalogStatus === 'idle') loadModelCatalog(provider);
  }, [catalogStatus, loadModelCatalog, provider]);

  const caps: ProviderCapabilities | null | undefined = session.capabilities;

  // Look up the session's currently-selected model in the catalog so we can
  // honor per-model reasoning support (both Codex and Claude expose this
  // natively — `supported_reasoning_levels` from `codex debug models` and
  // `supportedEffortLevels` from the Claude SDK's `initializationResult()`).
  // When the catalog hasn't loaded yet, fall back to permissive defaults so
  // the badge doesn't flicker into "disabled" on first paint.
  const modelEntry: DiscoveredModel | undefined =
    session.model && catalog ? catalog.find((m) => m.id === session.model) : undefined;
  const modelSupportsEffort =
    modelEntry?.supportsEffort ?? (catalog ? false : true);
  // Levels the badge will actually show. Three cases:
  //   1. Catalog loaded + model entry has explicit effortLevels → use them.
  //   2. Catalog loaded but model entry has nothing → show the SDK's three
  //      safe levels (low/medium/high) which every reasoning-capable model
  //      accepts.
  //   3. Catalog not loaded yet → show the full enum permissively; the
  //      provider will surface a clear turn-error if the user picks an
  //      unsupported tier before discovery returns.
  const allowedLevels: ThinkingEffort[] =
    modelEntry?.effortLevels && modelEntry.effortLevels.length > 0
      ? modelEntry.effortLevels
      : catalog
        ? ['low', 'medium', 'high']
        : ['low', 'medium', 'high', 'xhigh', 'max'];

  // Two paths can disable the badge:
  //   1. Provider-level: the adapter doesn't expose a reasoning knob at all
  //      (kept as a capability flag for future providers; both active
  //      providers — Claude and Codex — declare 'native').
  //   2. Model-level: the selected model under a supporting provider doesn't
  //      itself support effort (e.g. a legacy claude-3-* model).
  const providerUnsupported = caps?.thinkingEffort === 'unsupported';
  const disabled = providerUnsupported || !modelSupportsEffort;

  // Visual fallback chain: persisted session value → the model's own default
  // → our overall fallback of 'medium'. Always lands on a level the model
  // actually supports.
  const persisted = session.thinkingEffort ?? null;
  const fallback: ThinkingEffort = modelEntry?.defaultEffort ?? 'medium';
  const persistedSupported = persisted && allowedLevels.includes(persisted);
  const currentEffort: ThinkingEffort = persistedSupported
    ? (persisted as ThinkingEffort)
    : allowedLevels.includes(fallback)
      ? fallback
      : allowedLevels[0] ?? 'medium';

  const current = OPTIONS.find((o) => o.value === currentEffort) ?? OPTIONS[1];
  const currentTone = TONES[current.tone];
  const CurrentIcon = current.Icon;

  const visibleOptions = OPTIONS.filter((o) => allowedLevels.includes(o.value));

  const setEffort = async (effort: ThinkingEffort) => {
    setOpen(false);
    if (effort === currentEffort) return;
    upsertSession({ ...session, thinkingEffort: effort });
    try {
      await api.sessions.setThinkingEffort(session.id, effort);
      toast.success(`Thinking → ${OPTIONS.find((o) => o.value === effort)?.label}`, {
        duration: 1500,
      });
    } catch (err) {
      upsertSession({ ...session, thinkingEffort: currentEffort });
      const msg = err instanceof Error ? err.message : 'Failed to set thinking effort';
      toast.error(msg);
    }
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
        }}
        onMouseEnter={() => setTriggerHover(true)}
        onMouseLeave={() => setTriggerHover(false)}
        title={
          disabled
            ? providerUnsupported
              ? "This provider doesn't expose a reasoning-effort knob."
              : `${modelEntry?.displayName ?? session.model ?? 'This model'} doesn't support reasoning effort.`
            : `Thinking effort: ${current.label} — ${current.description}`
        }
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={disabled}
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
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          outline: 'none',
          boxShadow: open
            ? `0 0 0 3px ${currentTone.bg}, 0 1px 2px rgba(0,0,0,0.18)`
            : 'none',
          transition:
            'background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
        }}
      >
        <CurrentIcon size={12} strokeWidth={2.2} />
        <span style={{ lineHeight: 1 }}>Think: {current.label}</span>
        {!disabled && (
          <ChevronDown
            size={12}
            strokeWidth={2.2}
            style={{
              opacity: 0.75,
              transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform var(--dur-fast) var(--ease-out)',
            }}
          />
        )}
      </button>
      {open && !disabled && (
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
            animation:
              'mt-slide-up var(--dur-fast, 120ms) var(--ease-out, cubic-bezier(.2,.8,.2,1))',
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
            Thinking effort
          </div>
          {visibleOptions.map((opt, idx) => {
            const tone = TONES[opt.tone];
            const isCurrent = opt.value === currentEffort;
            const isHover = hoverIdx === idx;
            const Icon = opt.Icon;
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                onClick={() => setEffort(opt.value)}
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
                <span
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    flex: 1,
                    minWidth: 0,
                  }}
                >
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
