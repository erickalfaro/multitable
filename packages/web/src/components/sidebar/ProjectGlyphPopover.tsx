import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../../stores/appStore';
import { PROJECT_GLYPHS } from '../../lib/projectGlyph';

/**
 * Glyph picker opened from the project context menu's "Change glyph…".
 * Replaces the rail acronym when a glyph is chosen; "Acronym" resets to
 * auto-derived initials. Persists via projectNav.glyphs.
 */
export function ProjectGlyphPopover({
  projectId,
  position,
  onClose,
}: {
  projectId: string;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const current = useAppStore((s) => s.projectNav.glyphs?.[projectId] ?? null);
  const setProjectGlyphOverride = useAppStore((s) => s.setProjectGlyphOverride);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // ~8 columns × 22px + gaps ≈ 220px wide; ~4 rows + footer.
  let left = position.x;
  let top = position.y;
  const width = 228;
  const height = 168;
  if (left + width > window.innerWidth) left = window.innerWidth - width - 8;
  if (top + height > window.innerHeight) top = window.innerHeight - height - 8;
  if (left < 0) left = 8;
  if (top < 0) top = 8;

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 2000,
        width,
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-lg)',
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        animation: 'mt-scale-in var(--dur-fast) var(--ease-out)',
        transformOrigin: 'top left',
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.04em',
          color: 'var(--text-faint)',
          padding: '0 2px',
        }}
      >
        Project glyph
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(8, 1fr)',
          gap: 4,
        }}
      >
        {PROJECT_GLYPHS.map(({ id, label, Icon }) => {
          const selected = current === id;
          return (
            <button
              key={id}
              type="button"
              title={label}
              aria-label={`Set glyph ${label}`}
              aria-pressed={selected}
              onClick={() => {
                setProjectGlyphOverride(projectId, id);
                onClose();
              }}
              style={{
                width: 24,
                height: 24,
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 6,
                border: 'none',
                background: selected
                  ? 'color-mix(in oklch, var(--space-accent) 18%, transparent)'
                  : 'transparent',
                color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
                boxShadow: selected
                  ? '0 0 0 1px color-mix(in oklch, var(--space-accent) 50%, transparent)'
                  : 'none',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                if (!selected) {
                  e.currentTarget.style.background =
                    'color-mix(in oklch, var(--text-primary) 6%, transparent)';
                }
              }}
              onMouseLeave={(e) => {
                if (!selected) e.currentTarget.style.background = 'transparent';
              }}
            >
              <Icon size={14} strokeWidth={1.75} />
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => {
          setProjectGlyphOverride(projectId, null);
          onClose();
        }}
        style={{
          padding: '4px 8px',
          fontSize: 12,
          fontFamily: 'inherit',
          textAlign: 'left',
          background: 'transparent',
          border: 'none',
          borderRadius: 'var(--radius-md)',
          color: current === null ? 'var(--text-primary)' : 'var(--text-muted)',
          fontWeight: current === null ? 600 : 400,
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--bg-hover)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
        }}
      >
        Acronym (auto)
      </button>
    </div>
  );
}
