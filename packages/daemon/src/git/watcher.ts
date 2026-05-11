import chokidar from 'chokidar';
import path from 'path';
import { getStatusSummary, isGitRepo } from './index.js';
import type { GitStatusSummary } from '../types.js';

type FSWatcher = ReturnType<typeof chokidar.watch>;

interface WatchEntry {
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
  inflight: boolean;
}

const DEBOUNCE_MS = 500;

// Mirrors the FileWatcher pattern. One watcher per project; on any debounced
// filesystem change inside the working tree we recompute status and emit it.
// We DO NOT ignore all of `.git/` because we want HEAD/index changes (commits,
// branch switches, stash, etc.) to refresh the UI — but we ignore the noisy
// subdirs (.git/objects, .git/logs) that churn on every git operation.
export class GitWatcher {
  private watchers = new Map<string, WatchEntry>();
  private onStatus: (projectId: string, status: GitStatusSummary) => void;

  constructor(onStatus: (projectId: string, status: GitStatusSummary) => void) {
    this.onStatus = onStatus;
  }

  watch(projectId: string, projectPath: string): void {
    this.unwatch(projectId);
    if (!isGitRepo(projectPath)) return;

    const watcher = chokidar.watch(projectPath, {
      persistent: false,
      ignoreInitial: true,
      ignored: [
        '**/node_modules/**',
        '**/.vite/**',           // Vite dev-server cache; rewrites constantly during HMR
        '**/.turbo/**',
        '**/.parcel-cache/**',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/.cache/**',
        path.join(projectPath, '.git', 'objects', '**'),
        path.join(projectPath, '.git', 'logs', '**'),
        path.join(projectPath, '.git', 'lfs', '**'),
      ],
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    const entry: WatchEntry = { watcher, timer: null, inflight: false };
    const tick = () => this.refresh(projectId, projectPath, entry);

    const debounced = () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        void tick();
      }, DEBOUNCE_MS);
    };

    watcher.on('change', debounced);
    watcher.on('add', debounced);
    watcher.on('unlink', debounced);
    watcher.on('addDir', debounced);
    watcher.on('unlinkDir', debounced);

    this.watchers.set(projectId, entry);

    // Emit an initial status so subscribers don't have to fetch separately.
    void tick();
  }

  unwatch(projectId: string): void {
    const entry = this.watchers.get(projectId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close().catch(() => {});
    this.watchers.delete(projectId);
  }

  unwatchAll(): void {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }

  // Recompute and broadcast. Drops overlapping ticks; the trailing edge of
  // the debounce window is what matters when a burst of writes lands.
  private async refresh(
    projectId: string,
    projectPath: string,
    entry: WatchEntry,
  ): Promise<void> {
    if (entry.inflight) return;
    entry.inflight = true;
    try {
      const status = await getStatusSummary(projectPath);
      this.onStatus(projectId, status);
    } catch {
      // Repos in transitional states (rebase mid-flight, etc.) can throw —
      // swallow and try again on the next tick.
    } finally {
      entry.inflight = false;
    }
  }
}
