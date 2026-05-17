import React from 'react';
import { Plus } from 'lucide-react';
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

  const [homeHover, setHomeHover] = React.useState(false);

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
        {/* Home button (avatar + HOME label, navigates to dashboard) */}
        <div style={{ padding: '10px 8px 6px' }}>
          <button
            type="button"
            onClick={goToDashboard}
            onMouseEnter={() => setHomeHover(true)}
            onMouseLeave={() => setHomeHover(false)}
            title="View all projects"
            aria-label="Home — view all projects"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              width: '100%',
              padding: '6px 8px',
              border: '1px solid transparent',
              borderRadius: 'var(--radius-snug)',
              backgroundColor:
                onDashboard || homeHover ? 'var(--bg-hover)' : 'transparent',
              cursor: 'pointer',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              fontFamily: 'inherit',
              transition: 'background-color var(--dur-fast) var(--ease-out)',
            }}
          >
            <LogoArt />
            <span
              style={{
                fontSize: 20,
                fontWeight: 700,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                lineHeight: 1,
                color: onDashboard ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              Home
            </span>
          </button>
        </div>
        {/* Add Project button */}
        <div style={{ padding: '0 8px 12px' }}>
          <Button
            variant="primary"
            size="md"
            block
            leftIcon={<Plus size={14} />}
            onClick={() => setAddProjectModalOpen(true)}
            title="Add a new project"
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
