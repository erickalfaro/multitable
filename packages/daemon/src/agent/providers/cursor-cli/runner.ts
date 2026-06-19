import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import type { CursorEvent } from './events.js';

// Spawns `cursor-agent` for ONE headless turn and streams its NDJSON stdout as
// typed events. There is no long-lived child — every turn is an independent
// process, resumed by `--resume <session_id>` (see the cursor-cli skill).

export interface RunCursorOptions {
  args: string[]; // built by buildCursorArgs (flags + trailing prompt)
  cwd: string;
  signal: AbortSignal; // turn AbortController — abort kills the child
  onEvent: (ev: CursorEvent) => void;
}

export interface RunCursorResult {
  exitCode: number | null;
  sawResult: boolean; // a {type:'result'} line was emitted
  stderr: string;
}

export interface ResolvedCli {
  command: string;
  prefixArgs: string[]; // e.g. [index.js] when invoking the bundled node.exe
}

// On Windows the PATH entry is a `cursor-agent.cmd` shim that runs
// `node.exe index.js` (see cursor-agent.ps1). Spawning a `.cmd` from Node needs
// shell:true, which would re-parse our prompt argument through cmd.exe and
// mangle quotes. So we resolve the bundled node.exe + index.js and spawn THAT
// directly (shell:false) — clean argv, no quoting hazards. On macOS/Linux
// `cursor-agent` is a normal executable on PATH, so we spawn it directly.
export function resolveCursorCli(): ResolvedCli {
  const override = process.env.CURSOR_AGENT_PATH;
  if (override && existsSync(override)) return { command: override, prefixArgs: [] };

  if (process.platform === 'win32') {
    const resolved = resolveWindowsNode();
    if (resolved) return resolved;
    // Last resort: the .cmd shim via cmd.exe. buildCursorArgs keeps the prompt
    // last; cmd.exe arg-parsing may mangle exotic prompts, hence the warning.
    console.warn('[cursor] could not resolve bundled node.exe; falling back to cursor-agent.cmd');
    return { command: 'cursor-agent.cmd', prefixArgs: [] };
  }
  return { command: 'cursor-agent', prefixArgs: [] };
}

// Mirror cursor-agent.ps1: find <install>/[versions/<latest>/]{node.exe,index.js}.
function resolveWindowsNode(): ResolvedCli | null {
  const installDirs: string[] = [];
  const local = process.env.LOCALAPPDATA;
  if (local) installDirs.push(path.join(local, 'cursor-agent'));
  // Also honor any PATH entry that looks like the cursor-agent install.
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (/cursor-agent/i.test(entry)) installDirs.push(entry);
  }

  for (const dir of installDirs) {
    // Install layout puts node.exe + index.js either at the top level or inside
    // versions/<YYYY.MM.DD-commit>/.
    const top = tryNodeIndex(dir);
    if (top) return top;
    const versionsDir = path.join(dir, 'versions');
    if (!existsSync(versionsDir)) continue;
    let versions: string[];
    try {
      versions = readdirSync(versionsDir).filter((n) => /^\d{4}\.\d{1,2}\.\d{1,2}-[a-f0-9]+$/.test(n));
    } catch {
      continue;
    }
    // Latest by (year, month, day) — same ordering as the shim.
    versions.sort((a, b) => versionKey(b) - versionKey(a));
    for (const v of versions) {
      const found = tryNodeIndex(path.join(versionsDir, v));
      if (found) return found;
    }
  }
  return null;
}

function tryNodeIndex(dir: string): ResolvedCli | null {
  const node = path.join(dir, 'node.exe');
  const index = path.join(dir, 'index.js');
  if (existsSync(node) && existsSync(index)) return { command: node, prefixArgs: [index] };
  return null;
}

function versionKey(name: string): number {
  const [date] = name.split('-');
  const [y, m, d] = date.split('.');
  return Number(`${y}${(m ?? '').padStart(2, '0')}${(d ?? '').padStart(2, '0')}`) || 0;
}

export function runCursor(opts: RunCursorOptions): Promise<RunCursorResult> {
  const { command, prefixArgs } = resolveCursorCli();
  const env = {
    ...process.env,
    // Match the shim — Node compile cache for faster cold start (harmless).
    NODE_COMPILE_CACHE:
      process.env.NODE_COMPILE_CACHE ??
      (process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'cursor-compile-cache')
        : undefined),
  } as NodeJS.ProcessEnv;

  const child = spawn(command, [...prefixArgs, ...opts.args], {
    cwd: opts.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let sawResult = false;
  let stderr = '';
  let killed = false;

  const onAbort = () => {
    killed = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    // Hard-kill if it doesn't exit promptly.
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 2000).unref?.();
  };
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener('abort', onAbort, { once: true });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: CursorEvent;
    try {
      ev = JSON.parse(trimmed) as CursorEvent;
    } catch {
      // cursor-agent keeps stdout clean for NDJSON; drop any stray non-JSON.
      console.warn('[cursor] non-JSON stdout line dropped:', trimmed.slice(0, 200));
      return;
    }
    if (ev && (ev as { type?: string }).type === 'result') sawResult = true;
    try {
      opts.onEvent(ev);
    } catch (err) {
      console.error('[cursor] onEvent handler threw', err);
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  return new Promise<RunCursorResult>((resolve, reject) => {
    child.on('error', (err) => {
      opts.signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      opts.signal.removeEventListener('abort', onAbort);
      if (killed) {
        // Abort is a normal stop, not a failure — resolve so the adapter's
        // finally-path runs without surfacing a turn error.
        resolve({ exitCode: code, sawResult, stderr });
        return;
      }
      resolve({ exitCode: code, sawResult, stderr });
    });
  });
}
