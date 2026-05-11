import React, { forwardRef } from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  invalid?: boolean;
  wrapperStyle?: React.CSSProperties;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input(
    { leftIcon, rightIcon, invalid, wrapperStyle, style, disabled, ...rest },
    ref,
  ) {
    const [focus, setFocus] = React.useState(false);
    const borderColor = invalid
      ? 'var(--status-error)'
      : focus
        ? 'var(--accent-amber)'
        : 'var(--border-strong)';

    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: leftIcon || rightIcon ? '0 10px' : 0,
          backgroundColor: disabled ? 'var(--bg-sidebar)' : 'var(--bg-elevated)',
          border: `1px solid ${borderColor}`,
          borderRadius: 'var(--radius-snug)',
          transition: 'border-color var(--dur-fast) var(--ease-out)',
          opacity: disabled ? 0.65 : 1,
          ...wrapperStyle,
        }}
      >
        {leftIcon && (
          <span
            style={{
              display: 'inline-flex',
              color: 'var(--text-muted)',
              flexShrink: 0,
            }}
          >
            {leftIcon}
          </span>
        )}
        <input
          ref={ref}
          disabled={disabled}
          onFocus={(e) => { setFocus(true); rest.onFocus?.(e); }}
          onBlur={(e) => { setFocus(false); rest.onBlur?.(e); }}
          {...rest}
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontFamily: 'inherit',
            fontSize: 12,
            caretColor: 'var(--accent-amber)',
            padding: leftIcon || rightIcon ? '6px 0' : '6px 10px',
            minWidth: 0,
            ...style,
          }}
        />
        {rightIcon && (
          <span
            style={{
              display: 'inline-flex',
              color: 'var(--text-muted)',
              flexShrink: 0,
            }}
          >
            {rightIcon}
          </span>
        )}
      </div>
    );
  },
);
