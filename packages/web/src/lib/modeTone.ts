import type { ModeOption, ModeTone, Session } from './types';

// Maps a mode's risk tier to a theme-aware CSS color expression. Reuses the
// existing status/accent tokens; only `elevated` (orange) is derived since the
// theme has no dedicated orange between amber and red. `standard` is the
// fallback for any mode that hasn't declared a tone (older sessions, future
// providers) so the affordance always has a sensible color.
export function modeToneColor(tone: ModeTone | undefined): string {
  switch (tone) {
    case 'safe':
      return 'var(--status-running)'; // green
    case 'elevated':
      return 'color-mix(in srgb, var(--accent-amber) 55%, var(--status-error))'; // orange
    case 'danger':
      return 'var(--status-error)'; // red
    case 'standard':
    default:
      return 'var(--accent-amber)'; // amber
  }
}

// Resilience fallback for the built-in providers' well-known mode values. The
// adapter-declared `tone` (capabilities.modes[].tone) is authoritative and
// always wins; this only kicks in when the session in the store predates the
// `tone` field (e.g. a daemon that hasn't been rebuilt yet, or a cached session
// payload). Keep it in sync with the adapter declarations in
// packages/daemon/src/agent/providers/{claude,codex,hermes}.ts.
const MODE_TONE_FALLBACK: Record<string, ModeTone> = {
  // Claude PermissionMode
  default: 'standard',
  acceptEdits: 'elevated',
  auto: 'elevated',
  plan: 'safe',
  bypassPermissions: 'danger',
  dontAsk: 'danger',
  // Codex SandboxMode
  'workspace-write': 'elevated',
  'read-only': 'safe',
  'danger-full-access': 'danger',
};

// Tone for a single mode option: adapter-declared `tone` wins, else the
// built-in fallback by value, else 'standard'. Used by the mode dropdown so
// every row's risk dot is correct even without a fresh `tone` from the daemon.
export function modeOptionTone(opt: ModeOption): ModeTone {
  return opt.tone ?? MODE_TONE_FALLBACK[opt.value] ?? 'standard';
}

// Resolves the active mode's tone by looking the session's current `mode` up in
// its adapter-declared `capabilities.modes`, then falling back to the built-in
// map by mode value, then to 'standard'. The fallback means the send button
// recolors per mode even against a session payload that has no `tone` yet.
export function resolveModeTone(session: Session | undefined | null): ModeTone {
  if (!session) return 'standard';
  const opt = session.capabilities?.modes?.find((m) => m.value === session.mode);
  return opt?.tone ?? MODE_TONE_FALLBACK[session.mode] ?? 'standard';
}
