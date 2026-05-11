import React, { useEffect, useState } from 'react';

// Emoticon states each "agent" cycles through. All 3 chars wide so they
// slot cleanly into the fixed-width cells.
const FACES = [
  '>_<', // focused / struggling
  '^_^', // task complete
  'o_o', // surprised
  '-_-', // idle
  '._.', // thinking
  '0_0', // watching output
  '>u<', // delighted
  'zzz', // sleeping
  '...', // typing
  'OvO', // excited
  '*_*', // dazzled
  'T_T', // error
];

// One color per agent — uses the Obsidian palette: amber + live + err + white.
// All four are on-brand under the manifesto's "no blue" rule and keep the
// four cells visually distinct.
const CELL_COLORS = [
  'var(--accent-amber)',
  'var(--status-running)',
  'var(--text-primary)',
  'var(--status-error)',
];

function pickDifferent(prev: string): string {
  let next: string;
  do {
    next = FACES[Math.floor(Math.random() * FACES.length)];
  } while (next === prev);
  return next;
}

export function LogoArt() {
  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const [faces, setFaces] = useState<string[]>(() => [
    FACES[0],
    FACES[4],
    FACES[2],
    FACES[8],
  ]);

  useEffect(() => {
    if (reducedMotion) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    // Each tick: flip one random cell to a new face, then reschedule with
    // a jittered delay so the four agents fall out of sync and the grid
    // never reads as a single rhythm.
    const scheduleNext = () => {
      if (cancelled) return;
      const delay = 550 + Math.random() * 950;
      timer = setTimeout(() => {
        if (cancelled) return;
        setFaces((prev) => {
          const next = [...prev];
          const i = Math.floor(Math.random() * 4);
          next[i] = pickDifferent(prev[i]);
          return next;
        });
        scheduleNext();
      }, delay);
    };
    scheduleNext();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [reducedMotion]);

  const preStyle: React.CSSProperties = {
    margin: 0,
    fontFamily: 'monospace',
    fontSize: 10,
    lineHeight: 1.1,
    letterSpacing: 0,
    whiteSpace: 'pre',
    color: 'var(--text-faint)', // border chars
    userSelect: 'none',
    WebkitUserSelect: 'none',
  };

  const face = (i: number) => (
    <span
      style={{
        color: CELL_COLORS[i],
        fontWeight: 700,
        transition: 'color var(--dur-fast) var(--ease-out)',
      }}
    >
      {faces[i]}
    </span>
  );

  return (
    <pre aria-hidden style={preStyle}>
      {'\u250C\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2510\n\u2502'}
      {face(0)}
      {'\u2502'}
      {face(1)}
      {'\u2502\n\u251C\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2524\n\u2502'}
      {face(2)}
      {'\u2502'}
      {face(3)}
      {'\u2502\n\u2514\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2518'}
    </pre>
  );
}
