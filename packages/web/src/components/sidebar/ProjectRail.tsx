import React, { useState } from 'react';
import { Plus, Bell } from 'lucide-react';
import {
  useAppStore,
  useProjectAttentionTotal,
  useProjectDominantCategory,
  useProjectPermissionCount,
  useProjectUnreadCount,
} from '../../stores/appStore';
import type { Project } from '../../lib/types';
import { getProjectColor } from '../../lib/projectColor';
import { useIsDark } from '../../hooks/useIsDark';
import { buildProjectMenuItems } from '../../lib/projectActions';
import { ContextMenu } from '../context-menu/ContextMenu';
import { LogoArt } from './LogoArt';
import { IconButton } from '../ui';
import { CATEGORY_COLOR_VAR, CATEGORY_ICON } from '../../lib/alertVisuals';

function projectInitials(name: string): string {
  const words = name.trim().split(/[\s_\-/]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function ProjectRailItem({ project }: { project: Project }) {
  const dark = useIsDark();
  const color = getProjectColor(project.id, dark);
  const active = useAppStore((s) => s.sidebarProjectId === project.id);
  const total = useProjectAttentionTotal(project.id);
  const permissionCount = useProjectPermissionCount(project.id);
  const unreadAttention = useProjectUnreadCount(project.id);
  const dominantCategory = useProjectDominantCategory(project.id);
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const select = () => {
    // Decision 3 — reveal only: swap the sections column to this project and
    // make it the modal target, but leave the main pane on whatever was open.
    const store = useAppStore.getState();
    store.setSidebarProject(project.id);
    store.setFocusedProject(project.id);
  };

  return (
    <>
      <button
        type="button"
        onClick={select}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title={`${project.name}\n${project.path}`}
        aria-label={project.name}
        aria-current={active}
        style={{
          position: 'relative',
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
          padding: '5px 0',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {/* Active accent bar (matches SidebarItem selected styling) */}
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 4,
            bottom: 4,
            width: 3,
            borderRadius: '0 2px 2px 0',
            backgroundColor: active ? color.stripe : 'transparent',
            transition: 'background-color var(--dur-fast) var(--ease-out)',
          }}
        />
        <span
          style={{
            position: 'relative',
            width: 38,
            height: 38,
            borderRadius: 'var(--radius-snug)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: '0.02em',
            color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
            backgroundColor: active
              ? 'var(--bg-elevated)'
              : hover
                ? 'var(--bg-hover)'
                : color.tint,
            border: `1px solid ${active ? color.stripe : 'transparent'}`,
            transition:
              'background-color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
          }}
        >
          {projectInitials(project.name)}
          {total > 0 && (() => {
            // Matches SidebarItem: only switch to a category tint when the
            // badge is purely unread alerts. Permission-pending state keeps
            // the amber bell so confirmations stay the universal "you must
            // act" signal regardless of which category produced them.
            const onlyUnread = permissionCount === 0 && unreadAttention > 0;
            const tint =
              onlyUnread && dominantCategory
                ? CATEGORY_COLOR_VAR[dominantCategory]
                : 'var(--accent-amber)';
            const BadgeIcon =
              onlyUnread && dominantCategory ? CATEGORY_ICON[dominantCategory] : Bell;
            return (
              <span
                title={
                  permissionCount > 0 && unreadAttention > 0
                    ? `${permissionCount} permission${permissionCount === 1 ? '' : 's'} pending, ${unreadAttention} unread alert${unreadAttention === 1 ? '' : 's'}`
                    : permissionCount > 0
                      ? `${permissionCount} confirmation${permissionCount === 1 ? '' : 's'} pending`
                      : `${unreadAttention} unread ${dominantCategory ?? 'alert'}${unreadAttention === 1 ? '' : 's'}`
                }
                style={{
                  position: 'absolute',
                  top: -5,
                  right: -6,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 2,
                  padding: '1px 4px',
                  borderRadius: 'var(--radius-snug)',
                  background: 'var(--bg-sidebar)',
                  color: tint,
                  border: `1px solid ${tint}`,
                  fontSize: 9,
                  fontWeight: 600,
                  lineHeight: 1,
                  flexShrink: 0,
                  animation: 'mt-pulse 1.6s ease-in-out infinite',
                }}
              >
                <BadgeIcon size={8} />
                {total}
              </span>
            );
          })()}
        </span>
      </button>
      {menu && (
        <ContextMenu
          items={buildProjectMenuItems({
            projectId: project.id,
            projectName: project.name,
            onRename: () => {
              const store = useAppStore.getState();
              store.setSidebarProject(project.id);
              store.setFocusedProject(project.id);
              store.setProjectSettingsOpen(true);
            },
          })}
          position={menu}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/**
 * The always-visible leftmost project selector (VS Code activity-bar style).
 * Minimalist icon-only column: Home at the top, one avatar tile per project
 * with a rolled-up notification badge, and Add Project at the bottom.
 * Selecting a project reveals its sections in the adjacent column without
 * disturbing the main pane.
 */
export function ProjectRail() {
  const projects = useAppStore((s) => s.projects);
  const selectedProcessId = useAppStore((s) => s.selectedProcessId);
  const projectOverviewOpen = useAppStore((s) => s.projectOverviewOpen);
  const setAddProjectModalOpen = useAppStore((s) => s.setAddProjectModalOpen);
  const [homeHover, setHomeHover] = useState(false);

  const onDashboard = !selectedProcessId && !projectOverviewOpen;

  const goToDashboard = () => {
    const store = useAppStore.getState();
    store.setSelectedProcess(null);
    store.setProjectOverviewOpen(false);
    store.setFocusedProject(null);
    store.setSidebarProject(null);
  };

  return (
    <div
      className="mt-scroll"
      style={{
        width: 56,
        flexShrink: 0,
        height: '100%',
        backgroundColor: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        overflowY: 'auto',
        overflowX: 'hidden',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 6px' }}>
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
            justifyContent: 'center',
            width: 40,
            height: 40,
            padding: 0,
            border: `1px solid ${onDashboard ? 'var(--border)' : 'transparent'}`,
            borderRadius: 'var(--radius-snug)',
            backgroundColor: onDashboard || homeHover ? 'var(--bg-hover)' : 'transparent',
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'background-color var(--dur-fast) var(--ease-out)',
            transform: 'scale(0.78)',
          }}
        >
          <LogoArt />
        </button>
      </div>

      <div
        style={{
          height: 1,
          backgroundColor: 'var(--border)',
          margin: '2px 10px 6px',
          flexShrink: 0,
        }}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {projects.map((project) => (
          <ProjectRailItem key={project.id} project={project} />
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 10px' }}>
        <IconButton
          size="md"
          label="Add a new project"
          onClick={() => setAddProjectModalOpen(true)}
        >
          <Plus size={16} />
        </IconButton>
      </div>
    </div>
  );
}
