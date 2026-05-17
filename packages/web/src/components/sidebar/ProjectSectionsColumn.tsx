import { useAppStore } from '../../stores/appStore';
import { ProjectSections } from './ProjectSections';

/**
 * The scrollable sidebar column (desktop panel `id="sidebar"`). Renders the
 * sections for the single project the always-visible `ProjectRail` has
 * selected (`sidebarProjectId`). When no project is active — Home / dashboard,
 * or no projects registered — it shows an empty state instead of the old
 * multi-project accordion.
 */
export function ProjectSectionsColumn() {
  const projects = useAppStore((s) => s.projects);
  const sidebarProjectId = useAppStore((s) => s.sidebarProjectId);

  const activeProject = projects.find((p) => p.id === sidebarProjectId) ?? null;

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
      {activeProject ? (
        <ProjectSections key={activeProject.id} project={activeProject} />
      ) : projects.length === 0 ? (
        <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 14 }}>
          No project registered. Add a project to get started.
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            textAlign: 'center',
            color: 'var(--text-faint)',
            fontSize: 11.5,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          Select a project
        </div>
      )}
    </div>
  );
}
