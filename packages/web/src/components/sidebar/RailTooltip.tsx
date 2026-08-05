/**
 * Floating hover label for the 60px project rail — the replacement for the
 * old expand-on-hover sheet. One tooltip instance per rail, driven by a
 * shared controller so rows don't each own timers:
 *
 *   - cold hover opens after OPEN_DELAY_MS of uninterrupted dwell
 *   - once a tip is visible (or was hidden < WARM_WINDOW_MS ago) moving to a
 *     sibling row follows instantly — sweeping the rail feels like one label
 *     gliding row to row, without re-waiting the dwell each time
 *   - keyboard focus shows instantly; blur hides
 *   - any pointerdown (click-nav, context menu, drag start) cancels cold
 *
 * Rendering: portal to <body> with position:fixed (same escape hatch as
 * ContextMenu — the rail lives under overflow/transform ancestors), anchored
 * to the right of the hovered row, vertically centered and viewport-clamped.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

const OPEN_DELAY_MS = 1500;
const WARM_WINDOW_MS = 300;
const GAP_PX = 10;
const VIEWPORT_MARGIN_PX = 8;

export interface RailTipController {
  /** Hover entry — opens after the dwell delay (instant while warm). */
  show: (anchor: HTMLElement, content: React.ReactNode, hue?: string) => void;
  /** Keyboard focus — opens immediately. */
  showNow: (anchor: HTMLElement, content: React.ReactNode, hue?: string) => void;
  /** Hover exit / blur — hides, keeping the warm window alive. */
  hide: () => void;
  /** Hard dismiss (pointerdown, drag start) — hides and goes cold. */
  cancel: () => void;
}

export const RailTooltipContext = createContext<RailTipController | null>(null);

export function useRailTooltip(): RailTipController | null {
  return useContext(RailTooltipContext);
}

interface TipState {
  anchor: HTMLElement;
  content: React.ReactNode;
  hue?: string;
}

/**
 * Owns the tooltip state + timers. The rail calls this once, provides
 * `controller` via RailTooltipContext, and renders `tooltip` as a sibling of
 * the gutter. Pass `disabled` (mobile drawer) to get a null controller.
 */
export function useRailTooltipController(disabled: boolean): {
  controller: RailTipController | null;
  tooltip: React.ReactNode;
} {
  const [tip, setTip] = useState<TipState | null>(null);
  const tipRef = useRef<TipState | null>(null);
  tipRef.current = tip;
  const timerRef = useRef<number | undefined>(undefined);
  const warmUntilRef = useRef(0);

  const clearTimer = useCallback(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  const showNow = useCallback(
    (anchor: HTMLElement, content: React.ReactNode, hue?: string) => {
      clearTimer();
      setTip({ anchor, content, hue });
    },
    [clearTimer],
  );

  const show = useCallback(
    (anchor: HTMLElement, content: React.ReactNode, hue?: string) => {
      clearTimer();
      if (tipRef.current || Date.now() < warmUntilRef.current) {
        setTip({ anchor, content, hue });
        return;
      }
      timerRef.current = window.setTimeout(() => setTip({ anchor, content, hue }), OPEN_DELAY_MS);
    },
    [clearTimer],
  );

  const hide = useCallback(() => {
    clearTimer();
    if (tipRef.current) warmUntilRef.current = Date.now() + WARM_WINDOW_MS;
    setTip(null);
  }, [clearTimer]);

  const cancel = useCallback(() => {
    clearTimer();
    warmUntilRef.current = 0;
    setTip(null);
  }, [clearTimer]);

  // Any pointer press anywhere dismisses — covers row clicks (navigation),
  // context-menu opens, and drag starts without threading per-menu state.
  useEffect(() => {
    if (disabled) return;
    const onPointerDown = () => cancel();
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [disabled, cancel]);

  useEffect(() => clearTimer, [clearTimer]);

  const controller = useMemo<RailTipController | null>(
    () => (disabled ? null : { show, showNow, hide, cancel }),
    [disabled, show, showNow, hide, cancel],
  );

  const tooltip =
    !disabled && tip
      ? createPortal(
          <RailTipBubble anchor={tip.anchor} hue={tip.hue}>
            {tip.content}
          </RailTipBubble>,
          document.body,
        )
      : null;

  return { controller, tooltip };
}

function RailTipBubble({
  anchor,
  hue,
  children,
}: {
  anchor: HTMLElement;
  hue?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Measure after first paint to center on the anchor and clamp to the
  // viewport; until then render invisibly at the un-clamped position.
  const [top, setTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const h = el.offsetHeight;
    const centered = a.top + a.height / 2 - h / 2;
    const clamped = Math.min(
      Math.max(centered, VIEWPORT_MARGIN_PX),
      window.innerHeight - h - VIEWPORT_MARGIN_PX,
    );
    setTop(clamped);
  }, [anchor, children]);

  const accent = hue ?? 'var(--space-accent)';
  const left = anchor.getBoundingClientRect().right + GAP_PX;

  return (
    <div
      ref={ref}
      role="tooltip"
      className="mt-rail-tip"
      style={{
        position: 'fixed',
        left,
        top: top ?? 0,
        visibility: top === null ? 'hidden' : 'visible',
        zIndex: 100_000,
        pointerEvents: 'none',
        maxWidth: 300,
        padding: '7px 11px',
        borderRadius: 'var(--radius-comfortable)',
        background: `color-mix(in oklch, ${accent} 6%, var(--glass-bg-opaque))`,
        border: `1px solid color-mix(in oklch, ${accent} 28%, transparent)`,
        boxShadow: `var(--shadow-lg, 0 8px 24px oklch(0% 0 0 / 0.35)), 0 0 24px -8px color-mix(in oklch, ${accent} 35%, transparent)`,
        transformOrigin: 'left center',
        animation: 'mt-rail-tip-in var(--dur-fast) var(--ease-out)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        fontSize: 13,
        color: 'var(--text-primary)',
      }}
    >
      {children}
    </div>
  );
}

/** Primary line — project or session name. */
export function RailTipTitle({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.3,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        color: 'var(--text-primary)',
      }}
    >
      {children}
    </span>
  );
}

/** Dimmed secondary line — project path, live session snippet, … */
export function RailTipSub({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11,
        lineHeight: 1.35,
        color: 'var(--text-muted)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {children}
    </span>
  );
}
