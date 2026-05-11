import React, { memo } from 'react';

interface Props {
  text: string;
}

// User messages sit on the same side as assistant messages so the conversation
// reads as one continuous flow. They earn their own visual identity from a
// brighter elevated background and a soft drop shadow — the only place in the
// chat that uses elevation, so it pops without adding a four-sided frame.
export const UserMessage = memo(function UserMessage({ text }: Props) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', margin: '12px 0' }}>
      <div
        style={{
          maxWidth: '85%',
          padding: '10px 14px',
          backgroundColor: 'var(--bg-elevated)',
          color: 'var(--text-primary)',
          borderRadius: 'var(--radius-soft)',
          boxShadow: 'var(--shadow-elevated-message)',
          fontSize: 12.5,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </div>
    </div>
  );
});
