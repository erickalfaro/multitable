import { ProjectRail } from './ProjectRail';
import { ProjectSectionsColumn } from './ProjectSectionsColumn';

/**
 * Mobile-only composite: the always-visible project rail as a thin left strip
 * plus the active project's sections, rendered side by side inside the mobile
 * drawer. On desktop, App.tsx renders <ProjectRail /> and
 * <ProjectSectionsColumn /> directly so the rail can live outside the
 * resizable PanelGroup.
 */
export function Sidebar() {
  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', overflow: 'hidden' }}>
      <ProjectRail alwaysExpanded />
      <div style={{ flex: 1, minWidth: 0, height: '100%' }}>
        <ProjectSectionsColumn />
      </div>
    </div>
  );
}
