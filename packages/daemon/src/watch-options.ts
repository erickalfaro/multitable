// Shared chokidar tuning for every filesystem watcher in the daemon.
//
// On Linux, chokidar's default backend is inotify, which allocates one kernel
// watch handle per watched file/dir. A machine running many watchers (several
// dev servers, editors, plus this daemon watching every registered project's
// working tree) exhausts the per-user inotify budget — `fs.inotify.max_user_watches`
// / `max_user_instances` — and chokidar starts throwing `ENOSPC` / `EMFILE`,
// in some cases crashing deep in its nodefs-handler.
//
// Polling sidesteps inotify completely (it stat()s on an interval), so the
// daemon keeps working regardless of the system's inotify limits. The cost is
// CPU, but with the aggressive `ignored` lists each watcher already carries
// (node_modules, dist, venvs, .git internals, gitignored trees) and a relaxed
// interval, a git-status / mt.yml watcher polling is cheap enough for a local
// dev tool — and it's already debounced downstream.
//
// Default: polling ON. Opt back into native inotify with MULTITABLE_WATCH_NATIVE=1
// (only sensible when the host's inotify limits are comfortably high). Tune the
// cadence with MULTITABLE_WATCH_INTERVAL (ms, default 1000).

const useNative = process.env.MULTITABLE_WATCH_NATIVE === '1';
const interval = Number(process.env.MULTITABLE_WATCH_INTERVAL) || 1000;

/**
 * Spread into a `chokidar.watch(..., { ...watchBackendOptions(), ... })` call.
 * Returns the polling backend options unless native inotify is opted into.
 */
export function watchBackendOptions(): Record<string, unknown> {
  if (useNative) return {};
  return {
    usePolling: true,
    interval,
    // Binary/large files poll half as often — they change less and stat'ing
    // them is the same cost as a text file but matters less for freshness.
    binaryInterval: interval * 2,
  };
}

/**
 * True when a watcher error is the inotify-exhaustion family. These are
 * expected on busy hosts and must be swallowed (logged at most once) rather
 * than flooding the log or bubbling into an unhandled rejection.
 */
export function isWatchResourceError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOSPC' || code === 'EMFILE' || code === 'ENFILE';
}
