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
  const color = getProjectColor(projectId, false).stripe;
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
