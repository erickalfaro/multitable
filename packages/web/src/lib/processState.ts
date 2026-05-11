import type { ManagedProcess, ProcessState } from './types';

// Sessions sit in `stopped` between turns — that's the resting "ready for input"
// state, not a dead state. Commands/terminals only count as alive while their
// PTY is up (`running` or `idle`). `errored` is dead for both.
export function isProcessActive(process: ManagedProcess): boolean {
  if (process.type === 'session') return process.state !== 'errored';
  return process.state === 'running' || process.state === 'idle';
}

export function isProcessActiveByState(type: ManagedProcess['type'], state: ProcessState): boolean {
  if (type === 'session') return state !== 'errored';
  return state === 'running' || state === 'idle';
}
