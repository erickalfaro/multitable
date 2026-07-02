import React, { forwardRef } from 'react';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  padding?: number | string;
  /** Retained for ABI compatibility; all variants render with --radius-soft. */
  radius?: 'md' | 'lg' | 'xl';
  elevated?: boolean;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { interactive, padding = 14, radius: _radius, elevated = true, style, onMouseEnter, onMouseLeave, ...rest },
  ref,
) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      ref={ref}
      onMouseEnter={(e) => { setHover(true); onMouseEnter?.(e); }}
      onMouseLeave={(e) => { setHover(false); onMouseLeave?.(e); }}
      style={{
        backgroundColor: elevated ? 'var(--glass-bg)' : 'var(--glass-bg-soft)',
        border: `1px solid ${interactive && hover ? 'var(--accent-amber)' : 'var(--glass-border)'}`,
        borderRadius: 'var(--radius-soft)',
        boxShadow: 'inset 0 1px 0 var(--glass-highlight)',
        padding,
        transition: 'border-color var(--dur-fast) var(--ease-out)',
        cursor: interactive ? 'pointer' : 'default',
        userSelect: interactive ? 'none' : undefined,
        WebkitUserSelect: interactive ? 'none' : undefined,
        ...style,
      }}
      {...rest}
    />
  );
});
