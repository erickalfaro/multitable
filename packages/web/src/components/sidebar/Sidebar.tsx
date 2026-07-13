import { ProjectRail } from './ProjectRail';
import { ProjectSectionsColumn } from './ProjectSectionsColumn';

/**
 * Mobile drawer composite — same unity cluster as desktop: one plate, rail
 * gutter + body. Not two panels glued together.
 */
export function Sidebar() {
  return (
    <div className="mt-sidebar-unity mt-sidebar-cluster" style={{ width: '100%', height: '100%' }}>
      <ProjectRail compact />
      <div className="mt-sidebar-body">
        <ProjectSectionsColumn />
      </div>
    </div>
  );
}
