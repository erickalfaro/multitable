import React from 'react';
import type { ProcessState } from '../../lib/types';

interface Props {
  state: ProcessState;
  isIdle?: boolean; // for session running-but-idle state
  size?: number;
}

interface GlyphSpec {
  glyph: string;
  color: string;
}

function pick(state: ProcessState, isIdle: boolean | undefined): GlyphSpec {
  if (state === 'running' && isIdle) {
    return { glyph: '○', color: 'var(--status-idle)' };
  }
  if (state === 'running') {
    return { glyph: '●', color: 'var(--status-running)' };
  }
  if (state === 'errored') {
    return { glyph: '⊘', color: 'var(--status-error)' };
  }
  if (state === 'stopped') {
    return { glyph: '⊗', color: 'var(--status-stopped)' };
  }
  // idle (transitional / starting)
  return { glyph: '◐', color: 'var(--status-warning)' };
}

export function StatusDot({ state, isIdle, size = 10 }: Props) {
  const { glyph, color } = pick(state, isIdle);
  // Bump glyph rendering size relative to the legacy circle size so the
  // character feels in line with surrounding text.
  const fontSize = Math.max(11, Math.round(size * 1.3));
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
        fontFamily: 'inherit',
        fontSize,
        lineHeight: 1,
        color,
      }}
    >
      {glyph}
    </span>
  );
}
