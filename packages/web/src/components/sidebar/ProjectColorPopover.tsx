import React, { useEffect, useRef } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useIsDark } from '../../hooks/useIsDark';
import { RING_NAMES, getRingSwatch } from '../../lib/projectColor';

/**
 * Tiny hue picker opened from the project context menu's "Change color…".
 * One row of the 8 ring swatches plus an Auto reset; the choice persists to
 * GlobalConfig.ui.projectNav.colors via setProjectColorOverride. Same
 * outside-click + Escape dismissal as ContextMenu (and the same fixed
 * positioning / z-index so it sits above the rail's floating sheet).
 */
export function ProjectColorPopover({
  projectId,
  position,
  onClose,
}: {
  projectId: string;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const dark = useIsDark();
  const current = useAppStore((s) => s.projectNav.colors?.[projectId] ?? null);
  const setProjectColorOverride = useAppStore((s) => s.setProjectColorOverride);
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

  // Keep on screen (8 swatches ≈ 190px wide).
  let left = position.x;
  let top = position.y;
  const width = 200;
  const height = 68;
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
      <div style={{ display: 'flex', gap: 5 }}>
        {RING_NAMES.map((name) => (
          <button
            key={name}
            type="button"
            title={name}
            aria-label={`Set color ${name}`}
            onClick={() => {
              setProjectColorOverride(projectId, name);
              onClose();
            }}
            style={{
              width: 18,
              height: 18,
              padding: 0,
              borderRadius: '50%',
              background: getRingSwatch(name, dark),
              border: 'none',
              boxShadow:
                current === name
                  ? '0 0 0 2px var(--bg-elevated), 0 0 0 3.5px var(--text-primary)'
                  : 'none',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => {
          setProjectColorOverride(projectId, null);
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
        Auto (hash-derived)
      </button>
    </div>
  );
}
