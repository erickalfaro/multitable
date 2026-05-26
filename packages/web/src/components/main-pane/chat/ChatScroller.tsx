import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ChevronDown } from 'lucide-react';

// ChatScroller — the sticky-bottom scroll container.
//
// Why this exists: the prior MessageList used `useLayoutEffect` to set
// `scrollTop = scrollHeight` on every change to messages OR streamingText OR
// toolStreaming OR reasoningStreaming. That fires a synchronous layout pass
// per chunk, exactly what causes the visible "wobble" when a `\n` lands and
// the markdown reflows.
//
// Replacement: ResizeObserver on the content. When content height grows, IF
// the user is currently at the bottom (within ~80px), scroll to the new
// bottom in the next animation frame. If the user has scrolled up to read
// older content, leave them alone — their reading position is preserved as
// new content streams in below the viewport.
//
// We disable the browser's built-in `overflow-anchor` because (a) Safari
// doesn't implement it, so we'd have inconsistent behavior across browsers,
// and (b) when it does fire it conflicts with our own ResizeObserver-driven
// adjustments and produces visible bouncing.

interface ChatScrollerContextValue {
  isAtBottom: boolean;
  scrollToBottom(opts?: { smooth?: boolean }): void;
  scrollRoot: HTMLDivElement | null;
  scrollToElement(el: HTMLElement, opts?: { smooth?: boolean }): void;
}

const ChatScrollerContext = createContext<ChatScrollerContextValue | null>(null);

export function useChatScroller(): ChatScrollerContextValue {
  const ctx = useContext(ChatScrollerContext);
  if (!ctx) {
    return {
      isAtBottom: true,
      scrollToBottom: () => {},
      scrollRoot: null,
      scrollToElement: () => {},
    };
  }
  return ctx;
}

// Pixel distance from the bottom edge that still counts as "stuck". Matches
// the prior threshold so behavior parity is preserved.
const STICKY_THRESHOLD_PX = 80;

interface Props {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  pinnedHeader?: React.ReactNode;
  /** When provided, scroll position is persisted to sessionStorage under
      this key on every scroll, and restored on next mount with the same key.
      Used by SessionChat so a mobile tab reload (bfcache eviction after a
      long background) lands back at the user's scroll position rather than
      snapping to the bottom — picking up where they left off. */
  persistKey?: string;
}

// One-shot per-mount key tracker so we don't restore twice if React StrictMode
// double-mounts in dev. Lives at module scope, intentionally — keyed by
// persistKey so each session's first ChatScroller mount restores once.
const restoredKeys = new Set<string>();

