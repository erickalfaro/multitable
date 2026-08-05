import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { useAppStore } from '../../stores/appStore';
import { ProjectMonitor } from './ProjectMonitor';
import { api } from '../../lib/api';
import { isSessionListed } from '../../lib/sessionVisibility';
import type { ManagedProcess, Session, Command, Terminal, Project } from '../../lib/types';

/* ─────────────────────────────────────────────────────────────
   Project window — a terminal-style panel. No per-project color
   trim: state is carried by a single status glyph, accent is the
   one amber on the prompt + hover border.
   ───────────────────────────────────────────────────────────── */

interface ProjectCardProps {
  project: Project;
  procs: (Session | Command | Terminal)[];
  onOpen: () => void;
  onSelectProcess: (p: ManagedProcess) => void;
}

function ProjectCard({ project, procs, onOpen, onSelectProcess }: ProjectCardProps) {
  const [hover, setHover] = useState(false);

  const sessions = procs.filter(p => p.type === 'session');
  const commands = procs.filter(p => p.type === 'command');
  const terminals = procs.filter(p => p.type === 'terminal');
  const errors = procs.filter(p => p.state === 'errored').length;
  const running = procs.filter(p => p.state === 'running').length;

  let dotColor = 'var(--text-faint)';
  let statusText = 'idle';
  let glyph = '○';
  if (errors > 0) {
    dotColor = 'var(--status-error)';
    statusText = `${errors} err`;
    glyph = '●';
  } else if (running > 0) {
    dotColor = 'var(--status-running)';
    statusText = `${running} live`;
    glyph = '●';
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-elevated)',
        border: `1px solid ${hover ? 'var(--accent-amber)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-soft)',
        overflow: 'hidden',
        cursor: 'pointer',
        outline: 'none',
        transition:
          'border-color var(--dur-med) var(--ease-out), background-color var(--dur-med) var(--ease-out)',
      }}
    >
      {/* Prompt header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          padding: '12px 14px 10px',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '0.04em',
            color: hover ? 'var(--accent-amber)' : 'var(--accent-amber-dim)',
            transition: 'color var(--dur-med) var(--ease-out)',
            flexShrink: 0,
          }}
        >
          mt ❯
        </span>
        <span
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--text-primary)',
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: '-0.01em',
          }}
        >
          {project.name}
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 10,
            fontFamily: 'var(--font-mono, monospace)',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            flexShrink: 0,
          }}
        >
          <span style={{ color: dotColor, fontSize: 9 }}>{glyph}</span>
          {statusText}
        </span>
      </div>

      {/* Seam */}
      <span style={{ height: 1, background: 'var(--border)' }} />

      {/* Process monitor */}
      <div style={{ padding: '11px 14px 12px' }}>
        <ProjectMonitor processes={procs} onSelectProcess={onSelectProcess} onOpenAll={onOpen} />
      </div>

      {/* Status footer */}
      <div
        style={{
          marginTop: 'auto',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-statusbar)',
          padding: '5px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 10,
          fontFamily: 'var(--font-mono, monospace)',
          letterSpacing: '0.05em',
          color: 'var(--text-muted)',
        }}
      >
        <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>
          {sessions.length}s · {commands.length}c
          {terminals.length > 0 ? ` · ${terminals.length}t` : ''}
        </span>
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            textAlign: 'right',
          }}
          title={project.path}
        >
          {project.path}
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   Dashboard — only the project windows.
   ───────────────────────────────────────────────────────────── */

export function DashboardView() {
  const projects = useAppStore((s) => s.projects);
  const sessions = useAppStore((s) => s.sessions);
  const commands = useAppStore((s) => s.commands);
  const terminals = useAppStore((s) => s.terminals);
  const expandProject = useAppStore((s) => s.expandProject);
  const setProjectOverviewOpen = useAppStore((s) => s.setProjectOverviewOpen);

  const selectProcess = (proc: ManagedProcess) => {
    const st = useAppStore.getState();
    st.setProjectOverviewOpen(false);
    st.setSelectedProcess(proc.id);
    if ((proc.type === 'command' || proc.type === 'terminal') && proc.state === 'stopped') {
      api.processes.start(proc.id).catch(() => toast.error('Failed to start'));
    }
  };

  const openProjectOverview = (projectId: string) => {
    expandProject(projectId);
    setProjectOverviewOpen(true);
  };

  return (
    <div
      className="mt-scroll mt-dashboard"
      style={{
        height: '100%',
        overflowY: 'auto',
        animation: 'mt-fade-in var(--dur-med) var(--ease-out)',
      }}
    >
      {projects.length === 0 ? (
        <div
          style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 12.5,
            color: 'var(--text-faint)',
            letterSpacing: '0.04em',
          }}
        >
          <span style={{ color: 'var(--accent-amber-dim)' }}>mt ❯</span> no projects registered —
          add one from the sidebar.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 420px), 1fr))',
            gap: 20,
          }}
        >
          {projects.map(project => {
            const procs: (Session | Command | Terminal)[] = [
              ...Object.values(sessions).filter((s) => {
                if (s.projectId !== project.id) return false;
                return isSessionListed(s, {
                  isLive: s.state === 'running',
                });
              }),
              ...Object.values(commands).filter(c => c.projectId === project.id),
              ...Object.values(terminals).filter(t => t.projectId === project.id),
            ];
            return (
              <ProjectCard
                key={project.id}
                project={project}
                procs={procs}
                onOpen={() => openProjectOverview(project.id)}
                onSelectProcess={selectProcess}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
