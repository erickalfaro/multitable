import React from 'react';

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  color?: string;
  style?: React.CSSProperties;
}

const SIZE_PX = { sm: 11, md: 14, lg: 22 } as const;

/**
 * ASCII spinner — rotates a `▌` glyph at 1Hz. Calmer than a CSS ring,
 * and on-brand with the rest of the terminal aesthetic.
 */
export function Spinner({ size = 'md', color = 'currentColor', style }: SpinnerProps) {
  const px = SIZE_PX[size];
  return (
    <span
      role="status"
      aria-label="Loading"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: px,
        height: px,
        fontFamily: 'inherit',
        fontSize: px,
        lineHeight: 1,
        color,
        animation: 'connection-spin 1s linear infinite',
        flexShrink: 0,
        ...style,
      }}
    >
      ▌
    </span>
  );
}
