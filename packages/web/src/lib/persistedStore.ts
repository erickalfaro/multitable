// Offline-first store snapshot for mobile resume.
//
// Why this exists: on mobile Chrome, the browser aggressively evicts tabs
// from bfcache when memory is constrained or the user has been backgrounded
// for more than a few minutes. When that happens, the page reloads cold and
// the user sees ~300-800ms of empty UI ("Loading conversation…") while REST
// endpoints repopulate the store. To the user, that empty state IS the
// "hard refresh" they want eliminated.
//
// We can't prevent Chrome's eviction policy. The real fix is to make a cold
// reload feel like a resume by hydrating the store SYNCHRONOUSLY from a
// local snapshot before React mounts — so the user's selected session and
// chat history appear instantly, then REST reconciliation runs in the
// background and merges any new messages.
//
// We use localStorage (not IndexedDB) on purpose: IDB is async-only, which
// would race the first React commit and reintroduce the empty-state flash.
// The payload is bounded (~1-2 MB worst case after LRU trim) and fits
// comfortably in the 5-10 MB quota.

import type { Project, Session, Command, Terminal, Message } from './types';

const KEY = 'mt:snapshot';
// Bump when the shape changes — old snapshots are discarded rather than
// causing subtle corruption from missing fields.
const SCHEMA_VERSION = 1;

// LRU caps. Eight sessions × ~200 messages × ~1 KB/msg ≈ 1.6 MB — comfortably
// inside the 5 MB localStorage quota with room for the projects/sessions
// metadata that lives alongside.
const MAX_SESSIONS_CACHED = 8;
const MAX_MESSAGES_PER_SESSION = 200;
// On quota errors, retry with this much smaller window before giving up
// on the messages slice entirely.
const QUOTA_RETRY_SESSIONS = 4;

// Slice of AppState we persist. Intentionally narrow: only the data the
// dashboard + chat need to render before the WS reconnects. Ephemeral
// state (streaming text, tool progress, permissions, alerts, attention,
// model catalog) is excluded — it's either server-authoritative and
// re-broadcast on connect, or transient by nature.
export interface Snapshot {
  v: number;
  projects: Project[];
  sessions: Record<string, Session>;
  commands: Record<string, Command>;
  terminals: Record<string, Terminal>;
  messagesBySession: Record<string, Message[]>;
  messagesMeta: Record<string, { lastTouchedAt: number }>;
  selectedProcessId: string | null;
  expandedProjectIds: string[];
  sidebarProjectId: string | null;
}

// The subset of AppState the saver reads. Kept as a structural type so we
// don't have to import the full AppState (would create a circular dep with
// appStore.ts which imports this file at module init).
export interface PersistableState {
  projects: Project[];
  sessions: Record<string, Session>;
  commands: Record<string, Command>;
  terminals: Record<string, Terminal>;
  messagesBySession: Record<string, Message[]>;
  messagesMeta?: Record<string, { lastTouchedAt: number }>;
  selectedProcessId: string | null;
  expandedProjectIds: string[];
  sidebarProjectId: string | null;
}

// Read the snapshot synchronously at module init / store creation time.
// Returns null on first boot, corrupt JSON, or schema-version mismatch —
// callers should treat null as "no cache, fall through to defaults."
export function loadSnapshot(): Partial<Snapshot> | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return null; // localStorage disabled (private mode, etc.)
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Snapshot> & { v?: number };
    if (parsed.v !== SCHEMA_VERSION) {
      // Stale schema — wipe it so the next save is clean.
      try {
        window.localStorage.removeItem(KEY);
      } catch {
        // ignore
      }
      return null;
    }
    return parsed;
  } catch {
    // Corrupt JSON. Drop it.
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    return null;
  }
}

// Trim messagesBySession via LRU: keep the most-recently-touched N sessions,
// drop the rest. For each kept session, keep only the last M messages. The
// dropped older messages are recoverable from the daemon's JSONL on demand
// (REST fetch on session open), so this is purely a working-set cap.
function trimForSnapshot(
  state: PersistableState,
  maxSessions: number,
): {
  messagesBySession: Record<string, Message[]>;
  messagesMeta: Record<string, { lastTouchedAt: number }>;
} {
  const meta = state.messagesMeta ?? {};
  const ids = Object.keys(state.messagesBySession);
  // Sort by lastTouchedAt desc (sessions without meta sort last via 0 default).
  ids.sort((a, b) => (meta[b]?.lastTouchedAt ?? 0) - (meta[a]?.lastTouchedAt ?? 0));
  const kept = ids.slice(0, maxSessions);
  const trimmedMessages: Record<string, Message[]> = {};
  const trimmedMeta: Record<string, { lastTouchedAt: number }> = {};
  for (const id of kept) {
    const arr = state.messagesBySession[id];
    if (!arr || arr.length === 0) continue;
    trimmedMessages[id] =
      arr.length > MAX_MESSAGES_PER_SESSION
        ? arr.slice(arr.length - MAX_MESSAGES_PER_SESSION)
        : arr;
    if (meta[id]) trimmedMeta[id] = meta[id];
  }
  return { messagesBySession: trimmedMessages, messagesMeta: trimmedMeta };
}

// Persist a snapshot. Best-effort: any error (quota, disabled storage,
// serialization failure) is swallowed — the cache is an optimization, not
// a source of truth. On QuotaExceeded we shrink the messages slice and
// retry once; on second failure we persist everything except messages so
// the dashboard still pops in instantly even if individual chats don't.
export function saveSnapshot(state: PersistableState): void {
  if (typeof window === 'undefined') return;
  const base = {
    v: SCHEMA_VERSION,
    projects: state.projects,
    sessions: state.sessions,
    commands: state.commands,
    terminals: state.terminals,
    selectedProcessId: state.selectedProcessId,
    expandedProjectIds: state.expandedProjectIds,
    sidebarProjectId: state.sidebarProjectId,
  };
  const tryWrite = (maxSessions: number): boolean => {
    const { messagesBySession, messagesMeta } = trimForSnapshot(state, maxSessions);
    const snap: Snapshot = { ...base, messagesBySession, messagesMeta };
    try {
      window.localStorage.setItem(KEY, JSON.stringify(snap));
      return true;
    } catch (err) {
      // Quota errors come through as DOMException name "QuotaExceededError"
      // (or "NS_ERROR_DOM_QUOTA_REACHED" on Firefox). Treat any throw as
      // "try smaller" — the caller decides how many retries to do.
      void err;
      return false;
    }
  };
  if (tryWrite(MAX_SESSIONS_CACHED)) return;
  if (tryWrite(QUOTA_RETRY_SESSIONS)) return;
  // Last resort: persist metadata + UI only, drop messages. The dashboard
  // still pops in instantly; chat will show "Loading conversation…" briefly
  // for the first session opened — strictly better than the cold-boot
  // experience this whole module exists to eliminate.
  const snap: Snapshot = {
    ...base,
    messagesBySession: {},
    messagesMeta: {},
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(snap));
  } catch {
    // Give up. The cache being unavailable is not fatal — the app boots
    // through the existing REST path, just without the instant resume.
  }
}

export function clearSnapshot(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
