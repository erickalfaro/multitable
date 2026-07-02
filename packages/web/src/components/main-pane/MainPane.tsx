import React from 'react';
import { useAppStore } from '../../stores/appStore';
import { useIsMobile } from '../../lib/useIsMobile';
import { TerminalView } from './TerminalView';
import { ProjectOverview } from './ProjectOverview';
import { SessionChat } from './chat/SessionChat';
import { GitMainView } from './git/GitMainView';
import { FileViewerMainView } from './file-viewer/FileViewerMainView';
import { SessionWall } from './wall/SessionWall';
import { PinnedFeed } from './wall/PinnedFeed';
import type { Session } from '../../lib/types';

export function MainPane() {
  const store = useAppStore();
  const { selectedProcessId } = store;
  const isMobile = useIsMobile();

  if (store.selectedFileViewerProjectId) {
    return (
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <FileViewerMainView projectId={store.selectedFileViewerProjectId} />
      </div>
    );
  }

  if (store.selectedGitProjectId) {
    return (
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <GitMainView projectId={store.selectedGitProjectId} />
      </div>
    );
  }

  if (!selectedProcessId && store.projectOverviewOpen && store.focusedProjectId) {
    return (
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <ProjectOverview projectId={store.focusedProjectId} />
      </div>
    );
  }

  // Zen: no-selection homepage is the Pinned Session Wall (desktop) or
  // Pinned Feed (mobile). Replaces the legacy DashboardView project grid.
  // See plan §5.1 / §5.8. DashboardView import retired with this change.
  if (!selectedProcessId) {
    return (
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {isMobile ? <PinnedFeed /> : <SessionWall />}
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
