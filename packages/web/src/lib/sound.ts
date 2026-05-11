let sharedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (sharedCtx) return sharedCtx;
  const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  try {
    sharedCtx = new Ctor();
    return sharedCtx;
  } catch {
    return null;
  }
}

function playTones(tones: { freq: number; start: number; dur: number; peak: number }[]): void {
  const ctx = getCtx();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    for (const t of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = t.freq;
      gain.gain.setValueAtTime(0, now + t.start);
      gain.gain.linearRampToValueAtTime(t.peak, now + t.start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t.start + t.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + t.start);
      osc.stop(now + t.start + t.dur + 0.02);
    }
  } catch {
    // ignore audio errors
  }
}

export function playPermissionChime(): void {
  playTones([
    { freq: 880, start: 0, dur: 0.14, peak: 0.05 },
    { freq: 1320, start: 0.09, dur: 0.22, peak: 0.04 },
  ]);
}

// Rising two-tone — Claude is waiting on the user.
export function playAttentionChime(): void {
  playTones([
    { freq: 660, start: 0, dur: 0.14, peak: 0.05 },
    { freq: 990, start: 0.1, dur: 0.2, peak: 0.05 },
  ]);
}

// Soft descending two-tone — Claude finished its turn.
export function playDoneChime(): void {
  playTones([
    { freq: 784, start: 0, dur: 0.12, peak: 0.04 },
    { freq: 523, start: 0.09, dur: 0.22, peak: 0.04 },
  ]);
}

// Single tone, mid pitch — non-fatal warning.
export function playWarningChime(): void {
  playTones([
    { freq: 587, start: 0, dur: 0.16, peak: 0.05 },
    { freq: 466, start: 0.12, dur: 0.22, peak: 0.045 },
  ]);
}

// Two falling tones, low — error / failure.
export function playErrorChime(): void {
  playTones([
    { freq: 392, start: 0, dur: 0.18, peak: 0.06 },
    { freq: 261, start: 0.14, dur: 0.28, peak: 0.06 },
  ]);
}
