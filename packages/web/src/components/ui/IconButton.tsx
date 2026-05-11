import React, { forwardRef } from 'react';

export type IconButtonSize = 'sm' | 'md' | 'lg';
export type IconButtonVariant = 'ghost' | 'subtle' | 'danger';

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  label?: string;
}

const BOX: Record<IconButtonSize, number> = { sm: 22, md: 26, lg: 32 };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { size = 'md', variant = 'ghost', label, children, style, onMouseEnter, onMouseLeave, disabled, title, ...rest },
    ref,
  ) {
    const [hover, setHover] = React.useState(false);
    const box = BOX[size];

    const baseColor =
      variant === 'danger' ? 'var(--status-error)' : 'var(--text-muted)';
    const hoverColor =
      variant === 'danger' ? 'var(--status-error)' : 'var(--text-primary)';
    const hoverBorder =
      variant === 'danger' ? 'var(--status-error)' : 'var(--border-strong)';
    const baseBorder = variant === 'subtle' ? 'var(--border-strong)' : 'transparent';

    return (
      <button
        ref={ref}
        disabled={disabled}
        title={title ?? label}
        aria-label={label ?? title}
        onMouseEnter={(e) => { setHover(true); onMouseEnter?.(e); }}
        onMouseLeave={(e) => { setHover(false); onMouseLeave?.(e); }}
        style={{
          width: box,
          height: box,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          background: hover && !disabled ? 'var(--bg-hover)' : variant === 'subtle' ? 'var(--bg-elevated)' : 'transparent',
          border: `1px solid ${hover && !disabled ? hoverBorder : baseBorder}`,
          color: hover && !disabled ? hoverColor : baseColor,
          borderRadius: 'var(--radius-snug)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          flexShrink: 0,
          transition:
            'background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
          ...style,
        }}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
