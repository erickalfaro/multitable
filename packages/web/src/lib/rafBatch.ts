// Per-key requestAnimationFrame batcher. Multiple calls to `set(key, value)`
// within one frame coalesce to a single flush — the most-recent value for
// each key wins. Used by WS streaming handlers so chunky deltas (Codex emits
// 4–10 per frame) update the React store at most once per displayed frame.
//
// Latest-wins semantics are correct for cumulative streams: the daemon emits
// the entire current text on each delta (manager-side StreamBuffer), so
// dropping intermediate values just means we render the latest text. Order
// preservation is irrelevant.

type FlushFn<V> = (key: string, value: V) => void;

export function createRafBatch<V>(flushOne: FlushFn<V>) {
  const pending = new Map<string, V>();
  let rafId: number | null = null;

  const flush = () => {
    rafId = null;
    for (const [key, value] of pending) {
      try {
        flushOne(key, value);
      } catch (err) {
        console.error('[rafBatch] flush handler threw', err);
      }
    }
    pending.clear();
  };

  const set = (key: string, value: V) => {
    pending.set(key, value);
    if (rafId === null) {
      rafId = requestAnimationFrame(flush);
    }
  };

  // Cancel any pending flush. Useful in cleanup paths.
  const cancel = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    pending.clear();
  };

  // Force-flush right now. Use when downstream order matters (e.g. the
  // canonical message arrived and we want the streaming text to clear before
  // the bubble is re-keyed).
  const flushNow = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    flush();
  };

  // Drop any pending value for one key without flushing. Use when an
  // out-of-band event makes the queued delta obsolete (e.g. the canonical
  // message arrived — its text supersedes any stale streaming delta).
  const remove = (key: string) => {
    pending.delete(key);
  };

  return { set, cancel, flushNow, remove };
}
