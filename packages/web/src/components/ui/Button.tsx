import React, { forwardRef } from 'react';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  loading?: boolean;
  block?: boolean;
}

const SIZE: Record<ButtonSize, React.CSSProperties> = {
  xs: { padding: '0 8px', fontSize: 10.5, height: 20, gap: 4, letterSpacing: '0.06em' },
  sm: { padding: '0 12px', fontSize: 11, height: 24, gap: 5, letterSpacing: '0.06em' },
  md: { padding: '0 14px', fontSize: 12, height: 28, gap: 6, letterSpacing: '0.06em' },
};

interface VariantStyle {
  base: React.CSSProperties;
  hover: React.CSSProperties;
  labelUnderline?: string;
}

function variantStyle(variant: ButtonVariant): VariantStyle {
  switch (variant) {
    case 'primary':
      return {
        base: {
          backgroundColor: 'transparent',
          color: 'var(--text-primary)',
          border: '1px solid var(--accent-amber)',
        },
        hover: { backgroundColor: 'color-mix(in srgb, var(--accent-amber) 10%, transparent)' },
        labelUnderline: 'var(--accent-amber)',
      };
    case 'secondary':
      return {
        base: {
          backgroundColor: 'transparent',
          color: 'var(--text-secondary)',
          border: '1px solid var(--border-strong)',
        },
        hover: { backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)' },
      };
    case 'ghost':
      return {
        base: {
          backgroundColor: 'transparent',
          color: 'var(--text-muted)',
          border: '1px solid transparent',
        },
        hover: { backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)' },
      };
    case 'danger':
      return {
        base: {
          backgroundColor: 'transparent',
          color: 'var(--text-primary)',
          border: '1px solid var(--status-error)',
        },
        hover: { backgroundColor: 'color-mix(in srgb, var(--status-error) 12%, transparent)' },
        labelUnderline: 'var(--status-error)',
      };
  }
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'secondary',
      size = 'md',
      leftIcon,
      rightIcon,
      loading,
      block,
      children,
      disabled,
      style,
      onMouseEnter,
      onMouseLeave,
      onMouseDown,
      onMouseUp,
      ...rest
    },
    ref,
  ) {
    const [hover, setHover] = React.useState(false);
    const [active, setActive] = React.useState(false);
    const isDisabled = disabled || loading;
    const v = variantStyle(variant);

    const hoverExtras = hover && !isDisabled ? v.hover : {};
    const activeExtras: React.CSSProperties =
      active && !isDisabled ? { transform: 'translateY(1px)' } : {};

    const labelStyle: React.CSSProperties | undefined = v.labelUnderline
      ? {
          borderBottom: `1px solid ${v.labelUnderline}`,
          paddingBottom: 1,
          lineHeight: 1,
        }
      : { lineHeight: 1 };

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        onMouseEnter={(e) => { setHover(true); onMouseEnter?.(e); }}
        onMouseLeave={(e) => { setHover(false); setActive(false); onMouseLeave?.(e); }}
        onMouseDown={(e) => { setActive(true); onMouseDown?.(e); }}
        onMouseUp={(e) => { setActive(false); onMouseUp?.(e); }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          whiteSpace: 'nowrap',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          borderRadius: 'var(--radius-snug)',
          fontWeight: 500,
          textTransform: 'uppercase',
          fontFamily: 'inherit',
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          opacity: isDisabled ? 0.45 : 1,
          transition:
            'background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)',
          width: block ? '100%' : undefined,
          ...SIZE[size],
          ...v.base,
          ...hoverExtras,
          ...activeExtras,
          ...style,
        }}
        {...rest}
      >
        {loading ? <Spinner size="sm" /> : leftIcon}
        {children && <span style={labelStyle}>{children}</span>}
        {!loading && rightIcon}
      </button>
    );
  },
);
