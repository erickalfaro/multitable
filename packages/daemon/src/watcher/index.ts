import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import {
  watchBackendOptions,
  pollingBackendOptions,
  canFallBackToPolling,
  notePollingFallback,
  isWatchResourceError,
} from '../watch-options.js';

type FSWatcher = ReturnType<typeof chokidar.watch>;

interface WatchEntry {
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
  fallingBack?: boolean;
}

const DEBOUNCE_MS = 500;

export class FileWatcher {
  private processWatchers = new Map<string, WatchEntry>();
  private mtYmlWatchers = new Map<string, FSWatcher>();

  /**
   * Watch mt.yml in a project directory. Calls onChange when the file changes.
   */
  watchMtYml(projectPath: string, onChange: () => void): void {
    const existing = this.mtYmlWatchers.get(projectPath);
    if (existing) {
      existing.close();
    }

    const mtYmlPath = path.join(projectPath, 'mt.yml');
    // chokidar 3 on Windows crashes (`Cannot read properties of undefined
    // (reading 'close')` inside nodefs-handler.js) when asked to watch a
    // non-existent file with persistent:false — fs.watch returns undefined
    // and chokidar dereferences it. Most projects don't have an mt.yml, so
    // skip silently rather than throw an unhandled rejection at startup.
    if (!fs.existsSync(mtYmlPath)) return;

    const watcher = chokidar.watch(mtYmlPath, {
      ...watchBackendOptions(),
      persistent: false,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    watcher.on('change', onChange);
    watcher.on('add', onChange);
    watcher.on('error', (err) => {
      console.error(`[watcher] mt.yml watcher error (${projectPath}):`, err);
    });

    this.mtYmlWatchers.set(projectPath, watcher);
  }

  /**
   * Watch file patterns for a process. Debounces calls to onChanged.
   */
  watchPatterns(
    processId: string,
    patterns: string[],
    cwd: string,
    onChanged: () => void,
    opts: { forcePolling?: boolean } = {}
  ): void {
    // Stop existing watcher for this process
    this.unwatchProcess(processId);

    if (!patterns || patterns.length === 0) return;

    const globPatterns = patterns.map((p) =>
      path.isAbsolute(p) ? p : path.join(cwd, p)
    );

    const watcher = chokidar.watch(globPatterns, {
      ...(opts.forcePolling ? pollingBackendOptions() : watchBackendOptions()),
      persistent: false,
      ignoreInitial: true,
      cwd,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: ['**/node_modules/**', '**/.git/**'],
    });

    const entry: WatchEntry = { watcher, timer: null };

    const debounced = () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        onChanged();
      }, DEBOUNCE_MS);
    };

    watcher.on('change', debounced);
    watcher.on('add', debounced);
    watcher.on('unlink', debounced);
    watcher.on('error', (err) => {
      // OS watch budget exhausted: recreate this watch on the polling backend
      // (once) and flip the process-wide sticky fallback for future attaches.
      if (isWatchResourceError(err)) {
        if (!opts.forcePolling && canFallBackToPolling() && !entry.fallingBack) {
          entry.fallingBack = true;
          notePollingFallback(cwd);
          this.watchPatterns(processId, patterns, cwd, onChanged, { forcePolling: true });
          return;
        }
        console.warn(
          `[watcher] filesystem watch limit reached for process ${processId}; ` +
            'some files will not be watched.'
        );
        return;
      }
      console.error(`[watcher] pattern watcher error (${processId}):`, err);
    });

    this.processWatchers.set(processId, entry);
  }

  /**
   * Stop watching files for a specific process.
   */
  unwatchProcess(processId: string): void {
    const entry = this.processWatchers.get(processId);
    if (!entry) return;

    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close().catch(() => {});
    this.processWatchers.delete(processId);
  }

  /**
   * Stop all watchers.
   */
  unwatchAll(): void {
    for (const [id] of this.processWatchers) {
      this.unwatchProcess(id);
    }
    for (const [, watcher] of this.mtYmlWatchers) {
      watcher.close().catch(() => {});
    }
    this.mtYmlWatchers.clear();
  }
}
