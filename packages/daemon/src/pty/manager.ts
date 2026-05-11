import { EventEmitter } from 'events';
import * as nodePty from 'node-pty';
import fs from 'fs';
import { exec } from 'child_process';
import { RingBuffer } from './ringBuffer.js';
import { addPid, removePid } from '../pids.js';
import type { ManagedProcess, ProcessState, SpawnConfig } from '../types.js';

// When MultiTable itself is launched from inside a parent Claude Code
// session (e.g. VSCode's integrated terminal), these env vars leak into the
// daemon and then into every child `claude` we spawn. The child sees
// CLAUDE_CODE_ENTRYPOINT=claude-vscode and tries to run as a nested VSCode
// agent — which requires a parent IPC bridge that doesn't exist for us.
// That path fails with a sandbox error and the process wedges.
//
// Strip these on spawn so the child boots as a standalone interactive CLI.
// Explicit list keeps us from accidentally scrubbing env the session
// actually needs (e.g. the user's PATH, HOME, ANTHROPIC_API_KEY).
const PARENT_CLAUDE_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_IPC_FD',
  'CLAUDE_CODE_PARENT_SESSION_ID',
  'CLAUDE_AGENT_SDK_VERSION',
];

function scrubParentClaudeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    if (PARENT_CLAUDE_ENV_KEYS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// URL-style patterns indicate the port a server actually bound to.
// The bare "port N" pattern also matches warnings like "Port 3000 is in use,
// using available port 3001 instead." — so it's kept at lower confidence and
// a later high-confidence match is allowed to override it.
const HIGH_CONFIDENCE_PORT_PATTERNS = [
  /\blocalhost:(\d+)/gi,
  /\bhttps?:\/\/[^\s:/]+:(\d+)/gi,
  /\blistening on (?:port )?(\d+)/gi,
];

const LOW_CONFIDENCE_PORT_PATTERNS = [
  /\bport (\d+)/gi,
];

function lastMatchingPort(text: string, patterns: RegExp[]): number | null {
  let last: number | null = null;
  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      const port = parseInt(m[1], 10);
      if (port >= 1024 && port <= 65535) last = port;
    }
  }
  return last;
}

function detectPort(text: string): { port: number; confidence: 'high' | 'low' } | null {
  const high = lastMatchingPort(text, HIGH_CONFIDENCE_PORT_PATTERNS);
  if (high !== null) return { port: high, confidence: 'high' };
  const low = lastMatchingPort(text, LOW_CONFIDENCE_PORT_PATTERNS);
  if (low !== null) return { port: low, confidence: 'low' };
  return null;
}

function detectShell(): string {
  return process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
}

interface CpuSample {
  time: number; // unix ms
  utime: number;
  stime: number;
}

async function readProcStat(pid: number): Promise<CpuSample | null> {
  try {
    const content = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const parts = content.split(' ');
    const utime = parseInt(parts[13], 10);
    const stime = parseInt(parts[14], 10);
    return { time: Date.now(), utime, stime };
  } catch {
    return null;
  }
}

async function readProcMemory(pid: number): Promise<number> {
  try {
    const content = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = content.match(/VmRSS:\s+(\d+)\s+kB/);
    if (match) return parseInt(match[1], 10) * 1024;
  } catch {}
  return 0;
}

async function readMemoryFallback(pid: number): Promise<number> {
  return new Promise((resolve) => {
    exec(`ps -o rss= -p ${pid}`, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(0);
      const kb = parseInt(stdout.trim(), 10);
      resolve(isNaN(kb) ? 0 : kb * 1024);
    });
  });
}

const CLK_TCK = 100; // Hz, typical Linux default

export class PtyManager extends EventEmitter {
  private processes = new Map<string, ManagedProcess>();
  private cpuSamples = new Map<string, CpuSample>();
  private metricsInterval: NodeJS.Timeout | null = null;
  private restartTimers = new Map<string, NodeJS.Timeout>();
  private portConfidence = new Map<string, 'high' | 'low'>();

