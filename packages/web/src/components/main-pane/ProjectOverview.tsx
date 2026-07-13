import React, { useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { api, stopProcessByType } from '../../lib/api';
import {
  Settings,
  Bot,
  TerminalSquare,
  Play,
  Square,
  RotateCw,
  Plus,
} from 'lucide-react';
import type { Session, ManagedProcess } from '../../lib/types';
import { isProcessActive } from '../../lib/processState';
import { isSessionListed, sessionRecencyMs } from '../../lib/sessionVisibility';
import { Badge, Divider, IconButton, AgentBadge } from '../ui';
import { StatusDot } from '../sidebar/StatusDot';
import { terminalManager } from '../../lib/terminalManager';
import toast from 'react-hot-toast';

interface Props {
  projectId: string;
}

function stateBadgeVariant(state: string): 'running' | 'warning' | 'error' | 'muted' {
  if (state === 'running' || state === 'idle') return 'running';
  if (state === 'errored') return 'error';
  if (state === 'stopped') return 'muted';
  return 'warning';
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function ProcessTile({
  process,
  onSelect,
}: {
  process: ManagedProcess;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isRunning = isProcessActive(process);

  const typeIcon =
    process.type === 'session' ? (
      <Bot size={13} />
    ) : process.type === 'command' ? (
      <Play size={13} />
    ) : (
      <TerminalSquare size={13} />
    );

  // Type-specific metadata line shown under the name.
  let metaLine: string | null = null;
  if (process.type === 'command') {
    metaLine = truncate(process.command, 64);
  } else if (process.type === 'session') {
    metaLine = truncate(process.command, 64);
  } else {
    metaLine = truncate(process.workingDir || '~', 64);
  }

  // Type-specific secondary badge (port / cost / pid).
  let secondary: string | null = null;
  if (process.type === 'command' && process.metrics?.detectedPort) {
    secondary = `:${process.metrics.detectedPort}`;
  } else if (process.type === 'session') {
    const cost = (process as Session).claudeState?.costUsd;
    if (cost && cost > 0) secondary = `$${cost.toFixed(2)}`;
  } else if (process.type === 'terminal' && process.pid) {
    secondary = `PID ${process.pid}`;
  }

  const handleStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    api.processes.start(process.id).catch(() => toast.error('Failed to start'));
  };
  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    stopProcessByType(process).catch(() => toast.error('Failed to stop'));
  };
  const handleRestart = (e: React.MouseEvent) => {
    e.stopPropagation();
    api.processes.restart(process.id).catch(() => toast.error('Failed to restart'));
  };

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        backgroundColor: 'var(--bg-elevated)',
        border: `1px solid ${hovered ? 'var(--accent-blue)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-lg)',
        padding: '12px 14px',
        cursor: 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 92,
        boxShadow: hovered ? 'var(--shadow-md)' : 'var(--shadow-sm)',
        transition:
          'border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-med) var(--ease-out)',
      }}
    >
      {/* Top row: icon + name + state dot */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--text-secondary)', display: 'flex', flexShrink: 0 }}>
          {typeIcon}
        </span>
        <span
          style={{
            flex: 1,
            fontWeight: 600,
            fontSize: 13,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {process.name}
        </span>
        {process.type === 'session' && (
          <AgentBadge provider={(process as Session).agentProvider} size="chip" style={{ flexShrink: 0 }} />
        )}
        <div style={{ flexShrink: 0 }}>
          <StatusDot state={process.state} size={8} />
        </div>
      </div>

      {/* Middle row: meta line (command / label / cwd) */}
      {metaLine && (
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--text-muted)',
            fontFamily:
              process.type === 'command' || process.type === 'terminal'
                ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
                : undefined,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {metaLine}
        </div>
      )}

      {/* Bottom row: state badge + secondary + action slot (22px fixed for no jitter) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginTop: 'auto',
          minHeight: 22,
        }}
      >
        <Badge variant={stateBadgeVariant(process.state)} size="sm">
          {process.state.toUpperCase()}
        </Badge>
        {process.config?.autostart && (
          <Badge variant="accent" size="sm">
            AUTO
          </Badge>
        )}
        {secondary && (
          <span
            style={{
              fontSize: 11.5,
              color: 'var(--text-muted)',
              fontVariantNumeric: 'tabular-nums',
              marginLeft: 2,
            }}
          >
            {secondary}
          </span>
        )}
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            gap: 2,
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? 'auto' : 'none',
            transition: 'opacity var(--dur-fast) var(--ease-out)',
          }}
        >
          {isRunning ? (
            <>
              <IconButton size="sm" label="Restart" onClick={handleRestart}>
                <RotateCw size={11} />
              </IconButton>
              <IconButton size="sm" label="Stop" variant="danger" onClick={handleStop}>
                <Square size={11} />
              </IconButton>
            </>
          ) : (
            <IconButton size="sm" label="Start" onClick={handleStart}>
              <Play size={11} />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  running,
  total,
  onAdd,
}: {
  title: string;
  running: number;
  total: number;
  onAdd: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 10,
      }}
    >
      <span
        style={{
          fontSize: 11,
          letterSpacing: 0.6,
          fontWeight: 700,
          color: 'var(--text-muted)',
        }}
      >
        {title.toUpperCase()}
      </span>
      <span
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {running > 0 ? `${running}/${total}` : total}
      </span>
      <div
        style={{
          flex: 1,
          height: 1,
          background: 'var(--border)',
        }}
      />
      <IconButton size="sm" label={`Add ${title.toLowerCase()}`} onClick={onAdd}>
        <Plus size={13} />
      </IconButton>
    </div>
  );
}

function EmptyState({ label, onAdd, addLabel }: { label: string; onAdd: () => void; addLabel: string }) {
  return (
    <div
      onClick={onAdd}
      style={{
        padding: 20,
        textAlign: 'center',
        color: 'var(--text-muted)',
        fontSize: 12.5,
        border: '1px dashed var(--border)',
        borderRadius: 'var(--radius-lg)',
        cursor: 'pointer',
        transition: 'border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--accent-blue)';
        (e.currentTarget as HTMLDivElement).style.color = 'var(--text-secondary)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)';
        (e.currentTarget as HTMLDivElement).style.color = 'var(--text-muted)';
      }}
    >
      {label} · <span style={{ color: 'var(--accent-blue)' }}>{addLabel}</span>
    </div>
  );
}

export function ProjectOverview({ projectId }: Props) {
  const store = useAppStore();
  const project = store.projects.find((p) => p.id === projectId);

  const forceIds = [
    store.selectedProcessId,
    ...store.multiSelectedSessionIds,
  ].filter((id): id is string => !!id);
  const sessions = Object.values(store.sessions)
    .filter((s) => {
      if (s.projectId !== projectId) return false;
      const hasPermission = store.pendingPermissions.some((p) => p.sessionId === s.id);
      const isLive =
        s.state === 'running' ||
        !!store.streamingBySession[s.id] ||
        !!store.toolProgressBySession[s.id] ||
        (store.statusBySession[s.id]?.status ?? null) !== null;
      return isSessionListed(s, { forceIds, hasPermission, isLive });
    })
    .sort((a, b) => sessionRecencyMs(b) - sessionRecencyMs(a));
  const commands = Object.values(store.commands).filter((c) => c.projectId === projectId);
  const terminals = Object.values(store.terminals).filter((t) => t.projectId === projectId);

  const runningTotal = [...sessions, ...commands, ...terminals].filter(isProcessActive).length;
  const runningSessions = sessions.filter(isProcessActive).length;
  const runningCommands = commands.filter(isProcessActive).length;
  const runningTerminals = terminals.filter(isProcessActive).length;

  // Mirrors ProjectSidebarItem.handleSelectProcess — select the process, close
  // the overview so Terminal mounts, and auto-resume/start stopped sessions
  // (with the double-RAF so xterm has fitted before we send cols/rows).
  const selectProcess = (proc: ManagedProcess) => {
    store.setProjectOverviewOpen(false);
    store.setSelectedProcess(proc.id);

    // Sessions are SDK-driven: no start/resume action — first turn auto-starts.
    // Commands and terminals still spawn via PtyManager.
    if (
      (proc.type === 'command' || proc.type === 'terminal') &&
      proc.state === 'stopped'
    ) {
      api.processes.start(proc.id).catch(() => toast.error('Failed to start'));
    }
  };

  const handleAddTerminal = async () => {
    try {
      const terminal = await api.terminals.create(projectId, {});
      store.upsertTerminal(terminal);
      selectProcess(terminal);
    } catch {
      toast.error('Failed to create terminal');
    }
  };

  const handleAddSession = () => {
    store.setFocusedProject(projectId);
    store.setAddAgentModalOpen(true);
  };

  const handleAddCommand = () => {
    store.setFocusedProject(projectId);
    store.setAddProcessModalOpen(true);
  };

  const gridStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: 10,
  };

  return (
    <div
      className="mt-scroll"
      style={{
        flex: 1,
        overflow: 'auto',
        padding: 32,
        animation: 'mt-fade-in var(--dur-med) var(--ease-out)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <span
          style={{
            fontSize: 22,
            fontWeight: 700,
            color: 'var(--text-primary)',
            flex: 1,
            letterSpacing: -0.3,
          }}
        >
          {project?.name ?? 'Project'}
        </span>
        {runningTotal > 0 ? (
          <Badge variant="running" size="md">
            {runningTotal} running
          </Badge>
        ) : sessions.length + commands.length + terminals.length > 0 ? (
          <Badge variant="muted" size="md">
            Idle
          </Badge>
        ) : null}
        <IconButton label="Project settings" onClick={() => store.setProjectSettingsOpen(true)}>
          <Settings size={15} />
        </IconButton>
      </div>

      <Divider margin={20} />

      {/* Sessions */}
      <section style={{ marginBottom: 24 }}>
        <SectionHeader
          title="Agents"
          running={runningSessions}
          total={sessions.length}
          onAdd={handleAddSession}
        />
        {sessions.length === 0 ? (
          <EmptyState
            label="No agents yet"
            addLabel="Add an agent"
            onAdd={handleAddSession}
          />
        ) : (
          <div style={gridStyle}>
            {sessions.map((s) => (
              <ProcessTile key={s.id} process={s} onSelect={() => selectProcess(s)} />
            ))}
          </div>
        )}
      </section>

      {/* Terminals */}
      <section style={{ marginBottom: 24 }}>
        <SectionHeader
          title="Terminals"
          running={runningTerminals}
          total={terminals.length}
          onAdd={handleAddTerminal}
        />
        {terminals.length === 0 ? (
          <EmptyState
            label="No terminals yet"
            addLabel="Open a terminal"
            onAdd={handleAddTerminal}
          />
        ) : (
          <div style={gridStyle}>
            {terminals.map((t) => (
              <ProcessTile key={t.id} process={t} onSelect={() => selectProcess(t)} />
            ))}
          </div>
        )}
      </section>

      {/* Commands */}
      <section style={{ marginBottom: 24 }}>
        <SectionHeader
          title="Commands"
          running={runningCommands}
          total={commands.length}
          onAdd={handleAddCommand}
        />
        {commands.length === 0 ? (
          <EmptyState
            label="No commands yet"
            addLabel="Add a command"
            onAdd={handleAddCommand}
          />
        ) : (
          <div style={gridStyle}>
            {commands.map((c) => (
              <ProcessTile key={c.id} process={c} onSelect={() => selectProcess(c)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
