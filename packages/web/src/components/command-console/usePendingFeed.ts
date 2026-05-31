import { useMemo, useRef } from 'react';
import { useAppStore } from '../../stores/appStore';
import type { PermissionPrompt, ElicitationPrompt } from '../../lib/types';

/**
 * Unified discriminated union for everything that's blocking on user input,
 * across permissions, ask-questions, and MCP elicitations. The Command
 * Console's Pending Actions tab renders against this list.
 *
 * Permissions and ask-questions share a backing prompt shape — the
 * discriminator falls out of `prompt.kind` on the permission side.
 */
export type PendingItem =
  | { kind: 'permission'; id: string; sessionId: string; createdAt: number; prompt: PermissionPrompt }
  | { kind: 'ask-question'; id: string; sessionId: string; createdAt: number; prompt: PermissionPrompt }
  | { kind: 'elicitation'; id: string; sessionId: string; createdAt: number; prompt: ElicitationPrompt };

export interface SessionGroup {
  sessionId: string;
  items: PendingItem[];
}

/**
 * Joins `pendingPermissions + pendingElicitations` into a chronologically
 * sorted, session-grouped list.
 *
 * Permission prompts on the wire don't all carry a `createdAt` (only the
 * Phase-5 extras shipped one), so the hook stamps a stable "first observed"
 * timestamp the first time it sees an id and reuses it across renders. The
 * ref-backed map is pruned each pass so it can't grow without bound.
 */
export function usePendingFeed(): { groups: SessionGroup[]; totalCount: number } {
  const permissions = useAppStore((s) => s.pendingPermissions);
  const elicitations = useAppStore((s) => s.pendingElicitations);

  // Stable per-id "first observed" timestamp for permission prompts.
  // ElicitationPrompt already has `createdAt` from the daemon.
  const firstSeenRef = useRef<Map<string, number>>(new Map());

  return useMemo(() => {
    const seen = firstSeenRef.current;
    const stillActive = new Set<string>();
    const now = Date.now();

    const items: PendingItem[] = [];

    for (const p of permissions) {
      stillActive.add(p.id);
      let ts = p.createdAt;
      if (!ts || !Number.isFinite(ts)) {
        const cached = seen.get(p.id);
        if (cached !== undefined) {
          ts = cached;
        } else {
          ts = now;
          seen.set(p.id, ts);
        }
      }
      const kind: PendingItem['kind'] = p.kind === 'ask-question' ? 'ask-question' : 'permission';
      items.push({
        kind,
        id: p.id,
        sessionId: p.sessionId,
        createdAt: ts,
        prompt: p,
      } as PendingItem);
    }

    for (const e of elicitations) {
      stillActive.add(e.id);
      items.push({
        kind: 'elicitation',
        id: e.id,
        sessionId: e.sessionId,
        createdAt: e.createdAt,
        prompt: e,
      });
    }

    // Prune dead ids so the cache doesn't leak.
    for (const k of seen.keys()) {
      if (!stillActive.has(k)) seen.delete(k);
    }

    // Newest first.
    items.sort((a, b) => b.createdAt - a.createdAt);

    // Group by session, preserving first-occurrence order so the freshest
    // session floats to the top.
    const groupMap = new Map<string, PendingItem[]>();
    for (const it of items) {
      const arr = groupMap.get(it.sessionId);
      if (arr) {
        arr.push(it);
      } else {
        groupMap.set(it.sessionId, [it]);
      }
    }

    const groups: SessionGroup[] = [];
    for (const [sessionId, items] of groupMap) {
      groups.push({ sessionId, items });
    }

    return { groups, totalCount: items.length };
  }, [permissions, elicitations]);
}
