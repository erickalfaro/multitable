import React from 'react';
import type { Components } from 'streamdown';
import { CodeBlock } from '../components/main-pane/chat/CodeBlock';

// Shared between AssistantMessage (chat history) and the expanded composer's
// Preview tab so both surfaces render markdown identically. Keep this object
// reference module-level — handing a fresh components object on every render
// blows the markdown renderer's memoization and causes flicker.
export const MD_COMPONENTS: Components = {
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
  ul: ({ children }) => <ul style={{ paddingLeft: 22, margin: '6px 0' }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ paddingLeft: 22, margin: '6px 0' }}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
  strong: ({ children }) => (
    <strong style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{children}</strong>
  ),
  em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
  del: ({ children }) => (
    <del style={{ textDecoration: 'line-through', color: 'var(--text-muted)' }}>{children}</del>
  ),
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
  // Inline images — clamped so a pasted screenshot doesn't blow out the
  // preview pane. The composer's Preview tab uses these for Obsidian-style
  // attachment thumbnails (paths are rewritten to `![](blob:…)` first).
  img: ({ src, alt }) => (
    <img
      src={src}
      alt={alt ?? ''}
      style={{
        maxWidth: '100%',
        maxHeight: 360,
        borderRadius: 'var(--radius-soft)',
        border: '1px solid var(--border)',
        display: 'block',
        margin: '6px 0',
      }}
    />
  ),
};
