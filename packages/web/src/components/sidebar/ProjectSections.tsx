import React, { useCallback, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../stores/appStore';
import { ProjectHeader } from './ProjectHeader';
import { SidebarSection } from './SidebarSection';
import { SidebarItem } from './SidebarItem';
import { SidebarExplorerSection } from './SidebarExplorerSection';
import { AddProcessModal } from '../modals/AddProcessModal';
import { ContextMenu } from '../context-menu/ContextMenu';
import type { MenuItem } from '../context-menu/ContextMenu';
import { api } from '../../lib/api';
import { buildProjectMenuItems } from '../../lib/projectActions';
import { buildSessionMenuItems } from '../../lib/sessionMenuItems';
import { isSessionListed, sessionRecencyMs } from '../../lib/sessionVisibility';
import toast from 'react-hot-toast';
import type { ManagedProcess, Project } from '../../lib/types';

function formatMetrics(proc: ManagedProcess): string {
  const parts: string[] = [];
  if (proc.metrics?.detectedPort) parts.push(`:${proc.metrics.detectedPort}`);
  if (proc.metrics?.cpuPercent > 0) parts.push(`${proc.metrics.cpuPercent.toFixed(1)}%`);
  return parts.join(' · ');
}

interface Props {
  project: Project;
}

/**
 * The sections for a SINGLE project (AGENTS / TERMINALS / COMMANDS, plus the
 * detached EXPLORER card). Extracted from the old `ProjectSidebarItem` — the
 * always-visible `ProjectRail` now picks the one active project, so the
 * accordion (`expandedProjectIds`) and per-project header chevron are gone;
 * the 5 sections always render and the header is a slim title bar.
 *
 * All selection / multi-select / context-menu / rename behavior is preserved
 * verbatim from the original component.
 */
export function ProjectSections({ project }: Props) {
  // Narrow selectors only — this component is the always-mounted sidebar
  // body; a whole-store subscription made it (and every SidebarItem row)
  // re-render on every streaming delta of every session. The useShallow
  // selectors below recompute per store tick but bail the render whenever
  // the resulting list is shallow-equal — i.e. almost every streaming frame.
  const selectedProcessId = useAppStore((s) => s.selectedProcessId);
  const multiSelectedSessionIds = useAppStore((s) => s.multiSelectedSessionIds);

  const [showAddCommand, setShowAddCommand] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    type: string;
    id: string;
    x: number;
    y: number;
    process?: ManagedProcess;
  } | null>(null);

  // Agents older than 1 week auto-hide (still visible if selected / live /
  // pending permission). See lib/sessionVisibility.ts.
  const projectSessions = useAppStore(
    useShallow((s) => {
      const forceIds = [s.selectedProcessId, ...s.multiSelectedSessionIds].filter(
        (id): id is string => !!id,
      );
      return Object.values(s.sessions)
        .filter((sess) => {
          if (sess.projectId !== project.id) return false;
          const hasPermission = s.pendingPermissions.some((p) => p.sessionId === sess.id);
          const isLive =
            sess.state === 'running' ||
            !!s.streamingBySession[sess.id] ||
            !!s.toolProgressBySession[sess.id] ||
            (s.statusBySession[sess.id]?.status ?? null) !== null;
          return isSessionListed(sess, { forceIds, hasPermission, isLive });
        })
        .sort((a, b) => sessionRecencyMs(b) - sessionRecencyMs(a));
    }),
  );
  const projectCommands = useAppStore(
    useShallow((s) => Object.values(s.commands).filter((c) => c.projectId === project.id)),
  );
  const projectTerminals = useAppStore(
    useShallow((s) => Object.values(s.terminals).filter((t) => t.projectId === project.id)),
  );

  // Stable across renders so memoized SidebarItem rows don't invalidate on
  // handler identity; live state is read via getState() at call time.
  const projectSessionsRef = useRef(projectSessions);
  projectSessionsRef.current = projectSessions;

  const handleSelectProject = () => {
    const store = useAppStore.getState();
    store.setFocusedProject(project.id);
    store.setSelectedProcess(null);
    store.setProjectOverviewOpen(true);
  };

  const handleSelectProcess = useCallback((proc: ManagedProcess, e?: React.MouseEvent) => {
    const store = useAppStore.getState();
    const { selectedProcessId, sessions, setSelectedProcess } = store;
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
        const ids = projectSessionsRef.current.map((s) => s.id);
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
  }, []);

  const handleShowMenu = useCallback((proc: ManagedProcess, e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ type: proc.type, id: proc.id, x: e.clientX, y: e.clientY, process: proc });
  }, []);

  const routeAwayIfSelected = (deletedId: string) => {
    const store = useAppStore.getState();
    if (store.selectedProcessId !== deletedId) return;
    store.setSelectedProcess(null);
    store.setProjectOverviewOpen(false);
  };

  const handleAddTerminal = async () => {
    try {
      const t = await api.terminals.create(project.id, {});
      const store = useAppStore.getState();
      store.upsertTerminal(t);
      store.setSelectedProcess(t.id);
    } catch {
      toast.error('Failed to create terminal');
    }
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
            useAppStore.getState().removeCommand(process.id);
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
            useAppStore.getState().removeTerminal(process.id);
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

  const getContextMenuItems = (): MenuItem[] => {
    if (!contextMenu) return [];
    const { type, process } = contextMenu;
    if (!process) {
      if (type === 'project-header')
        return buildProjectMenuItems({
          projectId: project.id,
          projectName: project.name,
          onRename: () => setRenaming(true),
        });
      return [];
    }
    switch (type) {
      case 'session':
        return buildSessionMenuItems(process);
      case 'command':
        return getCommandMenuItems(process);
      case 'terminal':
        return getTerminalMenuItems(process);
      default:
        return [];
    }
  };

  return (
    <div
      style={{
        position: 'relative',
        // No right padding — selected session open-right edges must meet the
        // panel frame (not float as closed cards inset from the edge).
        padding: '6px 0 16px 2px',
      }}
    >
      <ProjectHeader
        project={project}
        expanded
        focused
        hideToggle
        onSelect={handleSelectProject}
        onToggle={() => {}}
        editing={renaming}
        onEditingChange={setRenaming}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ type: 'project-header', id: project.id, x: e.clientX, y: e.clientY });
        }}
      />

      <SidebarSection
        title="Agents"
        // ~10 most-recent rows visible; older sessions reached by scrolling.
        scrollMaxHeight={440}
        onAdd={() => {
          useAppStore.getState().setNewAgentProject(project.id);
        }}
      >
        {projectSessions.length > 0 ? (
          projectSessions.map((session) => (
            <SidebarItem
              key={session.id}
              process={session}
              isSelected={selectedProcessId === session.id}
              isMultiSelected={multiSelectedSessionIds.includes(session.id)}
              onClick={handleSelectProcess}
              onContextMenu={handleShowMenu}
            />
          ))
        ) : (
          <div style={{ padding: '4px 12px 6px 28px', fontSize: 12, color: 'var(--text-faint)' }}>
            No agents yet
          </div>
        )}
      </SidebarSection>

      <SidebarSection title="Terminals" scrollMaxHeight={340} onAdd={handleAddTerminal}>
        {projectTerminals.length > 0 ? (
          projectTerminals.map((term) => (
            <SidebarItem
              key={term.id}
              process={term}
              isSelected={selectedProcessId === term.id}
              onClick={handleSelectProcess}
              // terminals don't participate in session multi-select
              onContextMenu={handleShowMenu}
            />
          ))
        ) : (
          <div style={{ padding: '4px 12px 6px 28px', fontSize: 12, color: 'var(--text-faint)' }}>
            No terminals yet
          </div>
        )}
      </SidebarSection>

      <SidebarSection title="Commands" scrollMaxHeight={340} onAdd={() => setShowAddCommand(true)}>
        {projectCommands.length > 0 ? (
          projectCommands.map((cmd) => (
            <SidebarItem
              key={cmd.id}
              process={cmd}
              metrics={formatMetrics(cmd)}
              isSelected={selectedProcessId === cmd.id}
              onClick={handleSelectProcess}
              onContextMenu={handleShowMenu}
            />
          ))
        ) : (
          <div style={{ padding: '4px 12px 6px 28px', fontSize: 12, color: 'var(--text-faint)' }}>
            No commands yet
          </div>
        )}
      </SidebarSection>

      {/* Explorer — same continuous field as agents; air gap only. */}
      <div style={{ marginTop: 4, paddingBottom: 4 }}>
        <SidebarExplorerSection projectId={project.id} />
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
