import React from 'react';

interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode;
}

export function Kbd({ children, style, ...rest }: KbdProps) {
  return (
    <kbd
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        minWidth: 18,
        height: 18,
        padding: '0 5px',
        fontFamily: 'inherit',
        fontSize: 10,
        fontWeight: 500,
        color: 'var(--text-muted)',
        backgroundColor: 'transparent',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-snug)',
        boxShadow: 'none',
        lineHeight: 1,
        letterSpacing: '0.05em',
        ...style,
      }}
      {...rest}
    >
      {children}
    </kbd>
  );
}
