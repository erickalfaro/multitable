import React, { memo } from 'react';
import { Streamdown } from 'streamdown';
import 'streamdown/styles.css';
import { StreamingContext } from './StreamingContext';
import { MD_COMPONENTS } from '../../../lib/markdown';

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
export const AssistantMessage = memo(function AssistantMessage({ text, costLabel, streaming }: Props) {
  return (
    <div style={{ margin: 0, color: 'var(--text-primary)' }}>
      <div
        className="mt-chat-assistant"
        style={{
          fontSize: 12.5,
          lineHeight: 1.55,
          maxWidth: '100%',
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
