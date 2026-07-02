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
        // Transparent — the sidebar list floats directly on the shell glass so
        // the ambient bloom reads behind it (one blur layer: the shell). The
        // resize handle provides the seam to the main pane.
        backgroundColor: 'transparent',
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
          className="mt-display"
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            textAlign: 'center',
            fontSize: 19,
          }}
        >
          select a <em>project</em>
        </div>
      )}
    </div>
  );
}
