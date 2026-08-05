import React from 'react';
import { useTerminal } from '../../hooks/useTerminal';
import { useAppStore } from '../../stores/appStore';
import { useIsMobile } from '../../lib/useIsMobile';
import { SessionHeaderBar } from './SessionHeaderBar';
import { ProcessBanner } from './ProcessBanner';
import { TerminalKeyboard } from './TerminalKeyboard';
import type { ManagedProcess, Session } from '../../lib/types';

interface Props {
  processId: string;
  process?: ManagedProcess;
}

export function TerminalView({ processId, process }: Props) {
  const isSession = process?.type === 'session';
  const session = isSession ? (process as Session) : null;

  // Only disable terminal for errored sessions (resume failed / broken).
  // Stopped sessions keep the terminal visible with scrollback.
  const terminalDisabled = isSession && session?.state === 'errored';

  const attachKind =
    process?.type === 'session' ? 'session' : process?.type === 'terminal' ? 'terminal' : null;
  const containerRef = useTerminal(processId, !!terminalDisabled, { attachKind });
  const detailPanelOpen = useAppStore((s) => s.detailPanelOpen);
  const setDetailPanelOpen = useAppStore((s) => s.setDetailPanelOpen);
  const setMobileDrawerOpen = useAppStore((s) => s.setMobileDrawerOpen);
  const isMobile = useIsMobile();
  const projectName = useAppStore(
    (s) => session ? s.projects.find((p) => p.id === session.projectId)?.name : undefined,
  );

  const showBanner =
    process &&
    (process.state === 'stopped' || process.state === 'errored');

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Session header bar */}
      {session && (
        <SessionHeaderBar
          session={session}
          onToggleDetailPanel={() => setDetailPanelOpen(!detailPanelOpen)}
          projectName={isMobile ? projectName : undefined}
          onOpenDrawer={isMobile ? () => setMobileDrawerOpen(true) : undefined}
        />
      )}

      {/* Process banner (stopped/errored) */}
      {showBanner && process && <ProcessBanner process={process} />}

      {/* Terminal */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          overflow: 'hidden',
          minHeight: 0,
          minWidth: 0,
        }}
      >
        {terminalDisabled ? (
          <div
            style={{
              flex: 1,
              backgroundColor: 'var(--bg-primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)',
              fontSize: 12.5,
            }}
          >
            Terminal unavailable — prior session not found
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: 'var(--bg-primary)',
              overflow: 'hidden',
              minHeight: 0,
              minWidth: 0,
              position: 'relative',
              boxShadow: 'none',
            }}
          >
            <div
              ref={containerRef}
              className="xterm-container"
              style={{ width: '100%', flex: 1, minHeight: 0 }}
            />
            <TerminalKeyboard processId={processId} />
          </div>
        )}
      </div>
    </div>
  );
}
