import { useEffect, useRef, useState } from 'react';
import { Gauge } from 'lucide-react';
import type { Session, UsageLimitWindow } from '../../lib/types';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';
import { useIsMobile } from '../../lib/useIsMobile';

interface Props {
  session: Session;
  /** Where the popover opens relative to the trigger. Defaults to 'bottom'
   * since the badge lives in the session header (which sits at the top). */
  placement?: 'top' | 'bottom';
}

// Tone ramps as the most-constraining window fills up. Colors come from the
// canonical CSS-variable palette so the badge fits the timeline vocabulary.
function toneFor(usedPercent: number): string {
  if (usedPercent >= 90) return 'var(--status-error)';
  if (usedPercent >= 75) return 'var(--accent-amber)';
  if (usedPercent >= 50) return 'var(--node-fs-read)';
  return 'var(--text-muted)';
}

// Compact countdown ("2h", "5m", "30s") for the collapsed badge.
function fmtShort(resetsAt: number | null, now: number): string | null {
  if (resetsAt == null) return null;
  const ms = resetsAt - now;
  if (ms <= 0) return 'now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return `${Math.floor(ms / 1000)}s`;
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// Verbose countdown ("resets in 2h 5m") for the popover.
function fmtLong(resetsAt: number | null, now: number): string {
  if (resetsAt == null) return 'reset time unknown';
  const ms = resetsAt - now;
  if (ms <= 0) return 'resetting…';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `resets in ${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `resets in ${days}d ${hrs % 24}h`;
}

function mostConstraining(windows: UsageLimitWindow[]): UsageLimitWindow | null {
  if (windows.length === 0) return null;
  return windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
}

export function UsageLimitBadge({ session, placement = 'bottom' }: Props) {
  const [open, setOpen] = useState(false);
  const [triggerHover, setTriggerHover] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();

  // On mobile the badge sits in the header chip row near the left edge, so an
  // absolutely-positioned popover anchored with `right: 0` would extend past
  // the left of the viewport. Mirror ModeBadge: pin the popover with
  // `position: fixed`, measured from the trigger and clamped on-screen.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );

  const snapshot = useAppStore((s) => s.usageLimitsBySession[session.id]);
  const setUsageLimits = useAppStore((s) => s.setUsageLimits);
  const caps = session.capabilities;
  const supported = caps?.usageLimits === true;

  // Hydrate once for a refreshed / late-joining client — the WS push only
  // arrives on the next provider update, so seed from the REST snapshot.
  useEffect(() => {
    if (!supported || snapshot !== undefined) return;
    let cancelled = false;
    api.sessions
      .usageLimits(session.id)
      .then((snap) => {
        if (!cancelled) setUsageLimits(session.id, snap);
      })
      .catch(() => {
        if (!cancelled) setUsageLimits(session.id, null);
      });
    return () => {
      cancelled = true;
    };
  }, [supported, snapshot, session.id, setUsageLimits]);

  // Close-on-outside-click / Escape for the popover.
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

  const hasResetTimer =
    !!snapshot && snapshot.windows.some((w) => typeof w.resetsAt === 'number');

  // Tick the countdown clock once a second — only while there's a reset time to
  // render, so an idle/quota-less session pays nothing.
  useEffect(() => {
    if (!hasResetTimer) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasResetTimer]);

  // Capability false → render nothing (Hermes/Grok). Keeps the header clean.
  if (!supported) return null;

  const top = snapshot ? mostConstraining(snapshot.windows) : null;
  const unavailable = !snapshot || snapshot.status === 'unavailable' || top == null;
  const accent = unavailable ? 'var(--text-muted)' : toneFor(top!.usedPercent);
  const triggerActive = open || triggerHover;

  const shortReset = top ? fmtShort(top.resetsAt, now) : null;
  const collapsedLabel = unavailable ? '—' : `${Math.round(top!.usedPercent)}%`;

  // Mobile menus pin to the viewport (fixed) and clamp on-screen; desktop keeps
  // the trigger-anchored absolute popover.
  const useFixedMenu = isMobile && !!menuPos;

  const toggleOpen = () => {
    // Measure before opening so the fixed-position mobile popover knows where
    // to land. Right-align it to the trigger (matching the desktop `right: 0`
    // intent), then clamp into the viewport.
    if (!open && isMobile && ref.current) {
      const r = ref.current.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(280, window.innerWidth - margin * 2);
      let left = r.right - width;
      if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
      if (left < margin) left = margin;
      setMenuPos({ top: r.bottom + 6, left, width });
    }
    setOpen((o) => !o);
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={toggleOpen}
        onMouseEnter={() => setTriggerHover(true)}
        onMouseLeave={() => setTriggerHover(false)}
        title={
          unavailable
            ? 'No live usage-limit data yet'
            : `Usage limit: ${Math.round(top!.usedPercent)}% of ${top!.label} used`
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          // Match the sibling ModelChip/ModeBadge in the mobile header chip row;
          // keep the roomier sizing in the desktop header's right cluster.
          gap: isMobile ? 3 : 5,
          height: isMobile ? 14 : 22,
          padding: isMobile ? '0 5px' : '0 8px',
          fontFamily: 'inherit',
          fontSize: isMobile ? 8.5 : 11.5,
          fontWeight: 500,
          letterSpacing: '0.01em',
          color: 'var(--text-primary)',
          background: triggerActive ? 'var(--bg-hover)' : 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-snug)',
          cursor: 'pointer',
          outline: 'none',
          lineHeight: 1,
          flexShrink: 0,
          transition:
            'background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
        }}
      >
        <Gauge size={isMobile ? 9 : 13} style={{ color: accent, flexShrink: 0 }} aria-hidden />
        <span style={{ lineHeight: 1, color: accent, fontVariantNumeric: 'tabular-nums' }}>
          {collapsedLabel}
        </span>
        {shortReset && (
          <span style={{ lineHeight: 1, color: 'var(--text-muted)' }}>· {shortReset}</span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Usage limits"
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
                  right: 0,
                  minWidth: 248,
                  transformOrigin: placement === 'top' ? 'bottom right' : 'top right',
                }),
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              padding: '6px 10px 6px',
              gap: 8,
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
              Usage limits
            </span>
            {snapshot?.planType && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{snapshot.planType}</span>
            )}
          </div>

          {unavailable ? (
            <div style={{ padding: '4px 10px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
              No live usage-limit data yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 10px 8px' }}>
              {snapshot!.windows.map((w, idx) => {
                const pct = Math.max(0, Math.min(100, w.usedPercent));
                const tone = toneFor(w.usedPercent);
                return (
                  <div key={`${w.label}-${idx}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 500 }}>
                        {w.label}
                      </span>
                      <span
                        style={{
                          fontSize: 12,
                          color: tone,
                          fontWeight: 600,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {Math.round(w.usedPercent)}%
                      </span>
                    </div>
                    <div
                      style={{
                        height: 4,
                        borderRadius: 2,
                        background: 'var(--bg-primary)',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${pct}%`,
                          height: '100%',
                          background: tone,
                          transition: 'width var(--dur-fast) var(--ease-out)',
                        }}
                      />
                    </div>
                    <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                      {fmtLong(w.resetsAt, now)}
                    </span>
                  </div>
                );
              })}
              {snapshot!.creditsRemaining != null && (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-muted)',
                    borderTop: '1px solid var(--border)',
                    paddingTop: 6,
                  }}
                >
                  Credits remaining: {snapshot!.creditsRemaining}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