  constructor() {
    super();
    this.startMetricsPolling();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  spawn(cfg: SpawnConfig): ManagedProcess {
    if (this.processes.has(cfg.id)) {
      throw new Error(`Process ${cfg.id} already exists`);
    }

    const proc: ManagedProcess = {
      id: cfg.id,
      name: cfg.name,
      command: cfg.command,
      workingDir: cfg.workingDir,
      type: cfg.type,
      projectId: cfg.projectId,
      config: cfg.config,
      state: 'running',
      pty: null,
      pid: null,
      startedAt: null,
      restartCount: 0,
      lastRestartAt: 0,
      outputBuffer: new RingBuffer(),
      metrics: { cpuPercent: 0, memoryBytes: 0, detectedPort: null },
    };

    this.processes.set(cfg.id, proc);
    this.spawnPty(proc, cfg.cols ?? 80, cfg.rows ?? 24);
    return proc;
  }

  get(id: string): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  getAll(): ManagedProcess[] {
    return Array.from(this.processes.values());
  }

  kill(id: string): void {
    const proc = this.processes.get(id);
    if (!proc) return;
    this.cancelRestartTimer(id);
    if (proc.pty) {
      try { proc.pty.kill(); } catch {}
      proc.pty = null;
    }
    proc.pid = null;
    this.setState(proc, 'stopped');
    removePid(id);
  }

  restart(id: string): void {
    const proc = this.processes.get(id);
    if (!proc) return;
    this.kill(id);
    setTimeout(() => {
      if (this.processes.has(id)) {
        this.spawnPty(proc);
      }
    }, proc.config.autorestartDelayMs);
  }

  resize(id: string, cols: number, rows: number): void {
    const proc = this.processes.get(id);
    if (!proc || !proc.pty) return;
    try {
      proc.pty.resize(cols, rows);
    } catch {}
  }

  write(id: string, data: string): void {
    const proc = this.processes.get(id);
    if (!proc) {
      console.warn(`[pty-write] no process for id=${id}`);
      return;
    }
    if (!proc.pty) {
      console.warn(`[pty-write] process ${id} (${proc.name}) has no pty (state=${proc.state})`);
      return;
    }

    try {
      proc.pty.write(data);
    } catch (err) {
      console.error(`[pty-write] failed for id=${id}:`, err);
    }
  }

  remove(id: string): void {
    this.kill(id);
    this.processes.delete(id);
    this.cpuSamples.delete(id);
    this.portConfidence.delete(id);
  }

  destroy(): void {
    if (this.metricsInterval) clearInterval(this.metricsInterval);
    for (const id of this.processes.keys()) {
      this.kill(id);
    }
  }

  // Force-spawn a stopped/errored process.
  forceSpawn(id: string, cols = 80, rows = 24): void {
    const proc = this.processes.get(id);
    if (!proc) return;
    if (proc.state === 'running') return;
    this.spawnPty(proc, cols, rows);
  }

  // Respawn PTY for a process if it is dead (for autorespawn on subscribe).
  // Never auto-respawn errored processes.
  respawnIfDead(id: string, cols = 80, rows = 24): ManagedProcess | undefined {
    const proc = this.processes.get(id);
    if (!proc) return undefined;
    if (proc.state === 'running' || proc.state === 'errored') return proc;
    if (!proc.config.autorespawn) return proc;

    this.spawnPty(proc, cols, rows);
    return proc;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private spawnPty(proc: ManagedProcess, cols = 80, rows = 24): void {
    // Clear old scrollback so a restart starts from a clean slate.
    proc.outputBuffer.clear();

    // Reset port detection so a restart re-learns the port from fresh output.
    proc.metrics.detectedPort = null;
    this.portConfidence.delete(proc.id);

    const [spawnCmd, ...spawnArgs] = this.buildCommand(proc.command);

    let ptyProcess: nodePty.IPty;
    try {
      ptyProcess = nodePty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: proc.workingDir || process.cwd(),
        env: scrubParentClaudeEnv(process.env),
      });
    } catch (err) {
      console.error(`[PtyManager] Failed to spawn ${proc.id}:`, err);
      this.setState(proc, 'errored');
      return;
    }

    proc.pty = ptyProcess;
    proc.pid = ptyProcess.pid;
    proc.startedAt = new Date();
    proc.state = 'running';

    addPid(proc.id, ptyProcess.pid);

    ptyProcess.onData((data: string) => {
      proc.outputBuffer.write(data);

      // Detect port. High-confidence URL matches ("localhost:3001") may override
      // a previous low-confidence match ("Port 3000 is in use..."); once a
      // high-confidence port is stored we stop re-scanning to avoid flipping
      // on later log noise.
      const storedConfidence = this.portConfidence.get(proc.id);
      if (storedConfidence !== 'high') {
        const detected = detectPort(data);
        if (detected && detected.port !== proc.metrics.detectedPort) {
          proc.metrics.detectedPort = detected.port;
          this.portConfidence.set(proc.id, detected.confidence);
          this.emit('metrics', { processId: proc.id, metrics: { ...proc.metrics } });
        } else if (detected && !storedConfidence) {
          this.portConfidence.set(proc.id, detected.confidence);
        }
      }

      this.emit('data', { processId: proc.id, data });
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      removePid(proc.id);
      proc.pty = null;
      proc.pid = null;

      // If state is already 'stopped' or 'errored', it was set by kill() —
      // don't override it based on exit code.
      if (proc.state === 'stopped' || proc.state === 'errored') {
        this.emit('exit', { processId: proc.id, exitCode, signal });
        return;
      }

      const shouldRestart = this.shouldAutorestart(proc, exitCode ?? 0);
      if (shouldRestart) {
        this.setState(proc, 'running'); // keep running state during restart
        this.scheduleRestart(proc);
      } else {
        this.setState(proc, exitCode === 0 ? 'stopped' : 'errored');
      }

      this.emit('exit', { processId: proc.id, exitCode, signal });
    });

    this.emit('state-changed', { processId: proc.id, state: proc.state });
  }

