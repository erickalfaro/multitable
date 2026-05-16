import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

export interface GitMenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  separatorBefore?: boolean;
}

interface Props {
  items: GitMenuItem[];
}

export function GitActionMenu({ items }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="More Actions"
        style={iconBtn}
      >
        <MoreHorizontal size={13} />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 200,
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-soft)',
            padding: 4,
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 4px 14px rgba(0, 0, 0, 0.18)',
          }}
        >
          {items.map((item, i) => (
            <div key={i}>
              {item.separatorBefore && (
                <div
                  style={{
                    height: 1,
                    backgroundColor: 'var(--border)',
                    margin: '4px 0',
                  }}
                />
              )}
              <button
                type="button"
                onClick={() => {
                  if (item.disabled) return;
                  setOpen(false);
                  item.onClick();
                }}
                disabled={item.disabled}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  padding: '6px 10px',
                  fontSize: 12,
                  textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  color: item.disabled ? 'var(--text-muted)' : 'var(--text-primary)',
                  cursor: item.disabled ? 'default' : 'pointer',
                  borderRadius: 'var(--radius-snug)',
                  opacity: item.disabled ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!item.disabled) e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                {item.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  borderRadius: 'var(--radius-snug)',
};