export function ChatScroller({ children, className, style, pinnedHeader, persistKey }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scrollRootEl, setScrollRootEl] = useState<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Mirror in a ref so the ResizeObserver callback (which has its own closure)
  // sees the up-to-date value without re-attaching on each state change.
  const atBottomRef = useRef(true);
  // Suppress the very next scroll listener firing after we programmatically
  // scroll, so an auto-track adjustment can't accidentally flip atBottom.
  const programmaticUntilRef = useRef(0);

  const isStuck = useCallback((): boolean => {
    const el = scrollRef.current;
    if (!el) return true;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distance < STICKY_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback((opts?: { smooth?: boolean }) => {
    const el = scrollRef.current;
    if (!el) return;
    programmaticUntilRef.current = performance.now() + 200;
    if (opts?.smooth) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);

  // Smooth-scroll a specific descendant element so its top sits near the
  // top of the scroll viewport. Used by PinnedUserPrompt's jump button and
  // by every UserMessage's prev/next chevrons.
  //
  // We compute scrollTop manually rather than using `el.scrollIntoView()`
  // because the latter scrolls *all* ancestor scrollables, which can yank
  // the composer/header out of place when the chat lives in a nested
  // layout.
  //
  // Critical: we forcibly release the "stuck to bottom" flag here. Otherwise
  // a forward jump (or any jump) made while atBottomRef is true would be
  // immediately reversed by the ResizeObserver snap on the next content
  // resize — that's why "next" appeared broken when the user was at the
  // bottom and streaming was active.
  const scrollToElement = useCallback((el: HTMLElement, opts?: { smooth?: boolean }) => {
    const root = scrollRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const targetRect = el.getBoundingClientRect();
    const delta = targetRect.top - rootRect.top;
    const maxScroll = Math.max(0, root.scrollHeight - root.clientHeight);
    const next = Math.min(maxScroll, Math.max(0, root.scrollTop + delta - 8));
    programmaticUntilRef.current = performance.now() + 600;
    atBottomRef.current = false;
    setAtBottom(false);
    if (opts?.smooth) {
      root.scrollTo({ top: next, behavior: 'smooth' });
    } else {
      root.scrollTop = next;
    }
  }, []);

  // User-driven scroll listener. Also throttles a sessionStorage write of
  // the current scroll offset so a tab reload (when bfcache fails — long
  // background on memory-constrained mobile) can restore the user to the
  // exact place they were reading rather than snapping to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let lastPersist = 0;
    const persist = () => {
      if (!persistKey) return;
      const now = performance.now();
      // Throttle to ~6 Hz — scroll events fire ~60 Hz; we don't need every
      // one in sessionStorage. The final position lands via the pagehide
      // flush below.
      if (now - lastPersist < 150) return;
      lastPersist = now;
      try {
        sessionStorage.setItem(
          `mt:chatScroll:${persistKey}`,
          JSON.stringify({ top: el.scrollTop, atBottom: atBottomRef.current }),
        );
      } catch {
        // sessionStorage may be unavailable / quota exceeded — ignore.
      }
    };
    const onScroll = () => {
      // Ignore the brief tail of programmatic scrolls so an auto-track
      // adjustment doesn't get misread as a user gesture.
      if (performance.now() < programmaticUntilRef.current) return;
      const stuck = isStuck();
      if (stuck !== atBottomRef.current) {
        atBottomRef.current = stuck;
        setAtBottom(stuck);
      }
      persist();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // Belt-and-braces: flush on pagehide so the very last scroll position
    // (which the throttle may have skipped) is persisted before bfcache /
    // unload. Use the same key write so the restore path sees fresh data.
    const onPageHide = () => {
      if (!persistKey) return;
      try {
        sessionStorage.setItem(
          `mt:chatScroll:${persistKey}`,
          JSON.stringify({ top: el.scrollTop, atBottom: atBottomRef.current }),
        );
      } catch {
        // ignore
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [isStuck, persistKey]);

  // Restore scroll position on mount when persistKey + saved data exist.
  // Runs in a layout effect so the position is applied BEFORE the browser
  // paints — no visible flash of "snapped to bottom, then jumped back".
  // The restore only fires for non-bottom positions; if the user was at
  // the bottom when they left, we keep the existing snap-to-bottom default
  // (which is also what they want for the next assistant turn).
  React.useLayoutEffect(() => {
    if (!persistKey) return;
    if (restoredKeys.has(persistKey)) return;
    restoredKeys.add(persistKey);
    const el = scrollRef.current;
    if (!el) return;
    let saved: { top: number; atBottom: boolean } | null = null;
    try {
      const raw = sessionStorage.getItem(`mt:chatScroll:${persistKey}`);
      if (raw) saved = JSON.parse(raw);
    } catch {
      // ignore
    }
    if (!saved || saved.atBottom) return; // bottom is the default — no-op
    // Defer one frame so initial children have laid out (scrollHeight grew
    // past the viewport). Without this, scrollHeight is too small and the
    // assignment clamps to 0.
    const apply = () => {
      const root = scrollRef.current;
      if (!root) return;
      const maxScroll = Math.max(0, root.scrollHeight - root.clientHeight);
      const target = Math.min(maxScroll, Math.max(0, saved!.top));
      // Suppress the snap-to-bottom auto-track for this position — the user
      // is intentionally NOT at the bottom.
      atBottomRef.current = false;
      setAtBottom(false);
      programmaticUntilRef.current = performance.now() + 400;
      root.scrollTop = target;
    };
    // requestAnimationFrame stacks well with the ChatScroller's existing
    // ResizeObserver: the observer fires once messages are laid out; our
    // rAF chain runs after that initial layout pass so target is valid.
    requestAnimationFrame(() => requestAnimationFrame(apply));
  }, [persistKey]);

  // Auto-track: when content height changes, snap to bottom if the user is
  // already there. ResizeObserver fires synchronously after layout and BEFORE
  // the browser paints, so writing `scrollTop` here lands in the SAME paint
  // as the layout change that fired it. The previous version deferred the
  // snap into a `requestAnimationFrame`, which split each delta across two
  // frames: frame N painted the new content with the OLD scrollTop (loader
  // visually drifted Δ pixels below the viewport bottom), then frame N+1
  // applied the snap and the loader jumped back. Repeated 30+ times a second
  // during streaming, that two-frame wobble was the perceived jitter — the
  // loader appearing to "chase" the stream rather than sit on top of it.
  // Coalescing is unnecessary because ResizeObserver itself batches into one
  // callback per layout pass, and `rafBatch` already coalesces store writes
  // to one update per animation frame upstream.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const ro = new ResizeObserver(() => {
      if (!scrollRef.current) return;
      if (!atBottomRef.current) return;
      programmaticUntilRef.current = performance.now() + 50;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const ctx = useMemo<ChatScrollerContextValue>(
    () => ({
      isAtBottom: atBottom,
      scrollToBottom,
      scrollRoot: scrollRootEl,
      scrollToElement,
    }),
    [atBottom, scrollToBottom, scrollRootEl, scrollToElement],
  );

  // Hide the "Jump to latest" affordance when there's nothing to scroll to —
  // i.e. content fits within the viewport. Avoids surfacing a control that
  // would silently no-op.
  const hasOverflow = (() => {
    const el = scrollRef.current;
    if (!el) return false;
    return el.scrollHeight - el.clientHeight > 8;
  })();
  const showJumpToLatest = !atBottom && hasOverflow;

  return (
    <ChatScrollerContext.Provider value={ctx}>
      <div
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          display: 'flex',
        }}
      >
        <div
          ref={(el) => {
            scrollRef.current = el;
            setScrollRootEl(el);
          }}
          className={`mt-scroll mt-chat-scroller ${className ?? ''}`}
          style={{
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            overflowY: 'auto',
            // Per-message scroll containers (code blocks, tables) handle
            // their own horizontal scroll. The scroll root itself must
            // clip — without this, a wide child that escapes its own
            // scroll container would push the whole chat column past the
            // viewport on mobile (no way to see the right-hand side).
            overflowX: 'hidden',
            // overflow-anchor: none disables the browser's heuristic anchor
            // adjustment. We do all anchoring ourselves via ResizeObserver +
            // explicit scrollTop assignment.
            overflowAnchor: 'none',
            ...style,
          }}
        >
          <div
            ref={contentRef}
            style={{
              padding: '12px 14px 16px',
              // minWidth: 0 lets flex/grid children shrink below their
              // intrinsic content width — required for the per-message
              // `overflow-x: auto` containers below to actually clip and
              // scroll instead of expanding their parent.
              minWidth: 0,
            }}
          >
            {children}
          </div>
        </div>

        {pinnedHeader && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              zIndex: 12,
              pointerEvents: 'none',
            }}
          >
            {pinnedHeader}
          </div>
        )}

        {showJumpToLatest && (
          <button
            type="button"
            onClick={() => scrollToBottom({ smooth: true })}
            style={{
              position: 'absolute',
              bottom: 14,
              right: 16,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '3px 10px',
              fontSize: 10.5,
              borderRadius: 'var(--radius-snug)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--accent-amber)',
              color: 'var(--accent-amber)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              zIndex: 10,
            }}
          >
            <ChevronDown size={11} /> Jump to latest
          </button>
        )}
      </div>
    </ChatScrollerContext.Provider>
  );
}
