import { useCallback, useRef } from 'react';

const HOLD_MS = 500;
// Cancel the press if the finger drifts more than this (a scroll, not a hold).
const MOVE_TOLERANCE_PX = 10;

interface LongPressHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}

/**
 * Fires `callback` after the user holds a touch in place for ~500ms. Cancelled
 * if the touch ends early or the finger drifts (a scroll gesture). Touch-only —
 * desktop uses hover-revealed buttons instead. Returns handlers to spread onto
 * the target element.
 */
export function useLongPress(callback: () => void): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      origin.current = { x: t.clientX, y: t.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        callback();
      }, HOLD_MS);
    },
    [callback],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!origin.current) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = Math.abs(t.clientX - origin.current.x);
      const dy = Math.abs(t.clientY - origin.current.y);
      if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) clear();
    },
    [clear],
  );

  return { onTouchStart, onTouchMove, onTouchEnd: clear, onTouchCancel: clear };
}
