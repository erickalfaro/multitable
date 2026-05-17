import { existsSync, realpathSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// OS-level filesystem containment for the `hermes acp` child.
//
// Why: Hermes self-gates by command CONTENT, never by PATH — it has no
// repo/workspace confinement (see hermes-grok skill, pitfalls §10b). A Hermes
// turn can read/write/delete anywhere the OS user can: ~/.ssh, ~/.aws, sibling
// projects, ~/.bashrc — all with no prompt. The only enforceable boundary is
// an OS sandbox around the child process itself. We use bubblewrap (`bwrap`),
// the same unprivileged user-namespace sandbox Flatpak uses.
//
// What the sandboxed child can see:
//   - WRITABLE: the project directory, Hermes' own home (~/.hermes — auth,
//     config, the venv+binary, the sessions DB), and an ephemeral tmpfs for
//     $HOME / /tmp so cache writes don't crash but also don't persist or leak.
//   - READ-ONLY: minimal system runtime (/usr, /etc, /lib, …) so Python/node/
//     ripgrep and TLS/DNS work.
//   - HIDDEN: the rest of $HOME. ~/.ssh, ~/.aws, sibling projects, dotfiles
//     simply do not exist inside the namespace.
//   - Network: host network is shared (Hermes needs api.x.ai).
//
// Fail-closed: containment is mandatory. If `bwrap` is missing we throw
// SandboxUnavailableError rather than silently running unconfined. The only
// escape hatch is the explicit env var MULTITABLE_HERMES_SANDBOX=off (logged
// loudly) — for non-Linux dev boxes or debugging.

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

/** Explicit, loud opt-out. Anything other than the literal 'off' enforces. */
export function sandboxDisabledByEnv(): boolean {
  return process.env.MULTITABLE_HERMES_SANDBOX === 'off';
}

let bwrapPathCache: string | null | undefined;

/** Absolute path to a working `bwrap`, or null if unavailable. Cached. */
export function findBwrap(): string | null {
  if (bwrapPathCache !== undefined) return bwrapPathCache;
  try {
    // `command -v` resolves PATH the same way spawn() will.
    const out = execFileSync('bash', ['-lc', 'command -v bwrap'], {
      encoding: 'utf8',
    }).trim();
    bwrapPathCache = out && existsSync(out) ? out : null;
  } catch {
    bwrapPathCache = null;
  }
  return bwrapPathCache;
}

function roBindTry(src: string): string[] {
  return existsSync(src) ? ['--ro-bind-try', src, src] : [];
}

/** Resolve the hermes launcher to an absolute, symlink-free host path. */
export function resolveHermesBinary(hermesPath: string): string {
  if (hermesPath.includes('/')) return safeRealpath(hermesPath);
  try {
    const out = execFileSync('bash', ['-lc', `command -v ${hermesPath}`], {
      encoding: 'utf8',
    }).trim();
    return out ? safeRealpath(out) : hermesPath;
  } catch {
    return hermesPath;
  }
}

// Hermes' Python toolchain lives OUTSIDE ~/.hermes: the launcher is a shim in
// ~/.local/bin and (for the documented uv install) the interpreter the venv
// points at is a uv-managed standalone CPython under ~/.local/share/uv. The
// $HOME tmpfs hides all of it, so we must re-expose exactly those paths
// read-only — without re-exposing ~/.ssh, ~/.aws, sibling projects, etc.
function collectToolchainBinds(hermesAbs: string, hermesHome: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const roTry = (src: string) => {
    if (!src || seen.has(src) || !existsSync(src)) return;
    seen.add(src);
    out.push('--ro-bind-try', src, src);
  };

  // 1. The resolved launcher itself (e.g. ~/.local/bin/hermes).
  roTry(hermesAbs);

  // 2. The interpreter the venv references. pyvenv.cfg's `home =` points at
  //    the python bin dir; bind its parent (the full runtime: bin + lib).
  const venvCfg = path.join(hermesHome, 'hermes-agent', 'venv', 'pyvenv.cfg');
  try {
    const home = readFileSync(venvCfg, 'utf8')
      .split('\n')
      .map((l) => l.match(/^\s*home\s*=\s*(.+?)\s*$/))
      .find(Boolean)?.[1];
    if (home) roTry(path.dirname(safeRealpath(home)));
  } catch {
    /* non-uv / missing venv — the fallbacks below cover common layouts */
  }

  // 3. Fallbacks for common Python toolchain managers, so a differently
  //    installed Hermes still finds its interpreter. All read-only, all
  //    best-effort (skipped when absent).
  const h = homedir();
  for (const p of [
    path.join(h, '.local', 'share', 'uv'), // uv-managed pythons (Hermes default)
    path.join(h, '.local', 'share', 'pipx'), // pipx install
    path.join(h, '.pyenv'), // pyenv
    path.join(h, '.rye'), // rye
  ]) {
    roTry(p);
  }

  return out;
}

/**
 * Build the `bwrap … --` prefix that confines the inner command to
 * `projectDir` + `hermesHome` (+ Hermes' read-only Python toolchain).
 * Returns the absolute, resolved hermes binary to exec (PATH is unreliable
 * inside the namespace once $HOME is tmpfs'd) and the bwrap argv prefix; the
 * caller appends `<hermesBin> acp …` after the prefix.
 *
 * Throws SandboxUnavailableError when enforcement is required but `bwrap`
 * is not installed.
 */
export function buildSandboxArgs(opts: {
  projectDir: string;
  hermesHome: string;
  hermesPath: string;
}): { command: string; prefixArgs: string[]; hermesBin: string } {
  const bwrap = findBwrap();
  if (!bwrap) {
    throw new SandboxUnavailableError(
      'bubblewrap (bwrap) is required to sandbox Hermes but was not found on ' +
        'PATH. Install it (Debian/Ubuntu: `sudo apt install bubblewrap`) or, ' +
        'to run Hermes WITHOUT filesystem containment, set ' +
        'MULTITABLE_HERMES_SANDBOX=off in the daemon environment.',
    );
  }

  const home = homedir();
  // Resolve symlinks so the bind source matches Hermes' own realpath()-based
  // checks and so a symlinked project dir is mounted at its real location.
  const project = safeRealpath(opts.projectDir);
  const hHome = safeRealpath(opts.hermesHome);
  const hermesBin = resolveHermesBinary(opts.hermesPath);

  // Order matters: tmpfs on $HOME must come BEFORE the binds that re-expose
  // subtrees under it (the binds would otherwise be wiped). The toolchain
  // binds are mostly under $HOME too, so they go after the tmpfs.
  const args: string[] = [
    '--die-with-parent',
    '--unshare-user',
    '--unshare-ipc',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    // System runtime, read-only. /usr is hard-required; the rest are
    // best-effort (merged-/usr distros symlink several of these).
    '--ro-bind',
    '/usr',
    '/usr',
    ...roBindTry('/bin'),
    ...roBindTry('/sbin'),
    ...roBindTry('/lib'),
    ...roBindTry('/lib64'),
    ...roBindTry('/lib32'),
    ...roBindTry('/etc'),
    ...roBindTry('/opt'),
    // /run carries the systemd-resolved DNS stub + nss sockets; read-only.
    ...roBindTry('/run'),
    // Wipe $HOME to an ephemeral tmpfs, then re-expose ONLY what Hermes
    // needs: its state dir (rw), the project (rw), and its Python toolchain
    // (ro). ~/.ssh, ~/.aws, sibling projects, dotfiles stay invisible.
    '--tmpfs',
    home,
    '--bind',
    hHome,
    hHome,
    '--bind',
    project,
    project,
    ...collectToolchainBinds(hermesBin, hHome),
    '--chdir',
    project,
    '--setenv',
    'HOME',
    home,
    '--',
  ];

  return { command: bwrap, prefixArgs: args, hermesBin };
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** `$HERMES_HOME` or `~/.hermes` — the dir Hermes persists auth/config/state in. */
export function resolveHermesHome(): string {
  const fromEnv = process.env.HERMES_HOME;
  return fromEnv && fromEnv.trim() ? fromEnv : path.join(homedir(), '.hermes');
}
