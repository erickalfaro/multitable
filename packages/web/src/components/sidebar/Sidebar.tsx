import { ProjectRail } from './ProjectRail';
import { ProjectSectionsColumn } from './ProjectSectionsColumn';

/**
 * Mobile-only composite: the always-visible project rail as a thin icon-only
 * strip plus the active project's sections, rendered side by side inside the
 * mobile drawer. The rail stays compact (tinted initials carry identity) so
 * the narrow drawer's width goes to the sections column — session titles need
 * the room far more than project labels do. On desktop, App.tsx renders
 * <ProjectRail /> and <ProjectSectionsColumn /> directly so the rail can live
 * outside the resizable PanelGroup.
 */
export function Sidebar() {
  return (
    <div style={{ display: 'flex', height: '100%', width: '100%', overflow: 'hidden' }}>
      <ProjectRail compact />
      <div style={{ flex: 1, minWidth: 0, height: '100%' }}>
        <ProjectSectionsColumn />
      </div>
    </div>
  );
}
