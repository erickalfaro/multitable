import fs from 'fs';
import path from 'path';
import simpleGit, { type SimpleGit, type StatusResult } from 'simple-git';
import type {
  GitBranchList,
  GitFileEntry,
  GitLogEntry,
  GitStatusSummary,
} from '../types.js';

function git(projectPath: string): SimpleGit {
  return simpleGit(projectPath);
}

export function isGitRepo(projectPath: string): boolean {
  try {
    return fs.existsSync(path.join(projectPath, '.git'));
  } catch {
    return false;
  }
}

// ─── Reads (legacy + new) ─────────────────────────────────────────────────────

export async function getDiff(projectPath: string): Promise<string> {
  return git(projectPath).diff(['HEAD']);
}

export async function getStatus(projectPath: string) {
  return git(projectPath).status();
}

export async function getLog(projectPath: string, maxCount = 20) {
  return git(projectPath).log({ maxCount });
}

export async function getBranch(projectPath: string) {
  return git(projectPath).branch();
}

export async function getStagedDiff(projectPath: string): Promise<string> {
  return git(projectPath).diff(['--cached']);
}

export async function getCurrentCommit(projectPath: string): Promise<string | null> {
  if (!isGitRepo(projectPath)) return null;
  try {
    const sha = (await git(projectPath).revparse(['HEAD'])).trim();
    return sha || null;
  } catch {
    return null;
  }
}

export async function getFileDiff(
  projectPath: string,
  filePath: string,
  opts: { staged?: boolean } = {}
): Promise<string> {
  const args = opts.staged ? ['--cached', '--', filePath] : ['--', filePath];
  return git(projectPath).diff(args);
}

