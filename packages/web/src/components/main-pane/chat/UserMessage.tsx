import React, { memo } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import { useChatScroller } from './ChatScroller';
import { CopyButton } from '../../ui';
import { copyToClipboard } from '../../../lib/clipboard';
import { useIsMobile } from '../../../lib/useIsMobile';
import { useLongPress } from '../../../lib/useLongPress';

interface Props {
  text: string;
  index: number;
  hasPrev: boolean;
  hasNext: boolean;
}

// User messages render as a full-width bar across the chat area — same
// visual language as the pinned-prompt overlay so the user's text feels
// like a continuous structural element rather than a chat bubble. The
// negative horizontal margins break out of the chat content's 14px side
// padding so the bar truly spans edge-to-edge.
//
// Navigation uses DOM-position indices (`data-user-message-index`) rather
// than message ids. Codex resumed sessions can produce user messages with
// colliding canonical ids; positional indices are unique by construction
// and immune to that class of bug.
export const UserMessage = memo(function UserMessage({
  text,
  index,
  hasPrev,
  hasNext,
}: Props) {
  const { scrollRoot, scrollToElement } = useChatScroller();
  const isMobile = useIsMobile();
  const longPress = useLongPress(async () => {
    if (await copyToClipboard(text)) toast.success('Copied');
  });

  const jumpTo = (targetIndex: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!scrollRoot) return;
    const el = scrollRoot.querySelector<HTMLElement>(
      `[data-user-message-index="${targetIndex}"]`,
    );
    if (el) scrollToElement(el, { smooth: true });
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        margin: '12px -14px',
        padding: '10px 16px',
        backgroundColor: 'var(--bg-elevated)',
        color: 'var(--text-primary)',
        borderTop: '1px solid var(--border)',
        borderBottom: '1px solid var(--border)',
        fontSize: 12.5,
        lineHeight: 1.5,
      }}
      {...(isMobile ? longPress : null)}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
        <NavButton
          disabled={!hasPrev}
          onClick={jumpTo(index - 1)}
          title="Jump to previous prompt"
          icon={<ChevronUp size={12} />}
        />
        <NavButton
          disabled={!hasNext}
          onClick={jumpTo(index + 1)}
          title="Jump to next prompt"
          icon={<ChevronDown size={12} />}
        />
        {/* Desktop only — mobile copies via long-press on the bar. */}
        {!isMobile && (
          <CopyButton getText={text} title="Copy prompt" size={11} style={{ border: '1px solid var(--border)' }} />
        )}
      </div>
    </div>
  );
});

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
