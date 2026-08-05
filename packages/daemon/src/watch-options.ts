// Shared chokidar backend selection for every filesystem watcher in the daemon.
//
// Native OS file events (inotify on Linux, FSEvents on macOS,
// ReadDirectoryChangesW on Windows) are free once registered. Polling
// (`usePolling`) costs one stat() per watched file per interval — on a project
// tree with tens of thousands of files that is tens of thousands of syscalls
// per second through libuv's small thread pool, which starves every other
// async FS operation in the daemon (transcript reads, file-tree API, git).
//
// The catch is Linux's per-user inotify budget (`fs.inotify.max_user_watches`
// / `max_user_instances`): a host running many watchers exhausts it and
// chokidar throws ENOSPC (or EMFILE when fd limits are hit on any OS).
//
// Strategy: native by default; the first watcher that hits a resource error
// flips a sticky process-wide flag so every subsequent (re-)attach uses
// polling instead. Callers recreate their broken watcher on the polling
// backend via `pollingBackendOptions()`.
//
//   MULTITABLE_WATCH_POLL=1     force polling everywhere (pre-native behavior)
//   MULTITABLE_WATCH_NATIVE=1   force native, never fall back
//   MULTITABLE_WATCH_INTERVAL   polling cadence in ms (default 1000)

const interval = Number(process.env.MULTITABLE_WATCH_INTERVAL) || 1000;

const forcedMode: 'native' | 'polling' | null =
  process.env.MULTITABLE_WATCH_POLL === '1'
    ? 'polling'
    : process.env.MULTITABLE_WATCH_NATIVE === '1'
      ? 'native'
      : null;

/** Once true, every subsequent watcher attach uses the polling backend. */
let stickyPolling = false;
let warnedFallback = false;

/**
 * Spread into a `chokidar.watch(..., { ...pollingBackendOptions(), ... })`
 * call to force the stat-polling backend for that watcher.
 */
export function pollingBackendOptions(): Record<string, unknown> {
  return {
    usePolling: true,
    interval,
    // Binary/large files poll half as often — they change less and stat'ing
    // them is the same cost as a text file but matters less for freshness.
    binaryInterval: interval * 2,
  };
}

/**
 * Spread into a `chokidar.watch(..., { ...watchBackendOptions(), ... })` call.
 * Native OS events unless polling is forced (env) or a prior watcher hit the
 * inotify/fd budget and flipped the sticky fallback.
 */
export function watchBackendOptions(): Record<string, unknown> {
  if (forcedMode === 'polling' || (forcedMode === null && stickyPolling)) {
    return pollingBackendOptions();
  }
  return {};
}

/** Whether a resource-exhausted native watcher may recreate itself on polling. */
export function canFallBackToPolling(): boolean {
  return forcedMode !== 'native';
}

/**
 * Record that a native watcher exhausted the OS watch budget. Flips the sticky
 * process-wide polling fallback and warns once.
 */
export function notePollingFallback(context: string): void {
  stickyPolling = true;
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn(
      `[watch] OS file-watch budget exhausted (${context}); ` +
        'falling back to stat-polling for filesystem watchers. ' +
        'Raise fs.inotify.max_user_watches (Linux) or set MULTITABLE_WATCH_POLL=1 to silence.',
    );
  }
}

/**
 * True when a watcher error is the inotify/fd-exhaustion family. These are
 * expected on busy hosts and must be handled (fallback or warn-once) rather
 * than flooding the log or bubbling into an unhandled rejection.
 */
export function isWatchResourceError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOSPC' || code === 'EMFILE' || code === 'ENFILE';
}
