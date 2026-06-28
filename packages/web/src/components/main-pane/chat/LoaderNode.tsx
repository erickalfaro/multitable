import React from 'react';
import { getLoaderComponent } from '../../ui/loaders';
import { getProjectColor } from '../../../lib/projectColor';

interface Props {
  loaderVariant?: string | null;
  projectId: string;
  /** True while a turn is in flight — the dot-matrix animates and the avatar
      uses the project color. False when idle — the avatar stays present but
      static and pale, anchoring the rail's terminal node. */
  active: boolean;
  /** Outer circle diameter. Defaults to 18px so the avatar reads as a
      "fattened" node at the same rail coordinate as the 7px agent dots. */
  size?: number;
}

export function LoaderNode({ loaderVariant, projectId, active, size = 18 }: Props) {
  const Loader = getLoaderComponent(loaderVariant);
  // Zen: theme-aware band picker (matches SessionStatusLoader). Pre-Zen
  // hardcoded `false` was harmless against hex colors but breaks against
  // band-anchored OKLCH where the light variant (L=48) doesn't read on the
  // dark canvas.
  const isDark =
    typeof document === 'undefined' ||
    document.documentElement.getAttribute('data-theme') !== 'light';
  const projectStripe = projectId ? getProjectColor(projectId, isDark).stripe : 'var(--accent)';
  const color = active ? projectStripe : 'var(--text-faint)';
  const innerSize = Math.round(size * 0.78);
  return (
    <span
      role="status"
      aria-label={active ? 'Agent working' : 'Agent idle'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'var(--bg-elevated)',
        border: `1px solid ${active ? 'var(--border-strong)' : 'var(--border)'}`,
        // Halo masks the rail line where the avatar sits so the line appears
        // to terminate cleanly at the node center.
        boxShadow: '0 0 0 1.5px var(--bg-primary)',
        flexShrink: 0,
        opacity: active ? 1 : 0.6,
        transition: 'opacity var(--dur-med) var(--ease-out), border-color var(--dur-med) var(--ease-out)',
      }}
    >
      <Loader
        size={innerSize}
        dotSize={2}
        color={color}
        animated={active}
        className={active ? undefined : 'dmx-static-dim'}
        ariaLabel={active ? 'Agent working' : 'Agent idle'}
      />
    </span>
  );
}
