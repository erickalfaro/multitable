import React, { memo, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';

interface Props {
  text: string;
  /** When true, render a blinking caret at the end (live streaming preview). */
  streaming?: boolean;
}

const PREVIEW_CHARS = 120;

function ReasoningCardInner({ text, streaming }: Props) {
  const [open, setOpen] = useState(false);
  const collapsed = !open;
  const preview =
    text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS).trimEnd() + '…' : text;

  return (
    <div
      style={{
        margin: 0,
        padding: 0,
        fontSize: 11.5,
        fontStyle: 'italic',
        color: 'var(--text-muted)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        whiteSpace: 'pre-wrap',
        opacity: 0.85,
        lineHeight: 1.55,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: 0,
          background: 'transparent',
          border: 'none',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontStyle: 'normal',
          fontSize: 9.5,
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          marginRight: 6,
        }}
      >
        {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
        Thinking
      </button>
      {collapsed ? preview : text}
      {streaming && <span className="mt-blink"> ▍</span>}
    </div>
  );
}

export const ReasoningCard = memo(ReasoningCardInner);
