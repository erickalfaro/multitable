import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import { getStatusSummary, isGitRepo } from './index.js';
import {
  watchBackendOptions,
  pollingBackendOptions,
  canFallBackToPolling,
  notePollingFallback,
  isWatchResourceError,
} from '../watch-options.js';
import type { GitStatusSummary } from '../types.js';

type FSWatcher = ReturnType<typeof chokidar.watch>;

interface WatchEntry {
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
  inflight: boolean;
  warnedResource?: boolean;
  fallingBack?: boolean;
  lastEmitted?: string;
}

const DEBOUNCE_MS = 500;

// Recursion backstop for the working-tree watch. Deeper trees than this are
// almost always generated/vendored content the ignore lists missed; changes
// below the cap simply won't trigger a status refresh.
const WATCH_DEPTH = Number(process.env.MULTITABLE_WATCH_DEPTH) || 12;

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
  private onSessionStatus?: (sessionId: string, status: GitStatusSummary) => void;

  constructor(
    onStatus: (projectId: string, status: GitStatusSummary) => void,
    onSessionStatus?: (sessionId: string, status: GitStatusSummary) => void,
  ) {
    this.onStatus = onStatus;
    this.onSessionStatus = onSessionStatus;
  }

  watch(projectId: string, projectPath: string): void {
    this.attach(projectId, projectPath, (status) => this.onStatus(projectId, status));
  }

  // Session worktree watch. Keys are prefixed `session:` so they can never
  // collide with project ids (bare UUIDs) in the shared watchers map.
  watchSession(sessionId: string, worktreePath: string): void {
    this.attach(`session:${sessionId}`, worktreePath, (status) =>
      this.onSessionStatus?.(sessionId, status),
    );
  }

  unwatchSession(sessionId: string): void {
    this.unwatch(`session:${sessionId}`);
  }

  private attach(
    key: string,
    projectPath: string,
    emit: (status: GitStatusSummary) => void,
    opts: { forcePolling?: boolean } = {},
  ): void {
    // Carry the last emitted signature across re-attaches (polling fallback)
    // so the fresh initial tick doesn't re-broadcast an unchanged status.
    const prevSig = this.watchers.get(key)?.lastEmitted;
    this.unwatch(key);
    if (!isGitRepo(projectPath)) return;

    const watcher = chokidar.watch(projectPath, {
      ...(opts.forcePolling ? pollingBackendOptions() : watchBackendOptions()),
      persistent: false,
      ignoreInitial: true,
      depth: WATCH_DEPTH,
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

    // Linked worktrees keep HEAD/index under the main repo's
    // `.git/worktrees/<name>/` — outside the watched tree (`.git` here is a
    // pointer file, not a directory). Watch the resolved gitdir's HEAD/index
    // too so commits and branch flips inside the worktree refresh status.
    // Best-effort: a malformed pointer just means fewer refresh triggers.
    try {
      const dotGit = path.join(projectPath, '.git');
      if (fs.statSync(dotGit).isFile()) {
        const gitdir = fs
          .readFileSync(dotGit, 'utf8')
          .match(/^gitdir:\s*(.+)$/m)?.[1]
          ?.trim();
        if (gitdir) {
          const resolved = path.isAbsolute(gitdir) ? gitdir : path.join(projectPath, gitdir);
          watcher.add([path.join(resolved, 'HEAD'), path.join(resolved, 'index')]);
        }
      }
    } catch {}

    const entry: WatchEntry = { watcher, timer: null, inflight: false, lastEmitted: prevSig };
    const tick = () => this.refresh(projectPath, entry, emit);

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
        // OS watch budget exhausted. Recreate this watch on the polling
        // backend (once — chokidar can fire the error repeatedly) and flip
        // the process-wide sticky fallback for future attaches. The re-attach
        // fires a fresh initial tick, deduped by the lastEmitted dirty-check.
        if (!opts.forcePolling && canFallBackToPolling() && !entry.fallingBack) {
          entry.fallingBack = true;
          notePollingFallback(projectPath);
          this.attach(key, projectPath, emit, { forcePolling: true });
          return;
        }
        // Already polling (or fallback disabled): warn once per watcher, then
        // go quiet — the daemon keeps running with partial coverage.
        if (!entry.warnedResource) {
          entry.warnedResource = true;
          console.warn(
            `[git/watcher] filesystem watch limit reached for ${projectPath}; ` +
              'some files will not be watched. Raise fs.inotify.max_user_watches (Linux).',
          );
        }
        return;
      }
      console.warn(`[git/watcher] watcher error (${projectPath}):`, err);
    });

    this.watchers.set(key, entry);

    // Emit an initial status so subscribers don't have to fetch separately.
    // Serialized through initChain: at daemon boot every project attaches at
    // once, and running the initial statuses one at a time avoids a thundering
    // herd of git processes on the libuv thread pool. Debounced ticks after
    // real fs events are unaffected.
    this.initChain = this.initChain.then(tick).catch(() => {});
  }

  private initChain: Promise<void> = Promise.resolve();

  unwatch(key: string): void {
    const entry = this.watchers.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher.close().catch(() => {});
    this.watchers.delete(key);
  }

  unwatchAll(): void {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }

  // Recompute and broadcast. Drops overlapping ticks; the trailing edge of
  // the debounce window is what matters when a burst of writes lands.
  private async refresh(
    projectPath: string,
    entry: WatchEntry,
    emit: (status: GitStatusSummary) => void,
  ): Promise<void> {
    if (entry.inflight) return;
    entry.inflight = true;
    try {
      const status = await getStatusSummary(projectPath);
      // Only broadcast real changes. Chatter from fs events that didn't move
      // the status (build artifacts, .git internals rewriting, the initial
      // tick after a fallback re-attach) otherwise fans out to every WS
      // client and triggers refetch cascades in the web app.
      const sig = JSON.stringify(status);
      if (sig === entry.lastEmitted) return;
      entry.lastEmitted = sig;
      emit(status);
    } catch {
      // Repos in transitional states (rebase mid-flight, etc.) can throw —
      // swallow and try again on the next tick.
    } finally {
      entry.inflight = false;
    }
  }
}
