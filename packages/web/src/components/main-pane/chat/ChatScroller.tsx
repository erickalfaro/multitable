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
}

const ChatScrollerContext = createContext<ChatScrollerContextValue | null>(null);

export function useChatScroller(): ChatScrollerContextValue {
  const ctx = useContext(ChatScrollerContext);
  if (!ctx) {
    return {
      isAtBottom: true,
      scrollToBottom: () => {},
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
}

export function ChatScroller({ children, className, style }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
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

  // User-driven scroll listener.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      // Ignore the brief tail of programmatic scrolls so an auto-track
      // adjustment doesn't get misread as a user gesture.
      if (performance.now() < programmaticUntilRef.current) return;
      const stuck = isStuck();
      if (stuck !== atBottomRef.current) {
        atBottomRef.current = stuck;
        setAtBottom(stuck);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [isStuck]);

  // Auto-track: when content height changes, snap to bottom if the user is
  // already there. This is what makes streaming feel locked to the latest
  // text without doing a layout pass per chunk — ResizeObserver coalesces
  // multiple growths into a single notification per animation frame.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    let pending = false;
    const ro = new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        if (!scrollRef.current) return;
        if (!atBottomRef.current) return;
        // Direct assignment, not scrollTo({behavior:'smooth'}): smooth
        // animation lags behind content during fast streams. Instant-snap
        // 60 times/sec produces a continuous tracking effect.
        programmaticUntilRef.current = performance.now() + 50;
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      });
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const ctx = useMemo<ChatScrollerContextValue>(
    () => ({ isAtBottom: atBottom, scrollToBottom }),
    [atBottom, scrollToBottom],
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
          ref={scrollRef}
          className={`mt-scroll mt-chat-scroller ${className ?? ''}`}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            // overflow-anchor: none disables the browser's heuristic anchor
            // adjustment. We do all anchoring ourselves via ResizeObserver +
            // explicit scrollTop assignment.
            overflowAnchor: 'none',
            ...style,
          }}
        >
          <div ref={contentRef} style={{ padding: '12px 14px 16px' }}>
            {children}
          </div>
        </div>

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
