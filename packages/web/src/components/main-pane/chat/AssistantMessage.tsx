import React, { memo, useState } from 'react';
import { Streamdown } from 'streamdown';
import toast from 'react-hot-toast';
import 'streamdown/styles.css';
import { StreamingContext } from './StreamingContext';
import { MD_COMPONENTS } from '../../../lib/markdown';
import { CopyButton } from '../../ui';
import { copyToClipboard } from '../../../lib/clipboard';
import { useIsMobile } from '../../../lib/useIsMobile';
import { useLongPress } from '../../../lib/useLongPress';

interface Props {
  text: string;
  costLabel?: string | null;
  /** True for the in-flight streaming partial — appends a blinking caret. */
  streaming?: boolean;
}

// Assistant message — rendered as GitHub-flavored markdown via Streamdown,
// which auto-closes unclosed code fences during streaming. Code fences are
// handed off to the shiki-backed CodeBlock. Inline code uses a compact chip.
// Memoized so unrelated parent re-renders don't re-parse the markdown.
//
// Copy: desktop reveals an overlay button on hover (top-right of the content
// box, clear of TurnRow's left rail); mobile copies via long-press + toast
// (no hover on touch). Hover state is kept internal so the memo on
// {text, costLabel, streaming} still holds.
export const AssistantMessage = memo(function AssistantMessage({ text, costLabel, streaming }: Props) {
  const isMobile = useIsMobile();
  const [hover, setHover] = useState(false);
  const longPress = useLongPress(async () => {
    if (await copyToClipboard(text)) toast.success('Copied');
  });

  return (
    <div
      style={{ position: 'relative', margin: 0, color: 'var(--text-primary)', minWidth: 0 }}
      onMouseEnter={isMobile ? undefined : () => setHover(true)}
      onMouseLeave={isMobile ? undefined : () => setHover(false)}
      {...(isMobile ? longPress : null)}
    >
      {!isMobile && (
        <CopyButton
          variant="overlay"
          visible={hover}
          getText={() => text}
          title="Copy message"
          size={12}
          style={{ top: 0, right: 0, zIndex: 1 }}
        />
      )}
      <div
        className="mt-chat-assistant"
        style={{
          fontSize: 12.5,
          lineHeight: 1.55,
          maxWidth: '100%',
          // Flex shrink: without minWidth: 0 a flex/grid child won't shrink
          // below its intrinsic content width, so a long URL or a wide code
          // block would push the whole chat column wider than the viewport
          // (no horizontal scroll, just clipped content on the right).
          minWidth: 0,
          // Long unbreakable strings (URLs, file paths, long inline code)
          // need to break to keep the message column within viewport width
          // on mobile. `anywhere` is the modern equivalent of `break-word`
          // that also influences min-content sizing — critical inside flex
          // containers — and is the industry standard for chat surfaces.
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        <StreamingContext.Provider value={!!streaming}>
          <Streamdown components={MD_COMPONENTS} parseIncompleteMarkdown>
            {streaming ? `${text}▍` : text}
          </Streamdown>
        </StreamingContext.Provider>
      </div>
      {costLabel && (
        <div
          style={{
            fontSize: 10,
            color: 'var(--text-muted)',
            marginTop: 4,
            fontFamily: 'inherit',
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
          }}
        >
          {costLabel}
        </div>
      )}
    </div>
  );
});
