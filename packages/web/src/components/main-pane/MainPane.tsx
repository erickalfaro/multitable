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
  // Narrow selectors only — a whole-store subscription here re-renders the
  // entire main pane on every store write, including every streaming delta
  // of every session (one per frame per active session).
  const selectedProcessId = useAppStore((s) => s.selectedProcessId);
  const selectedFileViewerProjectId = useAppStore((s) => s.selectedFileViewerProjectId);
  const selectedGitProjectId = useAppStore((s) => s.selectedGitProjectId);
  const projectOverviewOpen = useAppStore((s) => s.projectOverviewOpen);
  const focusedProjectId = useAppStore((s) => s.focusedProjectId);
  const process = useAppStore((s) =>
    selectedProcessId
      ? s.sessions[selectedProcessId] ||
        s.commands[selectedProcessId] ||
        s.terminals[selectedProcessId]
      : undefined,
  );
  const isMobile = useIsMobile();

  if (selectedFileViewerProjectId) {
    return (
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <FileViewerMainView projectId={selectedFileViewerProjectId} />
      </div>
    );
  }

  if (selectedGitProjectId) {
    return (
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <GitMainView projectId={selectedGitProjectId} />
      </div>
    );
  }

  if (!selectedProcessId && projectOverviewOpen && focusedProjectId) {
    return (
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <ProjectOverview projectId={focusedProjectId} />
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
