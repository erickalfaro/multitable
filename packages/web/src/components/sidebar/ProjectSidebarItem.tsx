import React, { useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { ProjectHeader } from './ProjectHeader';
import { SidebarSection } from './SidebarSection';
import { SidebarItem } from './SidebarItem';
import { SidebarGitSection } from './SidebarGitSection';
import { AddProcessModal } from '../modals/AddProcessModal';
import { ContextMenu } from '../context-menu/ContextMenu';
import type { MenuItem } from '../context-menu/ContextMenu';
import { api, stopProcessByType } from '../../lib/api';
import { terminalManager } from '../../lib/terminalManager';
import toast from 'react-hot-toast';
import type { ManagedProcess, Project } from '../../lib/types';
import { getProjectColor } from '../../lib/projectColor';
import { useIsDark } from '../../hooks/useIsDark';

function formatMetrics(proc: ManagedProcess): string {
  const parts: string[] = [];
  if (proc.metrics?.detectedPort) parts.push(`:${proc.metrics.detectedPort}`);
  if (proc.metrics?.cpuPercent > 0) parts.push(`${proc.metrics.cpuPercent.toFixed(1)}%`);
  return parts.join(' · ');
}

interface Props {
  project: Project;
}

export function ProjectSidebarItem({ project }: Props) {
  const store = useAppStore();
  const {
    sessions,
    commands,
    terminals,
    selectedProcessId,
    expandedProjectIds,
    focusedProjectId,
    setSelectedProcess,
  } = store;

  const expanded = expandedProjectIds.includes(project.id);
  const focused = focusedProjectId === project.id;
  const dark = useIsDark();
  const color = getProjectColor(project.id, dark);

  const [showAddCommand, setShowAddCommand] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    type: string;
    id: string;
    x: number;
    y: number;
    process?: ManagedProcess;
  } | null>(null);

  const projectSessions = Object.values(sessions)
    .filter((s) => s.projectId === project.id)
    .sort((a, b) => {
      const recency = (s: typeof a) =>
        s.claudeState?.lastActivity || s.lastActiveAt || s.createdAt || 0;
      return recency(b) - recency(a);
    });
  const projectCommands = Object.values(commands).filter((c) => c.projectId === project.id);
  const projectTerminals = Object.values(terminals).filter((t) => t.projectId === project.id);

  const handleSelectProject = () => {
    store.setFocusedProject(project.id);
    store.setSelectedProcess(null);
    store.setProjectOverviewOpen(true);
  };

  const handleToggleExpand = () => {
    store.toggleProjectExpanded(project.id);
  };

  const handleSelectProcess = (proc: ManagedProcess, e?: React.MouseEvent) => {
    // Modifier-aware selection for sessions only. Cmd/Ctrl+click toggles the
    // session in the multi-select set; Shift+click selects a range within
    // this project's session list; a plain click clears multi-select and
    // sets the primary selection. Commands and terminals don't participate.
    if (proc.type === 'session' && e) {
      const cmdOrCtrl = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;

      if (cmdOrCtrl) {
        const current = store.multiSelectedSessionIds;
        const alreadyInMulti = current.includes(proc.id);

        if (alreadyInMulti) {
          // Removing from the group. Don't promote this id to primary —
          // the user explicitly dropped it from the context. If primary
          // happened to point here, shift it to another remaining group
          // member (or clear it if none left) so the active chat doesn't
          // keep showing a "deselected" session.
          store.toggleMultiSelectedSession(proc.id);
          if (selectedProcessId === proc.id) {
            const remaining = current.filter((id) => id !== proc.id);
            setSelectedProcess(remaining[remaining.length - 1] ?? null);
          }
          return;
        }

        // Adding to the group. Seed with the existing primary the first
        // time so the prior plain-click selection stays part of the context.
        if (
          current.length === 0 &&
          selectedProcessId &&
          selectedProcessId !== proc.id &&
          sessions[selectedProcessId]
        ) {
          store.setMultiSelectedSessions([selectedProcessId, proc.id]);
        } else {
          store.toggleMultiSelectedSession(proc.id);
        }
        setSelectedProcess(proc.id);
        return;
      }

      if (shift && selectedProcessId) {
        const ids = projectSessions.map((s) => s.id);
        const startIdx = ids.indexOf(selectedProcessId);
        const endIdx = ids.indexOf(proc.id);
        if (startIdx >= 0 && endIdx >= 0) {
          const [a, b] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          const range = ids.slice(a, b + 1);
          store.setMultiSelectedSessions(range);
          setSelectedProcess(proc.id);
          return;
        }
      }

      // Plain click — drop any active multi-select.
      store.clearMultiSelectedSessions();
    }

    const needsReselect = selectedProcessId === proc.id && proc.state !== 'running';
    if (needsReselect) {
      setSelectedProcess(null);
      requestAnimationFrame(() => setSelectedProcess(proc.id));
    } else {
      setSelectedProcess(proc.id);
    }

    // Sessions are SDK-driven now: there's no "start" or "resume" action —
    // the first user turn auto-starts the work. Clicking simply selects.
  };

  const routeAwayIfSelected = (deletedId: string) => {
    if (selectedProcessId !== deletedId) return;
    store.setSelectedProcess(null);
    store.setProjectOverviewOpen(false);
  };

  const handleAddTerminal = async () => {
    try {
      const t = await api.terminals.create(project.id, {});
      store.upsertTerminal(t);
      store.setSelectedProcess(t.id);
    } catch {
      toast.error('Failed to create terminal');
    }
  };

  const removeSessionsById = async (ids: string[]) => {
    if (ids.length === 0) return;
    const results = await Promise.allSettled(ids.map((id) => api.sessions.delete(id)));
    const failed: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        store.removeSession(ids[i]);
        routeAwayIfSelected(ids[i]);
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
  };

  const getSessionMenuItems = (process: ManagedProcess): MenuItem[] => {
    const isRunning = process.state === 'running';
    const bulk =
      store.multiSelectedSessionIds.length >= 2 &&
      store.multiSelectedSessionIds.includes(process.id);
    const bulkIds = bulk ? store.multiSelectedSessionIds : [process.id];

    return [
      // Sessions auto-start on the first turn (sending a message IS starting),
      // so the Start path doesn't apply — only show Stop while a turn is in
      // flight. Stop here means "abort the in-flight SDK turn" via
      // /api/sessions/:id/stop, NOT the PTY route.
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
  };

  const getCommandMenuItems = (process: ManagedProcess): MenuItem[] => {
    const isRunning = process.state === 'running';
    return [
      {
        label: isRunning ? 'Stop' : 'Start',
        action: () => {
          if (isRunning) api.processes.stop(process.id).catch(() => toast.error('Failed to stop'));
          else api.processes.start(process.id).catch(() => toast.error('Failed to start'));
        },
      },
      {
        label: 'Copy command',
        action: () => {
          navigator.clipboard.writeText(process.command);
          toast.success('Command copied');
        },
        divider: true,
      },
      {
        label: 'Delete command',
        action: async () => {
          try {
            await api.commands.delete(process.id);
            store.removeCommand(process.id);
            routeAwayIfSelected(process.id);
            toast.success('Command deleted');
          } catch {
            toast.error('Failed to delete command');
          }
        },
        divider: true,
        danger: true,
      },
    ];
  };

  const getTerminalMenuItems = (process: ManagedProcess): MenuItem[] => {
    const isRunning = process.state === 'running';
    return [
      isRunning
        ? {
            label: 'Restart',
            action: () =>
              api.processes.restart(process.id).catch(() => toast.error('Failed to restart')),
          }
        : {
            label: 'Start',
            action: () =>
              api.processes.start(process.id).catch(() => toast.error('Failed to start')),
          },
      {
        label: 'Close terminal',
        action: async () => {
          try {
            await api.terminals.delete(process.id);
            store.removeTerminal(process.id);
            routeAwayIfSelected(process.id);
            toast.success('Terminal closed');
          } catch {
            toast.error('Failed to close terminal');
          }
        },
        divider: true,
        danger: true,
      },
    ];
  };

  const getProjectHeaderMenuItems = (): MenuItem[] => [
    {
      label: 'Start all',
      action: () => api.projects.startAll(project.id).catch(() => toast.error('Failed to start all')),
    },
    {
      label: 'Stop all',
      action: () => api.projects.stopAll(project.id).catch(() => toast.error('Failed to stop all')),
    },
    {
      label: 'Rename project',
      action: () => setRenaming(true),
      divider: true,
    },
    {
      label: 'Project settings',
      action: () => {
        store.setFocusedProject(project.id);
        store.setProjectSettingsOpen(true);
      },
      divider: true,
    },
    {
      label: 'Remove project',
      action: async () => {
        if (!window.confirm(`Remove project "${project.name}"? This will not delete any files.`)) return;
        try {
          await api.projects.delete(project.id);

          // Drop everything tied to the deleted project from the store
          const remainingSessions = Object.fromEntries(
            Object.entries(store.sessions).filter(([, s]) => s.projectId !== project.id)
          );
          const remainingCommands = Object.fromEntries(
            Object.entries(store.commands).filter(([, c]) => c.projectId !== project.id)
          );
          const remainingTerminals = Object.fromEntries(
            Object.entries(store.terminals).filter(([, t]) => t.projectId !== project.id)
          );
          useAppStore.setState({
            sessions: remainingSessions,
            commands: remainingCommands,
            terminals: remainingTerminals,
          });

          // removeProject also handles expandedProjectIds/focusedProjectId cleanup
          store.removeProject(project.id);

          if (selectedProcessId && !(
            remainingSessions[selectedProcessId] ||
            remainingCommands[selectedProcessId] ||
            remainingTerminals[selectedProcessId]
          )) {
            store.setSelectedProcess(null);
            store.setProjectOverviewOpen(false);
          }

          window.dispatchEvent(new Event('mt:past-sessions-refresh'));
          toast.success('Project removed');
        } catch {
          toast.error('Failed to remove project');
        }
      },
      divider: true,
      danger: true,
    },
  ];

  const getContextMenuItems = (): MenuItem[] => {
    if (!contextMenu) return [];
    const { type, process } = contextMenu;
    if (!process) {
      if (type === 'project-header') return getProjectHeaderMenuItems();
      return [];
    }
    switch (type) {
      case 'session': return getSessionMenuItems(process);
      case 'command': return getCommandMenuItems(process);
      case 'terminal': return getTerminalMenuItems(process);
      default: return [];
    }
  };

  return (
    <div
      style={{
        position: 'relative',
        margin: '10px 0 2px',
      }}
    >
      {/* Project card body — structural group container; stays at radius-none so the
          top accent rule runs edge-to-edge. */}
      <div
        style={{
          position: 'relative',
          borderRadius: 'var(--radius-none)',
          overflow: 'hidden',
          backgroundColor: 'transparent',
          borderTop: `1px solid ${focused ? color.stripe : 'transparent'}`,
          transition: 'border-color var(--dur-med) var(--ease-out)',
        }}
      >
      <ProjectHeader
        project={project}
        expanded={expanded}
        focused={focused}
        onSelect={handleSelectProject}
        onToggle={handleToggleExpand}
        editing={renaming}
        onEditingChange={setRenaming}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ type: 'project-header', id: project.id, x: e.clientX, y: e.clientY });
        }}
      />

      {expanded && (
        <>
          <SidebarSection
            title="AGENTS"
            onAdd={() => {
              store.setFocusedProject(project.id);
              store.setAddAgentModalOpen(true);
            }}
          >
            {projectSessions.length > 0 ? (
              projectSessions.map((session) => (
                <SidebarItem
                  key={session.id}
                  process={session}
                  isSelected={selectedProcessId === session.id}
                  isMultiSelected={store.multiSelectedSessionIds.includes(session.id)}
                  onClick={(e) => handleSelectProcess(session, e)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ type: 'session', id: session.id, x: e.clientX, y: e.clientY, process: session });
                  }}
                />
              ))
            ) : (
              <div style={{ padding: '6px 16px 8px 34px', fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                No agents yet
              </div>
            )}
          </SidebarSection>

          <SidebarSection title="TERMINALS" onAdd={handleAddTerminal}>
            {projectTerminals.length > 0 ? (
              projectTerminals.map((term) => (
                <SidebarItem
                  key={term.id}
                  process={term}
                  isSelected={selectedProcessId === term.id}
                  onClick={() => handleSelectProcess(term)}
                  // terminals don't participate in session multi-select
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ type: 'terminal', id: term.id, x: e.clientX, y: e.clientY, process: term });
                  }}
                />
              ))
            ) : (
              <div style={{ padding: '6px 16px 8px 34px', fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                No terminals yet
              </div>
            )}
          </SidebarSection>

          <SidebarSection title="COMMANDS" onAdd={() => setShowAddCommand(true)}>
            {projectCommands.length > 0 ? (
              projectCommands.map((cmd) => (
                <SidebarItem
                  key={cmd.id}
                  process={cmd}
                  metrics={formatMetrics(cmd)}
                  isSelected={selectedProcessId === cmd.id}
                  onClick={() => handleSelectProcess(cmd)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setContextMenu({ type: 'command', id: cmd.id, x: e.clientX, y: e.clientY, process: cmd });
                  }}
                />
              ))
            ) : (
              <div style={{ padding: '6px 16px 8px 34px', fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                No commands yet
              </div>
            )}
          </SidebarSection>

          <SidebarGitSection projectId={project.id} />
        </>
      )}
      </div>

      {showAddCommand && (
        <AddProcessModal
          projectId={project.id}
          onClose={() => setShowAddCommand(false)}
        />
      )}

      {contextMenu && (
        <ContextMenu
          items={getContextMenuItems()}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
