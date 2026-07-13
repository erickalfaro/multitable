/**
 * Session list visibility — one place so the rail, Agents list, overview,
 * and dashboard stay in lockstep.
 *
 * Rules:
 *   - Older than 1 week (by last activity) → hidden everywhere
 *   - Rail jump-backs only surface quiet sessions from the last 24 hours
 *   - Live / needs-you / currently selected always stay visible even if the
 *     recency timestamp is stale (running turn, pending permission, etc.)
 */

export const SESSION_HIDE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Quiet sessions on the left rail: active within this window. */
export const SESSION_RAIL_RECENT_MS = 24 * 60 * 60 * 1000;

export type SessionRecencySource = {
  claudeState?: { lastActivity?: number } | null;
  lastActiveAt?: number | null;
  createdAt?: number | null;
  state?: string;
};

/** Last meaningful activity timestamp (ms). 0 when unknown. */
export function sessionRecencyMs(sess: SessionRecencySource): number {
  return sess.claudeState?.lastActivity ?? sess.lastActiveAt ?? sess.createdAt ?? 0;
}

/** True when last activity is older than the 1-week hide threshold. */
export function isSessionStale(sess: SessionRecencySource, now = Date.now()): boolean {
  const recency = sessionRecencyMs(sess);
  if (recency <= 0) return true;
  return now - recency > SESSION_HIDE_AFTER_MS;
}

export type SessionListOpts = {
  /** Always keep these ids (selected / multi-selected). */
  forceIds?: ReadonlySet<string> | readonly string[] | null;
  /** Session has a pending permission prompt. */
  hasPermission?: boolean;
  /** Live mid-turn (streaming / tool / status) — not just DB state. */
  isLive?: boolean;
};

function isForced(id: string | undefined, forceIds?: SessionListOpts['forceIds']): boolean {
  if (!id || !forceIds) return false;
  if (forceIds instanceof Set) return forceIds.has(id);
  return (forceIds as readonly string[]).includes(id);
}

/**
 * Whether a session belongs in project lists (Agents section, overview,
 * dashboard cards). Hides >1 week unless forced / live / permission.
 */
export function isSessionListed(
  sess: SessionRecencySource & { id?: string; state?: string },
  opts: SessionListOpts = {},
  now = Date.now(),
): boolean {
  if (isForced(sess.id, opts.forceIds)) return true;
  if (sess.state === 'running' || opts.isLive) return true;
  if (opts.hasPermission) return true;
  return !isSessionStale(sess, now);
}

/**
 * Whether a session appears under a project on the left rail:
 *   live / permission / unread, or quiet activity within 24h —
 *   and never past the 1-week hide wall (unless forced / live / permission).
 */
export function isSessionOnRail(
  sess: SessionRecencySource & { id?: string; state?: string },
  opts: SessionListOpts & { hasUnread?: boolean } = {},
  now = Date.now(),
): boolean {
  if (isForced(sess.id, opts.forceIds)) return true;
  if (sess.state === 'running' || opts.isLive) return true;
  if (opts.hasPermission || opts.hasUnread) return true;
  if (isSessionStale(sess, now)) return false;
  const recency = sessionRecencyMs(sess);
  return recency > 0 && now - recency <= SESSION_RAIL_RECENT_MS;
}
