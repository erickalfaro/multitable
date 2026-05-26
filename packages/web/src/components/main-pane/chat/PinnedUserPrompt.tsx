import React, { useEffect, useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { useChatScroller } from './ChatScroller';
import { useIsMobile } from '../../../lib/useIsMobile';

interface PinnedMessage {
  id: string;
  text: string;
}

interface Props {
  userMessages: PinnedMessage[];
}

// Scrollspy-style pinned-prompt bar. Shows whichever user prompt is the
// closest one ABOVE the current viewport top — i.e., the one that
// "started" the section of conversation the user is currently reading.
// As the user scrolls up or down, the bar updates live: scroll past a
// user prompt and it becomes the pinned context; scroll back above it
// and the bar reverts to the prior prompt (or hides if you're above the
// first prompt).
//
// We recompute on every scroll/resize via rAF, walking the in-DOM user
// message elements (tagged by MessageList with `data-user-message-index`)
// and picking the largest index whose top has crossed the viewport top.
//
// Navigation:
//   - ChevronUp = jump to the previous user prompt
//   - ChevronDown = jump to the next user prompt
//   - Clicking the body = jump to the currently-pinned prompt's original
//     position (handy when you want to read it in full context).
export function PinnedUserPrompt({ userMessages }: Props) {
  const { scrollRoot, scrollToElement } = useChatScroller();
  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!scrollRoot) {
      setCurrentIndex(null);
      return;
    }

    let frame = 0;

    const recompute = () => {
      const rootTop = scrollRoot.getBoundingClientRect().top;
      const els = scrollRoot.querySelectorAll<HTMLElement>('[data-user-message-index]');
      let next: number | null = null;
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const idxStr = el.dataset.userMessageIndex;
        if (!idxStr) continue;
        const idx = Number(idxStr);
        if (!Number.isFinite(idx)) continue;
        // "Above the line of sight" = top of the element has crossed the
        // top of the viewport. Once an element's top is below the viewport
        // top, it AND everything after it (in DOM order) are no longer
        // candidates, so we can stop.
        if (el.getBoundingClientRect().top <= rootTop) {
          next = idx;
        } else {
          break;
        }
      }
      setCurrentIndex(next);
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        recompute();
      });
    };

    recompute();
    scrollRoot.addEventListener('scroll', schedule, { passive: true });

    // Content size changes (streaming, new messages, message edits) shift
    // every element's top — re-evaluate after layout settles.
    const content = scrollRoot.firstElementChild as HTMLElement | null;
    const ro = content ? new ResizeObserver(schedule) : null;
    if (ro && content) ro.observe(content);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      scrollRoot.removeEventListener('scroll', schedule);
      ro?.disconnect();
    };
  }, [scrollRoot, userMessages.length]);

  if (currentIndex === null) return null;
  const current = userMessages[currentIndex];
  if (!current) return null;

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < userMessages.length - 1;

  const jumpTo = (targetIndex: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!scrollRoot) return;
    const el = scrollRoot.querySelector<HTMLElement>(
      `[data-user-message-index="${targetIndex}"]`,
    );
    if (el) scrollToElement(el, { smooth: true });
  };

  const jumpToCurrent = () => {
    if (!scrollRoot) return;
    const el = scrollRoot.querySelector<HTMLElement>(
      `[data-user-message-index="${currentIndex}"]`,
    );
    if (el) scrollToElement(el, { smooth: true });
  };

  return (
    <div style={{ pointerEvents: 'auto' }}>
      <div
        onClick={jumpToCurrent}
        title="Jump to this prompt"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: isMobile ? 6 : 10,
          padding: isMobile ? '6px 12px' : '10px 16px',
          backgroundColor: 'var(--bg-elevated)',
          color: 'var(--text-primary)',
          borderBottom: '1px solid var(--border)',
          boxShadow: 'var(--shadow-elevated-message)',
          fontSize: isMobile ? 11.5 : 12,
          lineHeight: 1.45,
          cursor: 'pointer',
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            wordBreak: 'break-word',
            whiteSpace: 'pre-wrap',
          }}
        >
          {current.text}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: isMobile ? 'row' : 'column',
            gap: 4,
            flexShrink: 0,
          }}
        >
          <NavButton
            disabled={!hasPrev}
            onClick={jumpTo(currentIndex - 1)}
            title="Jump to previous prompt"
            icon={<ChevronUp size={12} />}
          />
          <NavButton
            disabled={!hasNext}
            onClick={jumpTo(currentIndex + 1)}
            title="Jump to next prompt"
            icon={<ChevronDown size={12} />}
          />
        </div>
      </div>
    </div>
  );
}

function NavButton({
  disabled,
  onClick,
  title,
  icon,
}: {
  disabled: boolean;
  onClick: (e: React.MouseEvent) => void;
  title: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        borderRadius: 'var(--radius-snug)',
        background: 'transparent',
        border: '1px solid var(--border)',
        color: disabled ? 'var(--text-muted)' : 'var(--text-secondary)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.35 : 1,
        padding: 0,
      }}
    >
      {icon}
    </button>
  );
}
