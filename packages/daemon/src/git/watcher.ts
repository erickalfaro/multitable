import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import { getStatusSummary, isGitRepo } from './index.js';
import { watchBackendOptions, isWatchResourceError } from '../watch-options.js';
import type { GitStatusSummary } from '../types.js';

type FSWatcher = ReturnType<typeof chokidar.watch>;

interface WatchEntry {
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
  inflight: boolean;
  warnedResource?: boolean;
}

const DEBOUNCE_MS = 500;

// Read `.gitignore` at the project root and translate each pattern into the
// glob shape chokidar's `ignored` option expects. We don't need 100%-faithful
// gitignore semantics — the goal is "don't recursively walk into trees the user
// has already told git to ignore," so we err on the side of ignoring more.
// Without this, chokidar's initial recursive scan reads every entry in the
// working tree (even ones that match `ignored` patterns — those are post-stat
// filters in chokidar 3) and a project with millions of files in an ignored
// dir (e.g. `data/minute_level/` in an ML repo) OOMs the daemon at boot.
//
// Skips negations (`!...`) — chokidar can't un-ignore. Strips leading `/` and
// trailing `/`, then emits both `**/<pat>` and `**/<pat>/**` so the pattern
// catches the dir and everything beneath it. This is slightly broader than
// gitignore (a leading-slash anchored pattern will match at any depth here)
// but that's the safe side to err on for watcher exclusion.
function loadGitignorePatterns(projectPath: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(projectPath, '.gitignore'), 'utf8');
    const out: string[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('!')) continue;
      const cleaned = t.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!cleaned) continue;
      out.push(`**/${cleaned}`, `**/${cleaned}/**`);
    }
    return out;
  } catch {
    return [];
  }
}

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
      ...watchBackendOptions(),
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
        // Python virtualenvs + caches — site-packages can contain tens of
        // thousands of files (e.g. playwright trace bundles) and blows past
        // the inotify watcher limit (ENOSPC) on Linux.
        '**/venv/**',
        '**/.venv/**',
        '**/env/**',
        '**/__pycache__/**',
        '**/.pytest_cache/**',
        '**/.mypy_cache/**',
        '**/.ruff_cache/**',
        '**/.tox/**',
        // Other language build artifacts.
        '**/target/**',          // Rust / Java
        '**/.gradle/**',
        '**/.idea/**',
        '**/.vscode/**',
        '**/.ipynb_checkpoints/**',
        path.join(projectPath, '.git', 'objects', '**'),
        path.join(projectPath, '.git', 'logs', '**'),
        path.join(projectPath, '.git', 'lfs', '**'),
        ...loadGitignorePatterns(projectPath),
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
    // Swallow watcher errors (e.g. ENOSPC when inotify is exhausted) so they
    // don't surface as unhandled rejections from chokidar's internals.
    watcher.on('error', (err: unknown) => {
      if (isWatchResourceError(err)) {
        // inotify/file-descriptor budget exhausted. With polling on by default
        // this should not happen, but on hosts forced to native inotify it can.
        // Warn once per watcher, then go quiet — the daemon keeps running.
        if (!entry.warnedResource) {
          entry.warnedResource = true;
          console.warn(
            `[git/watcher] filesystem watch limit reached for ${projectPath}; ` +
              'some files will not be watched. Polling is enabled by default ' +
              '(unset MULTITABLE_WATCH_NATIVE) or raise fs.inotify.max_user_watches.',
          );
        }
        return;
      }
      console.warn(`[git/watcher] watcher error (${projectPath}):`, err);
    });

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
