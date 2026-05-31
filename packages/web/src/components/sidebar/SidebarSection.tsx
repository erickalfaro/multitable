import React, { useRef, useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { IconButton } from '../ui';
import { useLongPress } from '../../lib/useLongPress';

interface Props {
  title: string;
  shortcut?: string;
  onAdd?: () => void;
  // Called when the header is right-clicked (desktop) or long-pressed (mobile,
  // 500ms hold). The coords are in client space — pass them straight to a
  // <ContextMenu position={...}>. On long-press we suppress the synthetic
  // touch-end click so the section doesn't also collapse.
  onHeaderRequestMenu?: (x: number, y: number) => void;
  children: React.ReactNode;
}

export function SidebarSection({
  title,
  shortcut,
  onAdd,
  onHeaderRequestMenu,
  children,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);

  // Long-press support for mobile. useLongPress's callback gets no event, so
  // stash the touch coords in a ref and read them when the timer fires.
  // `longPressFired` tells the click handler to swallow the synthetic click
  // that would otherwise collapse the section right after the menu opens.
  const lastTouch = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const longPressFired = useRef(false);
  const longPress = useLongPress(() => {
    if (onHeaderRequestMenu) {
      longPressFired.current = true;
      onHeaderRequestMenu(lastTouch.current.x, lastTouch.current.y);
    }
  });

  return (
    <div style={{ marginTop: 20 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '4px 10px 4px 12px',
          cursor: 'pointer',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
          gap: 6,
        }}
        onClick={() => {
          if (longPressFired.current) {
            longPressFired.current = false;
            return;
          }
          setCollapsed(!collapsed);
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
        <ChevronRight
          size={11}
          style={{
            color: 'var(--text-faint)',
            flexShrink: 0,
            transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
            transition: 'transform var(--dur-fast) var(--ease-out)',
          }}
        />
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 500,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
            marginRight: 'auto',
          }}
        >
          {title}
        </span>
        {onAdd && (
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
        )}
        {shortcut && (
          <span style={{ fontSize: 10, color: 'var(--text-faint)', letterSpacing: '0.04em' }}>
            {shortcut}
          </span>
        )}
      </div>
      <div
        style={{
          maxHeight: collapsed ? 0 : undefined,
          overflow: 'hidden',
          transition: 'max-height var(--dur-med) var(--ease-out)',
        }}
      >
        {!collapsed && children}
      </div>
    </div>
  );
}