export async function getBranches(projectPath: string): Promise<GitBranchList> {
  const summary = await git(projectPath).branch();
  const local: string[] = [];
  const remotes: string[] = [];
  for (const name of Object.keys(summary.branches)) {
    if (name.startsWith('remotes/')) remotes.push(name.replace(/^remotes\//, ''));
    else local.push(name);
  }
  return { current: summary.current || null, local, remotes };
}

export async function getStatusSummary(projectPath: string): Promise<GitStatusSummary> {
  if (!isGitRepo(projectPath)) {
    return {
      isRepo: false,
      branch: null,
      ahead: 0,
      behind: 0,
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
      head: null,
    };
  }
  const status = await git(projectPath).status();
  const head = await getCurrentCommit(projectPath);
  return {
    isRepo: true,
    branch: status.current ?? null,
    ahead: status.ahead ?? 0,
    behind: status.behind ?? 0,
    staged: collectStaged(status),
    unstaged: collectUnstaged(status),
    untracked: status.not_added.map((p) => ({ path: p, status: 'untracked' as const })),
    conflicted: status.conflicted.map((p) => ({ path: p, status: 'conflicted' as const })),
    head,
  };
}

// simple-git's `status.deleted` and `status.created` mix index changes with
// working-tree changes (e.g. a file deleted in the working tree but not
// staged still appears in `status.deleted`). Read the per-file `index` flag
// directly so we only surface real staged changes — symmetric to how
// `collectUnstaged` reads `working_dir`.
function collectStaged(status: StatusResult): GitFileEntry[] {
  const renamed = new Map<string, string>(); // newPath → oldPath
  for (const r of status.renamed) renamed.set(r.to, r.from);

  const out: GitFileEntry[] = [];
  for (const f of status.files) {
    if (renamed.has(f.path)) {
      out.push({ path: f.path, oldPath: renamed.get(f.path), status: 'renamed' });
      continue;
    }
    switch (f.index) {
      case 'M':
        out.push({ path: f.path, status: 'modified' });
        break;
      case 'A':
        out.push({ path: f.path, status: 'added' });
        break;
      case 'D':
        out.push({ path: f.path, status: 'deleted' });
        break;
      case 'R':
        out.push({ path: f.path, status: 'renamed' });
        break;
      case 'C':
        out.push({ path: f.path, status: 'copied' });
        break;
      default:
        // ' ' (no index change), '?' (untracked), 'U' (unmerged): skip.
        break;
    }
  }
  return out;
}

function collectUnstaged(status: StatusResult): GitFileEntry[] {
  // simple-git's `modified` convenience array includes files whose INDEX
  // status is 'M' — i.e. files that have been staged with no further
  // working-tree changes. They belong only in the staged bucket. Use the
  // canonical per-file `working_dir` flag instead so we only emit files
  // with an actual working-tree change.
  return status.files
    .filter((f) => f.working_dir === 'M' || f.working_dir === 'D')
    .map<GitFileEntry>((f) => ({
      path: f.path,
      status: f.working_dir === 'D' ? 'deleted' : 'modified',
    }));
}

export async function getStructuredLog(
  projectPath: string,
  maxCount = 20
): Promise<GitLogEntry[]> {
  const log = await git(projectPath).log({ maxCount });
  return log.all.map<GitLogEntry>((c) => ({
    sha: c.hash,
    shortSha: c.hash.slice(0, 7),
    author: c.author_name,
    email: c.author_email,
    date: new Date(c.date).getTime(),
    subject: c.message,
    body: c.body || '',
  }));
}

// ─── Writes ───────────────────────────────────────────────────────────────────

export async function stageFiles(projectPath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await git(projectPath).add(files);
}

export async function unstageFiles(projectPath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await git(projectPath).reset(['HEAD', '--', ...files]);
}

export async function commit(
  projectPath: string,
  message: string
): Promise<{ sha: string; summary: { changes: number; insertions: number; deletions: number } }> {
  const result = await git(projectPath).commit(message);
  return {
    sha: result.commit,
    summary: {
      changes: result.summary.changes,
      insertions: result.summary.insertions,
      deletions: result.summary.deletions,
    },
  };
}

export async function discardFiles(projectPath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  // checkout -- <files> restores tracked files; for untracked we use clean.
  // Split lists by whether the file is currently tracked.
  const status = await git(projectPath).status();
  const untracked = new Set(status.not_added);
  const toCheckout = files.filter((f) => !untracked.has(f));
  const toClean = files.filter((f) => untracked.has(f));
  if (toCheckout.length > 0) {
    await git(projectPath).checkout(['--', ...toCheckout]);
  }
  for (const f of toClean) {
    await git(projectPath).clean('f', ['--', f]);
  }
}

export async function createBranch(
  projectPath: string,
  name: string,
  opts: { checkout?: boolean } = {}
): Promise<void> {
  if (opts.checkout) {
    await git(projectPath).checkoutLocalBranch(name);
  } else {
    await git(projectPath).branch([name]);
  }
}

export async function switchBranch(projectPath: string, name: string): Promise<void> {
  await git(projectPath).checkout(name);
}

export async function stash(projectPath: string, message?: string): Promise<void> {
  if (message) {
    await git(projectPath).stash(['push', '-m', message]);
  } else {
    await git(projectPath).stash();
  }
}

export async function stashPop(projectPath: string): Promise<void> {
  await git(projectPath).stash(['pop']);
}

// ─── Worktrees ────────────────────────────────────────────────────────────────
//
// Session worktrees live in a sibling directory of the repo
// (`<parent>/<repo>.worktrees/<branch>`) so the project's own watcher and
// gitignore are never involved. Branch names may contain `/` (e.g. `mt/...`);
// the directory name flattens those to `-` while the branch keeps the slash.

export function worktreeContainerFor(repoPath: string): string {
  return path.join(path.dirname(repoPath), `${path.basename(repoPath)}.worktrees`);
}

export function worktreePathFor(repoPath: string, branch: string): string {
  return path.join(worktreeContainerFor(repoPath), branch.replace(/\//g, '-'));
}

export async function isValidBranchName(projectPath: string, branch: string): Promise<boolean> {
  try {
    await git(projectPath).raw(['check-ref-format', '--branch', branch]);
    return true;
  } catch {
    return false;
  }
}

export async function branchExists(projectPath: string, branch: string): Promise<boolean> {
  try {
    await git(projectPath).revparse(['--verify', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** `git worktree add -b <branch> <path>` — new branch from the repo's current HEAD. */
export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string
): Promise<void> {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  await git(repoPath).raw(['worktree', 'add', '-b', branch, worktreePath]);
}

/** Clean = no staged, unstaged, untracked, or conflicted entries. */
export async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  const status = await git(worktreePath).status();
  return status.files.length === 0 && status.conflicted.length === 0;
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await git(repoPath).raw(['worktree', 'remove', worktreePath]);
}

/**
 * Delete-path teardown: remove the worktree only when it holds no uncommitted
 * work. The branch is never deleted — committed work stays reachable either way.
 */
export async function removeSessionWorktree(
  repoPath: string,
  worktreePath: string
): Promise<{ removed: boolean; reason?: 'dirty' | 'missing' | 'error'; message?: string }> {
  if (!fs.existsSync(worktreePath)) {
    // Manually deleted out from under us — drop git's stale bookkeeping entry.
    try {
      await git(repoPath).raw(['worktree', 'prune']);
    } catch {}
    return { removed: false, reason: 'missing' };
  }
  try {
    if (!(await isWorktreeClean(worktreePath))) {
      return { removed: false, reason: 'dirty' };
    }
    await removeWorktree(repoPath, worktreePath);
    return { removed: true };
  } catch (err) {
    return {
      removed: false,
      reason: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Remote ops ───────────────────────────────────────────────────────────────

export interface PushPullResult {
  ok: true;
  /** Human-readable summary line — the underlying tool's stdout/stderr already
   *  includes the right metadata (commits pushed, files changed, etc.), so we
   *  surface it to the UI as-is rather than parsing further. */
  summary: string;
}

export async function fetchRemote(
  projectPath: string,
  remote?: string
): Promise<PushPullResult> {
  const args = remote ? [remote] : [];
  const result = await git(projectPath).fetch(args);
  // simple-git returns a FetchResult; flatten to a string. Empty fetches are
  // common (already up-to-date) — surface a neutral message in that case.
  const branches = (result.branches ?? []).map((b) => b.name).join(', ');
  const updated = (result.updated ?? []).map((u) => u.name).join(', ');
  const summary =
    [
      branches && `branches: ${branches}`,
      updated && `updated: ${updated}`,
    ]
      .filter(Boolean)
      .join(' · ') || 'Up to date';
  return { ok: true, summary };
}

export async function pull(
  projectPath: string,
  remote?: string,
  branch?: string
): Promise<PushPullResult> {
  // simple-git's pull(remote, branch) signature; both optional. With no args,
  // it uses the upstream of the current branch.
  const result = await (remote && branch
    ? git(projectPath).pull(remote, branch)
    : git(projectPath).pull());
  const ins = result.summary.insertions ?? 0;
  const del = result.summary.deletions ?? 0;
  const changes = result.summary.changes ?? 0;
  const fileLines = (result.files ?? []).length;
  const summary =
    fileLines === 0 && changes === 0
      ? 'Already up to date'
      : `${fileLines} file${fileLines === 1 ? '' : 's'} updated · +${ins} −${del}`;
  return { ok: true, summary };
}

export async function push(
  projectPath: string,
  opts: { setUpstream?: boolean; remote?: string; branch?: string } = {}
): Promise<PushPullResult> {
  const args: string[] = [];
  if (opts.setUpstream) args.push('--set-upstream');
  if (opts.remote) args.push(opts.remote);
  if (opts.branch) args.push(opts.branch);
  // When no remote/branch given, push uses the current upstream.
  const result = args.length > 0
    ? await git(projectPath).push(args)
    : await git(projectPath).push();
  const pushed = (result.pushed ?? []).map((p) => p.alreadyUpdated ? `${p.local} (up to date)` : p.local).join(', ');
  const summary = pushed || 'Pushed';
  return { ok: true, summary };
}

export async function deleteBranch(
  projectPath: string,
  name: string,
  force = false
): Promise<void> {
  const flag = force ? '-D' : '-d';
  await git(projectPath).branch([flag, name]);
}

// Returns the staged diff (what `git diff --cached` shows) clipped to a
// reasonable size. Used by the AI commit-message generator so the prompt
// doesn't blow past the model's context on huge stagings.
export async function getStagedDiffForAi(
  projectPath: string,
  maxBytes = 24_000
): Promise<string> {
  const diff = await getStagedDiff(projectPath);
  if (diff.length <= maxBytes) return diff;
  return diff.slice(0, maxBytes) + '\n\n[…diff truncated for AI generation…]';
}
