import React, { useState, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import type {
  Session,
  ModeOption,
  ProviderCapabilities,
  ThinkingEffort,
  DiscoveredModel,
} from '../../lib/types';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';
import { useIsMobile } from '../../lib/useIsMobile';

interface Props {
  session: Session;
  /** Where the menu opens relative to the trigger. Defaults to 'top' (pop up)
   * since the badge usually lives in the chat composer at the bottom of the
   * viewport. Use 'bottom' when the badge is near the top edge. */
  placement?: 'top' | 'bottom';
}

// Mode list comes from `session.capabilities.modes` — the adapter is the
// source of truth for both values and display strings. The UI has no
// hardcoded enum, no per-provider lookup table, no translation.
//
// For Claude sessions these are `PermissionMode` values (`default`,
// `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, `auto`). For Codex
// they're `SandboxMode` values (`read-only`, `workspace-write`,
// `danger-full-access`). Both carry their own label + description text from
// the SDK / generated bindings via the daemon's capability payload.

// Effort tier metadata. Order matters — the dot slider renders left-to-right
// in this order, with the leftmost dot being the lowest effort.
interface EffortOption {
  value: ThinkingEffort;
  label: string;
}

const EFFORT_OPTIONS: EffortOption[] = [
  { value: 'low',    label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high',   label: 'High' },
  { value: 'xhigh',  label: 'Extra high' },
  { value: 'max',    label: 'Max' },
];

export function ModeBadge({ session, placement = 'top' }: Props) {
  // All hooks must run unconditionally — capabilities can arrive after the
  // first render, and Rules of Hooks forbids early-returning before useEffect.
  const [open, setOpen] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [triggerHover, setTriggerHover] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const upsertSession = useAppStore((s) => s.upsertSession);
  const isMobile = useIsMobile();

  // On mobile the badge lives in the top header (left edge), so an
  // absolutely-positioned 300px menu anchored to the trigger overflows the
  // viewport and gets clipped by the chat's `overflow: hidden`. Instead we
  // pin the menu with `position: fixed`, measured from the trigger and
  // clamped to the screen, so it always lands fully on-screen.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );

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

  // Lazily fetch the model catalog so we can gate the effort slider on the
  // model's actual supported tiers. Idempotent — the store dedupes in-flight loads.
  useEffect(() => {
    if (catalogStatus === 'idle') loadModelCatalog(provider);
  }, [catalogStatus, loadModelCatalog, provider]);

  const caps: ProviderCapabilities | null | undefined = session.capabilities;
  const currentMode: string = session.mode ?? 'default';
  const supportedModes: ModeOption[] = caps?.modes ?? [];

  // Effort eligibility — same gating logic the standalone badge used.
  const modelEntry: DiscoveredModel | undefined =
    session.model && catalog ? catalog.find((m) => m.id === session.model) : undefined;
  const modelSupportsEffort =
    modelEntry?.supportsEffort ?? (catalog ? false : true);
  const providerSupportsEffort = caps?.thinkingEffort !== 'unsupported';
  const effortAllowed: ThinkingEffort[] =
    modelEntry?.effortLevels && modelEntry.effortLevels.length > 0
      ? modelEntry.effortLevels
      : catalog
        ? ['low', 'medium', 'high']
        : ['low', 'medium', 'high', 'xhigh', 'max'];
  const effortEnabled = providerSupportsEffort && modelSupportsEffort;

  const persistedEffort = session.thinkingEffort ?? null;
  const fallbackEffort: ThinkingEffort = modelEntry?.defaultEffort ?? 'medium';
  const currentEffort: ThinkingEffort =
    persistedEffort && effortAllowed.includes(persistedEffort)
      ? persistedEffort
      : effortAllowed.includes(fallbackEffort)
        ? fallbackEffort
        : effortAllowed[0] ?? 'medium';

  // The adapter's declared modes ARE the visible options — no client-side
  // filtering, no metadata join.
  const visibleOptions: ModeOption[] = supportedModes;
  const current: ModeOption =
    supportedModes.find((o) => o.value === currentMode) ??
    supportedModes[0] ??
    { value: currentMode, label: currentMode, description: '' };
  const showModes = supportedModes.length > 1;

  // If neither modes nor effort can be changed, there's nothing to show.
  if (!showModes && !effortEnabled) return null;

  const setMode = async (mode: string) => {
    setOpen(false);
    if (mode === currentMode) return;
    upsertSession({ ...session, mode });
    try {
      await api.sessions.setMode(session.id, mode);
    } catch (err) {
      upsertSession({ ...session, mode: currentMode });
      const msg = err instanceof Error ? err.message : 'Failed to set mode';
      toast.error(msg);
    }
  };

  const setEffort = async (effort: ThinkingEffort) => {
    if (effort === currentEffort) return;
    upsertSession({ ...session, thinkingEffort: effort });
    try {
      await api.sessions.setThinkingEffort(session.id, effort);
    } catch (err) {
      upsertSession({ ...session, thinkingEffort: currentEffort });
      const msg = err instanceof Error ? err.message : 'Failed to set thinking effort';
      toast.error(msg);
    }
  };

  const toggleOpen = () => {
    // Measure before opening so the fixed-position mobile menu knows where to
    // land. Reading `open` here is safe — it's this render's value.
    if (!open && isMobile && ref.current) {
      const r = ref.current.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(320, window.innerWidth - margin * 2);
      let left = r.left;
      if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
      if (left < margin) left = margin;
      setMenuPos({ top: r.bottom + 6, left, width });
    }
    setOpen((o) => !o);
  };

  const triggerActive = open || triggerHover;
  const currentEffortLabel =
    EFFORT_OPTIONS.find((o) => o.value === currentEffort)?.label ?? 'Medium';

  // Mobile menus pin to the viewport (fixed) and clamp to screen width;
  // desktop keeps the trigger-anchored absolute dropdown.
  const useFixedMenu = isMobile && !!menuPos;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={toggleOpen}
        onMouseEnter={() => setTriggerHover(true)}
        onMouseLeave={() => setTriggerHover(false)}
        title={`${current.description} — click to change`}
        aria-haspopup="menu"
        aria-expanded={open}
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
          background: triggerActive ? 'var(--bg-hover)' : 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-snug)',
          cursor: 'pointer',
          outline: 'none',
          lineHeight: 1,
          transition:
            'background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
        }}
      >
        <span style={{ lineHeight: 1 }}>{current.label}</span>
      </button>
      {open && (
        <div
          role="menu"
          className={useFixedMenu ? 'mt-scroll' : undefined}
          style={{
            zIndex: useFixedMenu ? 200 : 50,
            padding: 4,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-soft)',
            display: 'flex',
            flexDirection: 'column',
            animation: 'mt-slide-up var(--dur-fast) var(--ease-out)',
            ...(useFixedMenu
              ? {
                  position: 'fixed',
                  top: menuPos!.top,
                  left: menuPos!.left,
                  width: menuPos!.width,
                  maxHeight: `calc(100vh - ${menuPos!.top + 16}px)`,
                  overflowY: 'auto',
                  transformOrigin: 'top left',
                  boxShadow: 'var(--shadow-xl)',
                }
              : {
                  position: 'absolute',
                  ...(placement === 'top'
                    ? { bottom: 'calc(100% + 6px)' }
                    : { top: 'calc(100% + 6px)' }),
                  left: 0,
                  minWidth: 300,
                  transformOrigin: placement === 'top' ? 'bottom left' : 'top left',
                }),
          }}
        >
          {showModes && (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  padding: '6px 10px 6px',
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    letterSpacing: '0.18em',
                    textTransform: 'uppercase',
                    color: 'var(--text-muted)',
                    fontWeight: 500,
                  }}
                >
                  Modes
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--text-faint)',
                    letterSpacing: '0.04em',
                  }}
                >
                  Esc to close
                </span>
              </div>
              {visibleOptions.map((opt, idx) => {
                const isCurrent = opt.value === currentMode;
                const isHover = hoverIdx === idx;
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
                      borderRadius: 'var(--radius-snug)',
                      background: isHover
                        ? 'var(--bg-hover)'
                        : isCurrent
                          ? 'color-mix(in srgb, var(--bg-hover) 55%, transparent)'
                          : 'transparent',
                      border: 'none',
                      textAlign: 'left',
                      cursor: 'pointer',
                      width: '100%',
                      fontFamily: 'inherit',
                      transition: 'background-color var(--dur-fast) var(--ease-out)',
                    }}
                  >
                    {isCurrent && (
                      <span
                        aria-hidden
                        style={{
                          position: 'absolute',
                          left: 4,
                          top: 8,
                          bottom: 8,
                          width: 2,
                          background: 'var(--accent-amber)',
                        }}
                      />
                    )}
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
                          fontWeight: isCurrent ? 600 : 500,
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
                    </span>
                  </button>
                );
              })}
            </>
          )}

          {effortEnabled && (
            <>
              {showModes && (
                <div
                  style={{
                    height: 1,
                    background: 'var(--border)',
                    margin: '6px 4px',
                  }}
                />
              )}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: '6px 10px 10px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      letterSpacing: '0.18em',
                      textTransform: 'uppercase',
                      color: 'var(--text-muted)',
                      fontWeight: 500,
                    }}
                  >
                    Effort
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--text-primary)',
                      fontWeight: 500,
                    }}
                  >
                    {currentEffortLabel}
                  </span>
                </div>
                <EffortDots
                  options={EFFORT_OPTIONS}
                  allowed={effortAllowed}
                  current={currentEffort}
                  onPick={setEffort}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface EffortDotsProps {
  options: EffortOption[];
  allowed: ThinkingEffort[];
  current: ThinkingEffort;
  onPick: (effort: ThinkingEffort) => void;
}

