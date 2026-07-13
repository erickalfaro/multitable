import React, { useEffect, useState } from 'react';
import { Icon } from '@iconify/react';
import {
  ensureIconSet,
  iconReady,
  normalizeGlyphId,
  parseGlyphId,
} from '../../lib/iconifyCatalog';

/**
 * Renders a stored project glyph id (`prefix:name` or legacy bare Lucide name).
 * Lazily loads the Iconify collection for that prefix on first paint.
 */
export function ProjectGlyphIcon({
  id,
  size = 16,
  className,
  style,
}: {
  id: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const norm = normalizeGlyphId(id);
  const parsed = parseGlyphId(norm);
  const [ready, setReady] = useState(() => iconReady(norm));

  useEffect(() => {
    if (!parsed) return;
    let cancelled = false;
    if (iconReady(norm)) {
      setReady(true);
      return;
    }
    setReady(false);
    ensureIconSet(parsed.prefix)
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [norm, parsed?.prefix]);

  const box: React.CSSProperties = {
    width: size,
    height: size,
    maxWidth: size,
    maxHeight: size,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    overflow: 'hidden',
    lineHeight: 0,
    ...style,
  };

  if (!parsed) {
    return <span aria-hidden className={className} style={box} />;
  }

  if (!ready) {
    return (
      <span
        aria-hidden
        className={className}
        style={{
          ...box,
          borderRadius: 3,
          background: 'color-mix(in oklch, var(--text-muted) 18%, transparent)',
        }}
      />
    );
  }

  return (
    <span className={className} style={box}>
      <Icon
        icon={`${parsed.prefix}:${parsed.name}`}
        width={size}
        height={size}
        style={{
          display: 'block',
          width: size,
          height: size,
          maxWidth: '100%',
          maxHeight: '100%',
          overflow: 'hidden',
        }}
      />
    </span>
  );
}
