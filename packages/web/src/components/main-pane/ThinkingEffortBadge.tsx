import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import type {
  Session,
  ProviderCapabilities,
  ThinkingEffort,
  DiscoveredModel,
} from '../../lib/types';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';
import { cleanModelLabel } from '../../lib/modelName';
import { emphasisFill } from '../../lib/emphasis';

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
  tone: 'muted' | 'info' | 'warning' | 'purple' | 'danger';
}

// Rendering metadata for the SDK's EffortLevel enum
// (sdk.d.ts:465). Each option's availability per model is decided by the
// catalog's DiscoveredModel.effortLevels — this array is only the
// label/tone source.
const OPTIONS: Option[] = [
  {
    value: 'low',
    label: 'Low',
    description: 'Minimal thinking — fastest, cheapest.',
    tone: 'muted',
  },
  {
    value: 'medium',
    label: 'Medium',
    description: 'Balanced reasoning depth.',
    tone: 'info',
  },
  {
    value: 'high',
    label: 'High',
    description: 'Deep reasoning. SDK default for capable models.',
    tone: 'warning',
  },
  {
    value: 'xhigh',
    label: 'Extra High',
    description: 'Deeper than high — supported on top-tier models only.',
    tone: 'purple',
  },
  {
    value: 'max',
    label: 'Max',
    description: 'Maximum effort — deepest reasoning, only on models that support it.',
    tone: 'danger',
  },
];

interface Tone {
  /** Icon + accent rail color. See ModeBadge for the same pattern — tone color
   * lives on the glyph; the trigger surface stays neutral. */
  accent: string;
}

// Tones picked from the canonical --node-* palette + --accent-amber so the
// effort glyph fits the timeline color vocabulary. Trigger surface is neutral.
const TONES: Record<Option['tone'], Tone> = {
  muted:   { accent: 'var(--text-muted)' },
  info:    { accent: 'var(--node-fs-read)' },
  warning: { accent: 'var(--accent-amber)' },
  purple:  { accent: 'var(--node-thinking)' },
  danger:  { accent: 'var(--status-error)' },
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

  const triggerActive = open || triggerHover;

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
              : `${modelEntry ? cleanModelLabel(modelEntry) : (session.model ?? 'This model')} doesn't support reasoning effort.`
            : `Thinking effort: ${current.label} — ${current.description}`
        }
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={disabled}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 22,
          padding: '0 8px',
          fontFamily: 'inherit',
          fontSize: 11.5,
          fontWeight: 500,
          letterSpacing: '0.01em',
          color: 'var(--text-primary)',
          background: triggerActive && !disabled ? 'var(--bg-hover)' : 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-snug)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          outline: 'none',
          lineHeight: 1,
          transition:
            'background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
        }}
      >
        <span style={{ lineHeight: 1 }}>{current.label}</span>
      </button>
      {open && !disabled && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            ...(placement === 'top'
              ? { bottom: 'calc(100% + 6px)' }
              : { top: 'calc(100% + 6px)' }),
            left: 0,
            zIndex: 50,
            minWidth: 264,
            padding: 4,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-soft)',
            display: 'flex',
            flexDirection: 'column',
            animation: 'mt-slide-up var(--dur-fast) var(--ease-out)',
            transformOrigin: placement === 'top' ? 'bottom left' : 'top left',
          }}
        >
          <div
            style={{
              padding: '6px 10px 6px',
              fontSize: 10,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--text-muted)',
              fontWeight: 500,
            }}
          >
            Thinking effort
          </div>
          {visibleOptions.map((opt, idx) => {
            const tone = TONES[opt.tone];
            const isCurrent = opt.value === currentEffort;
            const isHover = hoverIdx === idx;
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
                  flexDirection: 'column',
                  gap: 2,
                  padding: '8px 10px 8px 12px',
                  borderRadius: 'var(--radius-snug)',
                  // Current level = tone-tinted fill; hover stays neutral.
                  ...(isHover
                    ? { background: 'var(--bg-hover)' }
                    : isCurrent
                      ? emphasisFill(tone.accent, { fill: 10, ring: 30, on: 'transparent' })
                      : { background: 'transparent' }),
                  border: 'none',
                  textAlign: 'left',
                  cursor: 'pointer',
                  width: '100%',
                  fontFamily: 'inherit',
                  transition: 'background-color var(--dur-fast) var(--ease-out)',
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
                    color: 'var(--text-muted)',
                    fontSize: 11,
                    lineHeight: 1.35,
                  }}
                >
                  {opt.description}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