// Hybrid toggle/slider for reasoning effort tiers:
//   - Toggle: click any dot to jump straight to that tier.
//   - Slider: press anywhere on the track and drag — the tier follows the
//     pointer and snaps to the nearest dot live during the drag.
// Tiers the current model doesn't support are dimmed; if a drag/click lands
// on a disallowed tier we snap to the nearest allowed one so the gesture
// always resolves to something the model accepts.
function EffortDots({ options, allowed, current, onPick }: EffortDotsProps) {
  const trackRef = React.useRef<HTMLDivElement | null>(null);
  const draggingRef = React.useRef(false);
  const lastPickedRef = React.useRef<ThinkingEffort>(current);
  React.useEffect(() => {
    lastPickedRef.current = current;
  }, [current]);

  const currentIdx = options.findIndex((o) => o.value === current);

  const pickFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    let idx = Math.round(ratio * (options.length - 1));
    if (!allowed.includes(options[idx].value)) {
      // Snap to the nearest allowed tier by index distance — ties prefer the
      // lower tier (matches "drag right to go higher" intuition: you have to
      // cross past a tier to advance into it).
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < options.length; i++) {
        if (!allowed.includes(options[i].value)) continue;
        const d = Math.abs(i - idx);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      if (best < 0) return;
      idx = best;
    }
    const next = options[idx].value;
    if (next !== lastPickedRef.current) {
      lastPickedRef.current = next;
      onPick(next);
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only react to primary pointer (left mouse, single touch, pen).
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    draggingRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pickFromClientX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    pickFromClientX(e.clientX);
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={options.length - 1}
      aria-valuenow={currentIdx}
      aria-valuetext={options[currentIdx]?.label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(e) => {
        // Keyboard nudge — Left/Right move one tier, Home/End jump to ends.
        // All paths route through pickFromClientX-equivalent index logic so
        // disallowed tiers are skipped over.
        const move = (delta: number) => {
          let i = currentIdx + delta;
          while (i >= 0 && i < options.length && !allowed.includes(options[i].value)) {
            i += delta;
          }
          if (i >= 0 && i < options.length) onPick(options[i].value);
        };
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          e.preventDefault();
          move(-1);
        } else if (e.key === 'Home') {
          e.preventDefault();
          const first = options.findIndex((o) => allowed.includes(o.value));
          if (first >= 0) onPick(options[first].value);
        } else if (e.key === 'End') {
          e.preventDefault();
          for (let i = options.length - 1; i >= 0; i--) {
            if (allowed.includes(options[i].value)) {
              onPick(options[i].value);
              break;
            }
          }
        }
      }}
      style={{
        position: 'relative',
        height: 18,
        display: 'flex',
        alignItems: 'center',
        // The whole row is the hit target so the slider gesture works even
        // when the pointer is between dots.
        cursor: 'pointer',
        touchAction: 'none',
        userSelect: 'none',
        outline: 'none',
      }}
    >
      {/* Recessed pill track — subtle inset shadow plus a darker-than-panel
          fill gives it a "groove" feel so the amber level reads as something
          slotted into a channel rather than a flat hairline. */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: '50%',
          height: 6,
          marginTop: -3,
          background:
            'linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated) 70%, black 30%) 0%, color-mix(in srgb, var(--bg-elevated) 85%, black 15%) 100%)',
          border: '1px solid color-mix(in srgb, var(--border-strong) 70%, transparent)',
          borderRadius: 999,
          boxShadow:
            'inset 0 1px 2px rgba(0, 0, 0, 0.45), inset 0 -1px 0 rgba(255, 255, 255, 0.04)',
        }}
      />
      {/* Filled portion: left edge → current dot. Amber gradient with a soft
          glow so the level reads as the "active" zone. */}
      {currentIdx > 0 && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: 1,
            top: '50%',
            height: 6,
            marginTop: -3,
            width: `calc(${(currentIdx / (options.length - 1)) * 100}% - 2px)`,
            background:
              'linear-gradient(180deg, color-mix(in srgb, var(--accent-amber) 100%, white 12%) 0%, var(--accent-amber) 55%, color-mix(in srgb, var(--accent-amber) 100%, black 18%) 100%)',
            borderRadius: 999,
            boxShadow:
              '0 0 8px color-mix(in srgb, var(--accent-amber) 35%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.18)',
            transition: 'width var(--dur-fast) var(--ease-out)',
          }}
        />
      )}
      {/* Dots, evenly distributed across the track */}
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
        }}
      >
        {options.map((opt, idx) => {
          const isAllowed = allowed.includes(opt.value);
          const isCurrent = opt.value === current;
          const isFilled = idx <= currentIdx;
          // The current dot is the slider thumb — bigger, lighter, with a
          // soft amber halo so it reads as a draggable handle. Filled
          // non-thumb dots are flat amber on the fill track (they blend with
          // the bar but mark discrete stops). Unfilled dots are recessed
          // pinpricks that sit in the groove.
          const size = isCurrent ? 14 : isFilled ? 6 : 6;
          return (
            <span
              key={opt.value}
              aria-hidden
              title={`${opt.label}${isAllowed ? '' : ' — not supported by this model'}`}
              style={{
                width: size,
                height: size,
                borderRadius: '50%',
                border: isCurrent
                  ? '1px solid color-mix(in srgb, var(--accent-amber) 100%, white 25%)'
                  : isFilled
                    ? '1px solid color-mix(in srgb, var(--accent-amber) 100%, black 10%)'
                    : '1px solid color-mix(in srgb, var(--border-strong) 70%, transparent)',
                background: isCurrent
                  ? 'radial-gradient(circle at 30% 30%, color-mix(in srgb, var(--accent-amber) 100%, white 30%) 0%, var(--accent-amber) 60%, color-mix(in srgb, var(--accent-amber) 100%, black 20%) 100%)'
                  : isFilled
                    ? 'color-mix(in srgb, var(--accent-amber) 100%, black 8%)'
                    : 'color-mix(in srgb, var(--bg-elevated) 80%, black 20%)',
                boxShadow: isCurrent
                  ? '0 0 0 3px color-mix(in srgb, var(--accent-amber) 22%, transparent), 0 1px 3px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.25)'
                  : isFilled
                    ? 'none'
                    : 'inset 0 1px 1px rgba(0, 0, 0, 0.35)',
                opacity: isAllowed ? 1 : 0.35,
                flexShrink: 0,
                transition:
                  'background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), width var(--dur-fast) var(--ease-out), height var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
