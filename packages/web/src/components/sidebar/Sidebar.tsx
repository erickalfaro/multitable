import React from 'react';
import { LayoutGrid, Plus } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { ProjectSidebarItem } from './ProjectSidebarItem';
import { LogoArt } from './LogoArt';
import { Button } from '../ui';

export function Sidebar() {
  const projects = useAppStore(s => s.projects);
  const selectedProcessId = useAppStore(s => s.selectedProcessId);
  const projectOverviewOpen = useAppStore(s => s.projectOverviewOpen);
  const setSelectedProcess = useAppStore(s => s.setSelectedProcess);
  const setProjectOverviewOpen = useAppStore(s => s.setProjectOverviewOpen);
  const setFocusedProject = useAppStore(s => s.setFocusedProject);
  const setAddProjectModalOpen = useAppStore(s => s.setAddProjectModalOpen);

  const onDashboard = !selectedProcessId && !projectOverviewOpen;

  const goToDashboard = () => {
    setSelectedProcess(null);
    setProjectOverviewOpen(false);
    setFocusedProject(null);
  };

  return (
    <div
      className="mt-scroll"
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          flexShrink: 0,
        }}
      >
        {/* Logo */}
        <div
          aria-label="MultiTable"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '14px 14px 8px',
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
        >
          <LogoArt />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 10 }}>
            <span
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: 'white',
                letterSpacing: '-0.02em',
                lineHeight: 1,
              }}
            >
              mt
            </span>
            <span
              style={{
                fontSize: 9.5,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.18em',
                lineHeight: 1,
              }}
            >
              multitable v0.1
            </span>
          </div>
        </div>
        {/* Dashboard button */}
        <div style={{ padding: '0 8px 4px' }}>
          <Button
            variant="ghost"
            size="md"
            block
            leftIcon={<LayoutGrid size={14} />}
            onClick={goToDashboard}
            title="View all projects"
            style={{
              justifyContent: 'flex-start',
              backgroundColor: onDashboard ? 'var(--bg-hover)' : undefined,
              color: onDashboard ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            Home
          </Button>
        </div>
        {/* Add Project button */}
        <div style={{ padding: '0 8px 8px' }}>
          <Button
            variant="ghost"
            size="md"
            block
            leftIcon={<Plus size={14} />}
            onClick={() => setAddProjectModalOpen(true)}
            title="Add a new project"
            style={{
              justifyContent: 'flex-start',
              color: 'var(--text-secondary)',
            }}
          >
            Add Project
          </Button>
        </div>
      </div>

      {projects.length === 0 ? (
        <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 14 }}>
          No project registered. Add a project to get started.
        </div>
      ) : (
        projects.map((project) => (
          <ProjectSidebarItem key={project.id} project={project} />
        ))
      )}
    </div>
  );
}