  private buildCommand(command: string): string[] {
    // Split command respecting quotes
    const parts: string[] = [];
    let current = '';
    let inQuote: string | null = null;

    for (const ch of command) {
      if (inQuote) {
        if (ch === inQuote) { inQuote = null; }
        else { current += ch; }
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === ' ') {
        if (current) { parts.push(current); current = ''; }
      } else {
        current += ch;
      }
    }
    if (current) parts.push(current);

    if (parts.length === 0) {
      return [detectShell()];
    }

    // On Windows, node-pty uses CreateProcess, which does NOT walk PATHEXT for
    // bare names like `claude` — npm shims are `.cmd`/`.ps1` so the spawn fails
    // with "File not found". Run through cmd.exe so the shell resolves PATHEXT.
    if (process.platform === 'win32') {
      const first = parts[0].toLowerCase();
      const alreadyShell =
        first.endsWith('cmd.exe') ||
        first.endsWith('powershell.exe') ||
        first.endsWith('pwsh.exe') ||
        first === 'cmd' ||
        first === 'powershell' ||
        first === 'pwsh';
      if (!alreadyShell) {
        const comspec = process.env.ComSpec || 'cmd.exe';
        return [comspec, '/d', '/s', '/c', command];
      }
    }

    return parts;
  }

  private shouldAutorestart(proc: ManagedProcess, exitCode: number): boolean {
    if (!proc.config.autorestart) return false;
    if (proc.state === 'stopped') return false; // manually stopped

    const now = Date.now();
    const windowMs = proc.config.autorestartWindowSecs * 1000;

    if (now - proc.lastRestartAt > windowMs) {
      proc.restartCount = 0;
    }

    if (proc.restartCount >= proc.config.autorestartMax) return false;

    return true;
  }

  private scheduleRestart(proc: ManagedProcess): void {
    const id = proc.id;
    this.cancelRestartTimer(id);

    const timer = setTimeout(() => {
      this.restartTimers.delete(id);
      const current = this.processes.get(id);
      if (!current) return;

      current.restartCount++;
      current.lastRestartAt = Date.now();
      this.spawnPty(current);
    }, proc.config.autorestartDelayMs);

    this.restartTimers.set(id, timer);
  }

  private cancelRestartTimer(id: string): void {
    const timer = this.restartTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.restartTimers.delete(id);
    }
  }

  private setState(proc: ManagedProcess, state: ProcessState): void {
    proc.state = state;
    this.emit('state-changed', { processId: proc.id, state });
  }

  private startMetricsPolling(): void {
    this.metricsInterval = setInterval(async () => {
      for (const [id, proc] of this.processes) {
        if (!proc.pid || proc.state !== 'running') continue;

        try {
          let memoryBytes = 0;
          let cpuPercent = 0;

          if (process.platform === 'linux') {
            memoryBytes = await readProcMemory(proc.pid);
            const sample = await readProcStat(proc.pid);
            if (sample) {
              const prev = this.cpuSamples.get(id);
              if (prev) {
                const dtMs = sample.time - prev.time;
                const dtTicks = ((sample.utime + sample.stime) - (prev.utime + prev.stime));
                if (dtMs > 0) {
                  cpuPercent = (dtTicks / CLK_TCK) / (dtMs / 1000) * 100;
                }
              }
              this.cpuSamples.set(id, sample);
            }
          } else {
            memoryBytes = await readMemoryFallback(proc.pid);
            // CPU fallback via ps
            cpuPercent = await new Promise<number>((resolve) => {
              exec(`ps -o %cpu= -p ${proc.pid}`, (err, stdout) => {
                if (err || !stdout.trim()) return resolve(0);
                resolve(parseFloat(stdout.trim()) || 0);
              });
            });
          }

          proc.metrics.cpuPercent = cpuPercent;
          proc.metrics.memoryBytes = memoryBytes;

          this.emit('metrics', { processId: id, metrics: { ...proc.metrics } });
        } catch {}
      }
    }, 2000);
  }

}
