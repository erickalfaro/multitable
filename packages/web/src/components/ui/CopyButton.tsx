import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { copyToClipboard } from '../../lib/clipboard';

export type CopyButtonVariant = 'overlay' | 'inline';

interface CopyButtonProps {
  /**
   * The text to copy. Accepts a getter so callers with mutating content
   * (e.g. a streaming assistant message) resolve the latest on-screen text at
   * click time without re-rendering this button on every delta.
   */
  getText: string | (() => string);
  variant?: CopyButtonVariant;
  /** Icon size in px. */
  size?: number;
  /**
   * Drives opacity for hover-reveal placements. When omitted the button is
   * always visible. When provided, the button only shows while `visible` (or
   * just after a copy, so the success flash isn't cut off).
   */
  visible?: boolean;
  title?: string;
  /** Escape hatch for absolute positioning in the `overlay` variant. */
  style?: React.CSSProperties;
}

// Shared copy affordance for the chat surface. Routes through the
// `copyToClipboard` helper (async Clipboard API on secure contexts, hidden
// textarea + execCommand fallback for plain-HTTP LAN access). Confirmation is
// an icon swap (Copy → Check) + amber tint, reset after 1200ms.
export function CopyButton({
  getText,
  variant = 'inline',
  size = 11,
  visible,
  title = 'Copy',
  style,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState(false);

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = typeof getText === 'function' ? getText() : getText;
    const ok = await copyToClipboard(text);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const box = Math.max(22, size + 11);
  const overlay = variant === 'overlay';

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={copied ? 'Copied' : title}
      aria-label={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: box,
        height: box,
        padding: 0,
        background: overlay
          ? hover
            ? 'var(--bg-hover)'
            : 'var(--bg-elevated)'
          : hover
            ? 'var(--bg-hover)'
            : 'transparent',
        border: `1px solid ${overlay ? 'var(--border-strong)' : hover ? 'var(--border-strong)' : 'transparent'}`,
        borderRadius: 'var(--radius-snug)',
        color: copied ? 'var(--accent-amber)' : hover ? 'var(--text-primary)' : 'var(--text-muted)',
        cursor: 'pointer',
        flexShrink: 0,
        opacity: visible === undefined ? 1 : visible || copied ? 1 : 0,
        transition:
          'opacity var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
        fontFamily: 'inherit',
        ...(overlay ? { position: 'absolute' } : null),
        ...style,
      }}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </button>
  );
}
