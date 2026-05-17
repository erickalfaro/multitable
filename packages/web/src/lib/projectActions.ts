import toast from 'react-hot-toast';
import { api } from './api';
import { useAppStore } from '../stores/appStore';
import type { MenuItem } from '../components/context-menu/ContextMenu';

/**
 * Delete a project and purge everything tied to it from the store. Shared by
 * the sections-column header menu and the ProjectRail tile menu so the
 * cleanup (sessions/commands/terminals + selection re-route) stays in one
 * place. `removeProject` itself also repoints expanded/focused/sidebar ids.
 */
export async function removeProjectEverywhere(projectId: string, projectName: string): Promise<void> {
  if (!window.confirm(`Remove project "${projectName}"? This will not delete any files.`)) return;
  try {
    await api.projects.delete(projectId);

    const store = useAppStore.getState();
    const remainingSessions = Object.fromEntries(
      Object.entries(store.sessions).filter(([, s]) => s.projectId !== projectId),
    );
    const remainingCommands = Object.fromEntries(
      Object.entries(store.commands).filter(([, c]) => c.projectId !== projectId),
    );
    const remainingTerminals = Object.fromEntries(
      Object.entries(store.terminals).filter(([, t]) => t.projectId !== projectId),
    );
    useAppStore.setState({
      sessions: remainingSessions,
      commands: remainingCommands,
      terminals: remainingTerminals,
    });

    // removeProject also handles expandedProjectIds / focusedProjectId /
    // sidebarProjectId cleanup.
    store.removeProject(projectId);

    const sel = useAppStore.getState().selectedProcessId;
    if (sel && !(remainingSessions[sel] || remainingCommands[sel] || remainingTerminals[sel])) {
      store.setSelectedProcess(null);
      store.setProjectOverviewOpen(false);
    }

    window.dispatchEvent(new Event('mt:past-sessions-refresh'));
    toast.success('Project removed');
  } catch {
    toast.error('Failed to remove project');
  }
}

/**
 * The project-level context menu (Start all / Stop all / Rename / Settings /
 * Remove). `onRename` is provided by the caller because the two surfaces
 * differ: the sections-column header renames inline, while the rail opens
 * Project settings.
 */
export function buildProjectMenuItems(opts: {
  projectId: string;
  projectName: string;
  onRename: () => void;
}): MenuItem[] {
  const store = useAppStore.getState();
  return [
    {
      label: 'Start all',
      action: () =>
        api.projects.startAll(opts.projectId).catch(() => toast.error('Failed to start all')),
    },
    {
      label: 'Stop all',
      action: () =>
        api.projects.stopAll(opts.projectId).catch(() => toast.error('Failed to stop all')),
    },
    {
      label: 'Rename project',
      action: opts.onRename,
      divider: true,
    },
    {
      label: 'Project settings',
      action: () => {
        store.setFocusedProject(opts.projectId);
        store.setProjectSettingsOpen(true);
      },
      divider: true,
    },
    {
      label: 'Remove project',
      action: () => {
        void removeProjectEverywhere(opts.projectId, opts.projectName);
      },
      divider: true,
      danger: true,
    },
  ];
}
