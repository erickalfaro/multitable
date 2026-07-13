import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  action: () => void;
  divider?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

interface Props {
  items: MenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

/** Sit above rail sheets, modals hosts, glyph pickers, mobile drawers, etc. */
const CONTEXT_MENU_Z = 100_000;

export function ContextMenu({ items, position, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Capture phase so we win over stopPropagation in nested UI.
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Adjust position to stay on screen
  let left = position.x;
  let top = position.y;
  const menuWidth = 200;
  const menuHeight = items.length * 32 + 12;
  if (left + menuWidth > window.innerWidth) left = window.innerWidth - menuWidth - 8;
  if (top + menuHeight > window.innerHeight) top = window.innerHeight - menuHeight - 8;
  if (left < 0) left = 8;
  if (top < 0) top = 8;

  // Portal to body so fixed positioning isn't trapped by rail overflow /
  // transform / isolation stacking contexts (which buried "Pin to Wall").
  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: CONTEXT_MENU_Z,
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-lg)',
        padding: 6,
        minWidth: 180,
        animation: 'mt-scale-in var(--dur-fast) var(--ease-out)',
        transformOrigin: 'top left',
      }}
    >
      {items.map((item, i) => (
        <React.Fragment key={i}>
          {item.divider && (
            <div
              style={{
                borderTop: '1px solid var(--border)',
                margin: '4px -2px',
              }}
            />
          )}
          <div
            role="menuitem"
            aria-disabled={item.disabled || undefined}
            onClick={() => {
              if (item.disabled) return;
              item.action();
              onClose();
            }}
            style={{
              padding: '6px 12px',
              fontSize: 13,
              cursor: item.disabled ? 'default' : 'pointer',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              color: item.danger
                ? 'var(--status-error)'
                : item.disabled
                  ? 'var(--text-muted)'
                  : 'var(--text-primary)',
              opacity: item.disabled ? 0.5 : 1,
              backgroundColor: 'transparent',
              borderRadius: 'var(--radius-md)',
              transition: 'background-color var(--dur-fast) var(--ease-out)',
            }}
            onMouseEnter={(e) => {
              if (!item.disabled) {
                (e.currentTarget as HTMLDivElement).style.backgroundColor = item.danger
                  ? 'color-mix(in srgb, var(--status-error) 14%, transparent)'
                  : 'var(--bg-hover)';
              }
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent';
            }}
          >
            {item.label}
          </div>
        </React.Fragment>
      ))}
    </div>,
    document.body,
  );
}
