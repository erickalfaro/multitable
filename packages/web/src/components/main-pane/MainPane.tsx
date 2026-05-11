import React from 'react';
import { useAppStore } from '../../stores/appStore';
import { TerminalView } from './TerminalView';
import { DashboardView } from './DashboardView';
import { ProjectOverview } from './ProjectOverview';
import { SessionChat } from './chat/SessionChat';
import type { Session } from '../../lib/types';

export function MainPane() {
  const store = useAppStore();
  const { selectedProcessId } = store;

  if (!selectedProcessId && store.projectOverviewOpen && store.focusedProjectId) {
    return (
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <ProjectOverview projectId={store.focusedProjectId} />
      </div>
    );
  }

  if (!selectedProcessId) {
    return (
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <DashboardView />
      </div>
    );
  }

  const process =
    store.sessions[selectedProcessId] ||
    store.commands[selectedProcessId] ||
    store.terminals[selectedProcessId];

  if (process?.type === 'session') {
    return (
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <SessionChat sessionId={selectedProcessId} session={process as Session} />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <TerminalView processId={selectedProcessId} process={process} />
    </div>
  );
}
