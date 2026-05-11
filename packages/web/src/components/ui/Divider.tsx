import React from 'react';

interface DividerProps {
  label?: React.ReactNode;
  margin?: number | string;
  style?: React.CSSProperties;
}

export function Divider({ label, margin = 12, style }: DividerProps) {
  if (!label) {
    return (
      <div
        style={{
          height: 1,
          backgroundColor: 'var(--border)',
          margin: typeof margin === 'number' ? `${margin}px 0` : margin,
          ...style,
        }}
      />
    );
  }
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: typeof margin === 'number' ? `${margin}px 0` : margin,
        color: 'var(--text-muted)',
        fontSize: 10,
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.18em',
        ...style,
      }}
    >
      <div style={{ flex: '0 0 16px', height: 1, backgroundColor: 'var(--border)' }} />
      <span>{label}</span>
      <div style={{ flex: 1, height: 1, backgroundColor: 'var(--border)' }} />
    </div>
  );
}
