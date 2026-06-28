import React from 'react';
import { StatusDot } from './StatusDot';
import { getLoaderComponent } from '../ui/loaders';
import { getProjectColor } from '../../lib/projectColor';
import type { ProcessState } from '../../lib/types';

interface Props {
  loaderVariant?: string | null;
  state: ProcessState;
  projectId: string;
  active?: boolean;
  isIdle?: boolean;
  size?: number;
}

export function SessionStatusLoader({
  loaderVariant,
  state,
  projectId,
  active,
  isIdle,
  size = 12,
}: Props) {
  if (state === 'errored') {
    return <StatusDot state={state} isIdle={isIdle} size={size} />;
  }

  const Loader = getLoaderComponent(loaderVariant);
  // Zen: project color resolved against the active theme's band. The legacy
  // hardcoded `false` here gave us the light-band variant regardless of
  // theme — fine when both themes used raw hex, broken under OKLCH band
  // discipline because the light-band (L=48) is too dark on the Zen canvas.
  // Picking up the document attribute set by applyThemeToDocument keeps
  // this side-effect-free + cheap (no store subscription on a per-row
  // sidebar loader). Falls back to dark when unset.
  const isDark =
    typeof document === 'undefined' ||
    document.documentElement.getAttribute('data-theme') !== 'light';
  const color = getProjectColor(projectId, isDark).stripe;
  const isActive = active ?? state === 'running';

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
      }}
    >
      <Loader
        size={size}
        dotSize={1.2}
        color={color}
        animated={isActive}
        className={isActive ? undefined : 'dmx-static-dim'}
        ariaLabel="Session activity"
      />
    </span>
  );
}
