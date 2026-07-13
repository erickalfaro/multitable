/**
 * Shared session context-menu items — used by the Agents list and the left
 * rail session previews so both surfaces offer the same actions.
 */

import toast from 'react-hot-toast';
import type { MenuItem } from '../components/context-menu/ContextMenu';
import { api, stopProcessByType } from './api';
import { useAppStore } from '../stores/appStore';
import type { ManagedProcess, Session } from './types';

async function removeSessionsById(ids: string[]) {
  if (ids.length === 0) return;
  const store = useAppStore.getState();
  const results = await Promise.allSettled(ids.map((id) => api.sessions.delete(id)));
  const failed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      store.removeSession(ids[i]);
      if (store.selectedProcessId === ids[i]) {
        store.setSelectedProcess(null);
        store.setProjectOverviewOpen(false);
      }
    } else {
      failed.push(ids[i]);
    }
  });
  window.dispatchEvent(new Event('mt:past-sessions-refresh'));
  store.clearMultiSelectedSessions();
  if (failed.length === 0) {
    toast.success(ids.length === 1 ? 'Session removed' : `${ids.length} sessions removed`);
  } else {
    toast.error(`Failed to remove ${failed.length} session${failed.length === 1 ? '' : 's'}`);
  }
}

/** Build the right-click menu for a session (Agents list or rail preview). */
export function buildSessionMenuItems(process: ManagedProcess | Session): MenuItem[] {
  const store = useAppStore.getState();
  const isRunning = process.state === 'running';
  const bulk =
    store.multiSelectedSessionIds.length >= 2 &&
    store.multiSelectedSessionIds.includes(process.id);
  const bulkIds = bulk ? store.multiSelectedSessionIds : [process.id];
  const isPinned = store.pinnedSessionIds.includes(process.id);

  return [
    ...(bulk
      ? []
      : [
          {
            label: isPinned ? 'Unpin from Wall' : 'Pin to Wall',
            action: () => store.togglePinSession(process.id),
            divider: true,
          } as MenuItem,
        ]),
    // Sessions auto-start on the first turn — only Stop while a turn is in flight.
    ...(isRunning && !bulk
      ? [
          {
            label: 'Stop',
            action: () =>
              stopProcessByType(process as Parameters<typeof stopProcessByType>[0]).catch(() =>
                toast.error('Failed to stop'),
              ),
            divider: true,
          } as MenuItem,
        ]
      : []),
    {
      label: bulk ? `Remove ${bulkIds.length} sessions` : 'Remove session',
      action: () => {
        void removeSessionsById(bulkIds);
      },
    },
  ];
}
