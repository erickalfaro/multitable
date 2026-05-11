import React from 'react';

export type BadgeVariant = 'default' | 'accent' | 'running' | 'warning' | 'error' | 'muted';
export type BadgeSize = 'sm' | 'md';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  /**
   * Solid mode is preserved for ABI compatibility but renders identically to
   * outline mode in the Essence design (1px box, no fills).
   */
  solid?: boolean;
}

function variantColor(variant: BadgeVariant): string {
  switch (variant) {
    case 'accent':
      return 'var(--accent-amber)';
    case 'running':
      return 'var(--status-running)';
    case 'warning':
      return 'var(--status-warning)';
    case 'error':
      return 'var(--status-error)';
    case 'muted':
      return 'var(--text-muted)';
    default:
      return 'var(--text-secondary)';
  }
}

const SIZE: Record<BadgeSize, React.CSSProperties> = {
  sm: { fontSize: 9.5, padding: '1px 6px', height: 16 },
  md: { fontSize: 10, padding: '2px 8px', height: 18 },
};

export function Badge({
  variant = 'default',
  size = 'sm',
  solid: _solid,
  style,
  children,
  ...rest
}: BadgeProps) {
  const color = variantColor(variant);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        userSelect: 'none',
        WebkitUserSelect: 'none',
        borderRadius: 'var(--radius-snug)',
        fontWeight: 500,
        color,
        backgroundColor: 'transparent',
        border: `1px solid ${color}`,
        textTransform: 'uppercase',
        letterSpacing: '0.14em',
        lineHeight: 1,
        whiteSpace: 'nowrap',
        ...SIZE[size],
        ...style,
      }}
      {...rest}
    >
      {children}
    </span>
  );
}
