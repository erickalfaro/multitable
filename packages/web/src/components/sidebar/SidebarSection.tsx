import React, { useRef } from 'react';
import { Plus } from 'lucide-react';
import { IconButton } from '../ui';
import { useLongPress } from '../../lib/useLongPress';

interface Props {
  title: string;
  shortcut?: string;
  // Optional glyph rendered before the title (utility sections — the
  // Explorer — use this to read as a different class of section).
  icon?: React.ReactNode;
  // When set, the section body becomes a fixed-max-height scroll window (used
  // to cap process lists at ~10 visible rows; older items scroll).
  scrollMaxHeight?: number;
  onAdd?: () => void;
  // Called when the header is right-clicked (desktop) or long-pressed (mobile,
  // 500ms hold). The coords are in client space — pass them straight to a
  // <ContextMenu position={...}>.
  onHeaderRequestMenu?: (x: number, y: number) => void;
  children: React.ReactNode;
}

/**
 * A fixed (non-collapsible) sidebar section: slim uppercase header + body.
 * Sections used to collapse on header click; that was removed deliberately —
 * the header is now only a label + optional add-button / context-menu target.
 */
export function SidebarSection({
  title,
  shortcut,
  icon,
  scrollMaxHeight,
  onAdd,
  onHeaderRequestMenu,
  children,
}: Props) {
  // Long-press support for mobile. useLongPress's callback gets no event, so
  // stash the touch coords in a ref and read them when the timer fires.
  const lastTouch = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const longPress = useLongPress(() => {
    if (onHeaderRequestMenu) {
      onHeaderRequestMenu(lastTouch.current.x, lastTouch.current.y);
    }
  });

  return (
    <div className="mt-sidebar-section" style={{ marginTop: 14 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '2px 10px 2px 10px',
          // Match session row left rhythm; keep right inset for the + control.
          userSelect: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
          gap: 6,
        }}
        onContextMenu={
          onHeaderRequestMenu
            ? (e) => {
                e.preventDefault();
                onHeaderRequestMenu(e.clientX, e.clientY);
              }
            : undefined
        }
        onTouchStart={
          onHeaderRequestMenu
            ? (e) => {
                const t = e.touches[0];
                if (t) lastTouch.current = { x: t.clientX, y: t.clientY };
                longPress.onTouchStart(e);
              }
            : undefined
        }
        onTouchMove={onHeaderRequestMenu ? longPress.onTouchMove : undefined}
        onTouchEnd={onHeaderRequestMenu ? longPress.onTouchEnd : undefined}
        onTouchCancel={onHeaderRequestMenu ? longPress.onTouchCancel : undefined}
      >
        {icon && (
          <span
            aria-hidden
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              color: 'var(--text-faint)',
              flexShrink: 0,
            }}
          >
            {icon}
          </span>
        )}
        <span
          style={{
            fontSize: 10,
            fontWeight: 500,
            color: 'var(--text-faint)',
            letterSpacing: '0.04em',
            marginRight: 'auto',
          }}
        >
          {title}
        </span>
        {onAdd && (
          <span className="mt-section-add">
            <IconButton
              size="sm"
              variant="subtle"
              onClick={(e) => {
                e.stopPropagation();
                onAdd();
              }}
              label={`Add ${title.toLowerCase()}`}
            >
              <Plus size={11} />
            </IconButton>
          </span>
        )}
        {shortcut && (
          <span style={{ fontSize: 10, color: 'var(--text-faint)', letterSpacing: '0.04em' }}>
            {shortcut}
          </span>
        )}
      </div>
      <div
        className={scrollMaxHeight ? 'mt-scroll' : undefined}
        style={
          scrollMaxHeight
            ? {
              maxHeight: scrollMaxHeight,
              overflowY: 'auto',
              // Visible so selected open-right strokes can bleed to the panel edge.
              overflowX: 'visible',
            }
            : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}
