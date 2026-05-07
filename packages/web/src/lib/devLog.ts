// In-memory ring buffer for the in-app DevLog panel. Captures WS traffic,
// API calls, browser errors, and explicit info events so the UI can render a
// live debug feed without needing the browser DevTools.

export type LogCategory =
  | 'ws-in'
  | 'ws-out'
  | 'ws-conn'
  | 'ws-pty'
  | 'api'
  | 'error'
  | 'warn'
  | 'info';

export type LogLevel = 'info' | 'warn' | 'error';

export interface DevLogEntry {
  id: number;
  ts: number;
  category: LogCategory;
  level: LogLevel;
  label: string;
  detail?: string;
  data?: unknown;
  durationMs?: number;
}

const MAX_ENTRIES = 5000;

let nextId = 1;
const buffer: DevLogEntry[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function levelFor(category: LogCategory): LogLevel {
  if (category === 'error') return 'error';
  if (category === 'warn') return 'warn';
  return 'info';
}

export const devLog = {
  add(entry: Omit<DevLogEntry, 'id' | 'ts' | 'level'> & { level?: LogLevel }): void {
    const e: DevLogEntry = {
      id: nextId++,
      ts: Date.now(),
      level: entry.level ?? levelFor(entry.category),
      ...entry,
    };
    buffer.push(e);
    if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
    notify();
  },

  clear(): void {
    buffer.length = 0;
    notify();
  },

  getAll(): readonly DevLogEntry[] {
    return buffer;
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

// Best-effort stringify for the panel's "copy" affordance. Falls back to a
// stub when the payload contains cycles.
export function safeStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Truncate long single-line previews so the row doesn't overflow.
export function trimPreview(s: string, max = 240): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
