import React, { useState } from 'react';
import { Plus, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAppStore } from '../../stores/appStore';
import { AddProjectModal } from '../modals/AddProjectModal';
import { Button, Card, Input, Badge } from '../ui';
import { getProjectColor } from '../../lib/projectColor';
import { useIsDark } from '../../hooks/useIsDark';
import { ProjectMonitor } from './ProjectMonitor';
import { api } from '../../lib/api';
import { terminalManager } from '../../lib/terminalManager';
import type { ManagedProcess, Session, Command, Terminal } from '../../lib/types';

export function DashboardView() {
  const store = useAppStore();
  const { projects, sessions, commands, terminals, expandProject, setProjectOverviewOpen } = store;
  const [search, setSearch] = useState('');
  const [showAddProject, setShowAddProject] = useState(false);
  const dark = useIsDark();

  const filteredProjects = projects.filter(p =>
    search.trim() === '' || p.name.toLowerCase().includes(search.toLowerCase())
  );

  // Mirrors ProjectOverview.selectProcess — select + auto-resume/start stopped procs.
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

  const openProjectOverview = (projectId: string) => {
    expandProject(projectId);
    setProjectOverviewOpen(true);
  };

  return (
    <div
      className="mt-scroll mt-dashboard"
      style={{ height: '100%', overflowY: 'auto', animation: 'mt-fade-in var(--dur-med) var(--ease-out)' }}
    >
      {showAddProject && <AddProjectModal onClose={() => setShowAddProject(false)} />}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20, gap: 12 }}>
        <h1
          style={{
            fontSize: 18,
            fontWeight: 500,
            color: 'var(--text-primary)',
            margin: 0,
            flex: 1,
            letterSpacing: '0.02em',
            minWidth: 0,
            textTransform: 'lowercase',
          }}
        >
          dashboard
        </h1>
        <Button variant="primary" leftIcon={<Plus size={14} />} onClick={() => setShowAddProject(true)}>
          Add Project
        </Button>
      </div>
      <div style={{ marginBottom: 24, maxWidth: 420 }}>
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search projects..."
          leftIcon={<Search size={14} />}
        />
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 420px), 1fr))',
          gap: 20,
        }}
      >
        {filteredProjects.map(project => {
          const projSessions = Object.values(sessions).filter(s => s.projectId === project.id);
          const projCommands = Object.values(commands).filter(c => c.projectId === project.id);
          const projTerminals = Object.values(terminals).filter(t => t.projectId === project.id);
          const allProcs: (Session | Command | Terminal)[] = [
            ...projSessions,
            ...projCommands,
            ...projTerminals,
          ];
          const errorCount = allProcs.filter(p => p.state === 'errored').length;
          const runningCount = allProcs.filter(p => p.state === 'running').length;
          const color = getProjectColor(project.id, dark);

          return (
            <Card
              key={project.id}
              interactive
              onClick={() => openProjectOverview(project.id)}
              padding={0}
              style={{
                position: 'relative',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: 2,
                  background: color.stripe,
                  zIndex: 1,
                }}
              />
              {/* Header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '14px 14px 8px',
                }}
              >
                <span
                  style={{
                    fontSize: 13.5,
                    fontWeight: 500,
                    color: 'var(--text-primary)',
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {project.name}
                </span>
                {errorCount > 0 && (
                  <Badge variant="error" solid>
                    {errorCount} error{errorCount > 1 ? 's' : ''}
                  </Badge>
                )}
                {runningCount > 0 && errorCount === 0 && (
                  <Badge variant="running">{runningCount} running</Badge>
                )}
              </div>

              {/* Monitor */}
              <div style={{ padding: '0 16px 12px' }}>
                <ProjectMonitor
                  processes={allProcs}
                  onSelectProcess={selectProcess}
                  onOpenAll={() => openProjectOverview(project.id)}
                />
              </div>

              {/* Status bar footer */}
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
                  fontFamily: 'inherit',
                  letterSpacing: '0.05em',
                  color: 'var(--text-muted)',
                }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>
                  {projSessions.length}s · {projCommands.length}c
                  {projTerminals.length > 0 ? ` · ${projTerminals.length}t` : ''}
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
            </Card>
          );
        })}
      </div>
      {filteredProjects.length === 0 && (
        <div style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 16 }}>
          {projects.length === 0 ? (
            <span>
              No projects yet.{' '}
              <button
                onClick={() => setShowAddProject(true)}
                style={{ background: 'none', border: 'none', color: 'var(--accent-amber)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, padding: 0, textDecoration: 'underline' }}
              >
                Add a project
              </button>{' '}
              to get started.
            </span>
          ) : 'No projects match your search.'}
        </div>
      )}
    </div>
  );
}
