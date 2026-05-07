import React, { memo } from 'react';
import { Streamdown, type Components } from 'streamdown';
import 'streamdown/styles.css';
import { CodeBlock } from './CodeBlock';

interface Props {
  text: string;
  costLabel?: string | null;
  /** True for the in-flight streaming partial — appends a blinking caret. */
  streaming?: boolean;
}

// Module-level so the reference is stable across every AssistantMessage
// render. A fresh components object per render forces the markdown renderer
// to discard memoized children — a key cause of flicker during unrelated
// parent re-renders (e.g. metrics ticks).
const MD_COMPONENTS: Components = {
  // react-markdown v9 dropped the `inline` boolean on the `code` component.
  // Distinguish by className: fenced blocks carry `language-X`, inline `code`
  // does not. We also override `pre` to a passthrough so it doesn't wrap our
  // CodeBlock in an extra <pre>.
  pre({ children }) {
    return <>{children}</>;
  },
  code(props) {
    const { className, children } = props;
    const code = String(children ?? '').replace(/\n$/, '');
    const match = /language-([\w-]+)/.exec(className ?? '');
    if (match) {
      return <CodeBlock code={code} lang={match[1]} />;
    }
    return (
      <code
        style={{
          fontFamily: 'inherit',
          fontSize: '0.92em',
          padding: '0 4px',
          borderRadius: 'var(--radius-snug)',
          backgroundColor: 'var(--bg-hover)',
          color: 'var(--text-primary)',
        }}
      >
        {code}
      </code>
    );
  },
  a({ children, href }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        style={{ color: 'var(--accent-amber)', textDecoration: 'underline' }}
      >
        {children}
      </a>
    );
  },
  p({ children }) {
    return <p style={{ margin: '0 0 6px' }}>{children}</p>;
  },
  blockquote({ children }) {
    return (
      <blockquote
        style={{
          margin: '6px 0',
          padding: '4px 10px',
          borderLeft: '3px solid var(--border-strong)',
          color: 'var(--text-secondary)',
        }}
      >
        {children}
      </blockquote>
    );
  },
  // Headings — real semantic levels with a sized hierarchy. h1 is no longer
  // remapped to h3; it renders as a true h1 with the new font size.
  h1: ({ children }) => (
    <h1 style={{ fontSize: 17, fontWeight: 600, margin: '0 0 6px' }}>{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ fontSize: 15.5, fontWeight: 600, margin: '0 0 6px' }}>{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 6px' }}>{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px' }}>{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 style={{ fontSize: 12.5, fontWeight: 600, margin: '0 0 6px' }}>{children}</h5>
  ),
  h6: ({ children }) => (
    <h6
      style={{
        fontSize: 12,
        fontWeight: 600,
        margin: '0 0 6px',
        color: 'var(--text-secondary)',
      }}
    >
      {children}
    </h6>
  ),
  // GFM tables
  table: ({ children }) => (
    <table style={{ borderCollapse: 'collapse', margin: '8px 0', fontSize: '0.95em' }}>
      {children}
    </table>
  ),
  thead: ({ children }) => (
    <thead style={{ backgroundColor: 'var(--bg-elevated)' }}>{children}</thead>
  ),
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => (
    <th
      style={{
        borderBottom: '1px solid var(--border-strong)',
        padding: '4px 8px',
        textAlign: 'left',
        fontWeight: 600,
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td style={{ padding: '4px 8px' }}>{children}</td>
  ),
  // Lists
  ul: ({ children }) => <ul style={{ paddingLeft: 22, margin: '6px 0' }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ paddingLeft: 22, margin: '6px 0' }}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
  // Inline emphasis
  strong: ({ children }) => (
    <strong style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{children}</strong>
  ),
  em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
  del: ({ children }) => (
    <del style={{ textDecoration: 'line-through', color: 'var(--text-muted)' }}>{children}</del>
  ),
  // Centered three-dot motif in place of a full-width rule
  hr: () => (
    <div
      style={{
        textAlign: 'center',
        color: 'var(--text-faint)',
        letterSpacing: '0.5em',
        margin: '14px 0',
      }}
    >
      ···
    </div>
  ),
  // GFM task list checkboxes
  input: (props) => {
    const { type, checked, disabled } = props as typeof props & {
      type?: string;
      checked?: boolean;
      disabled?: boolean;
    };
    if (type === 'checkbox') {
      return (
        <input
          type="checkbox"
          checked={!!checked}
          disabled={disabled}
          readOnly
          style={{
            width: 12,
            height: 12,
            accentColor: 'var(--accent-amber)',
            verticalAlign: '-1px',
            marginRight: 4,
          }}
        />
      );
    }
    return <input {...props} />;
  },
};

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
        <Streamdown components={MD_COMPONENTS} parseIncompleteMarkdown>
          {streaming ? `${text}▍` : text}
        </Streamdown>
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
