// Daemon-side event channel for the in-app DevLog panel. Anything emitted
// here is broadcast over WebSocket as a `daemon-log` message and rendered in
// the web client's DevLogPanel. The intent is full visibility into long-lived
// timers and other waits the UI can't otherwise observe.
//
// We DON'T wrap setTimeout itself globally — that would flood the panel with
// React-side framework timers. Instead, code paths that arm a real wait call
// trackedTimeout(label, ms, cb) which logs the start, fires the callback, and
// optionally logs cancellation/expiry.

import { EventEmitter } from 'events';

export type DaemonLogLevel = 'info' | 'warn' | 'error';

export type DaemonLogCategory =
  | 'timer'
  | 'permission'
  | 'elicitation'
  | 'watchdog'
  | 'codex'
  | 'agent'
  | 'info'
  | 'warn'
  | 'error';

export interface DaemonLogEntry {
  ts: number;
  category: DaemonLogCategory;
  level: DaemonLogLevel;
  label: string;
  detail?: string;
  durationMs?: number;
  data?: unknown;
}

class DaemonLog extends EventEmitter {
  add(entry: Omit<DaemonLogEntry, 'ts' | 'level'> & { level?: DaemonLogLevel }): void {
    const e: DaemonLogEntry = {
      ts: Date.now(),
      level: entry.level ?? defaultLevel(entry.category),
      ...entry,
    };
    this.emit('log', e);
  }
}

function defaultLevel(category: DaemonLogCategory): DaemonLogLevel {
  if (category === 'error') return 'error';
  if (category === 'warn') return 'warn';
  return 'info';
}

export const daemonLog = new DaemonLog();

interface TrackedTimeoutOptions {
  /** Logged on start. Use a stable label so future filters work. */
  label: string;
  /** Delay in ms. Logged so the panel can show the "deadline at +Ns". */
  ms: number;
  /** Optional category override. Defaults to 'timer'. */
  category?: DaemonLogCategory;
  /** Free-form detail line (sessionId, threadId, etc.). */
  detail?: string;
  /** When true, also log when the timer fires. Off by default — most timers
   * are short-lived and would just double-spam the panel. */
  logFire?: boolean;
  /** When true, also log when clearTrackedTimeout is called before fire. */
  logCancel?: boolean;
}

export interface TrackedTimer {
  handle: NodeJS.Timeout;
  cancel: () => void;
}

/**
 * setTimeout wrapper that emits a daemonLog entry the moment the timer is
 * armed. The intent is so any wait that could keep the user staring at a
 * frozen UI shows up in the DevLog automatically — no opt-in required at the
 * call site beyond using this helper.
 */
export function trackedTimeout(
  cb: () => void,
  opts: TrackedTimeoutOptions,
): TrackedTimer {
  const { label, ms, category = 'timer', detail, logFire, logCancel } = opts;
  daemonLog.add({
    category,
    label,
    detail: detail ? `${detail} · armed for ${ms}ms` : `armed for ${ms}ms`,
    durationMs: ms,
  });
  const handle = setTimeout(() => {
    if (logFire) {
      daemonLog.add({
        category,
        label: `${label} fired`,
        detail,
      });
    }
    cb();
  }, ms);
  return {
    handle,
    cancel: () => {
      clearTimeout(handle);
      if (logCancel) {
        daemonLog.add({
          category,
          label: `${label} cancelled`,
          detail,
        });
      }
    },
  };
}
