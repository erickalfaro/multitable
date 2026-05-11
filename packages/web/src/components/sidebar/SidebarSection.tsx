import React, { useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { IconButton } from '../ui';

interface Props {
  title: string;
  shortcut?: string;
  onAdd?: () => void;
  children: React.ReactNode;
}

export function SidebarSection({ title, shortcut, onAdd, children }: Props) {
  const [collapsed, setCollapsed] = useState(false);

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
          gap: 6,
        }}
        onClick={() => setCollapsed(!collapsed)}
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
