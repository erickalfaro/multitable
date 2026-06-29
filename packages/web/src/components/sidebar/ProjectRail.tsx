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
import { CATEGORY_COLOR_VAR, CATEGORY_ICON } from '../../lib/alertVisuals';

function projectInitials(name: string): string {
  const words = name.trim().split(/[\s_\-/]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * One project = one glass "favicon" launcher tile (glass-design: a rounded
 * square of soft glass, NOT a circle with a stripe). Each tile wears its ring
 * hue softly — a faint tint at rest, a soft outer glow when active. Hover lifts
 * it 1px ("gentle motion"). No accent stripe (the skill forbids stripes/blocks;
 * color is identity, applied softly).
 */
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
    // Reveal-only: swap the sections column to this project and make it the
    // modal target, but leave the main pane on whatever was open.
    const store = useAppStore.getState();
    store.setSidebarProject(project.id);
    store.setFocusedProject(project.id);
  };

  const hue = color.dot; // oklch(<L> <C> <H>) — band-anchored project hue.
  const background = active
    ? `color-mix(in oklch, ${hue} 16%, var(--glass-bg))`
    : hover
      ? `color-mix(in oklch, ${hue} 12%, var(--glass-bg))`
      : `color-mix(in oklch, ${hue} 8%, var(--glass-bg-soft))`;
  const borderColor = active
    ? `color-mix(in oklch, ${hue} 55%, transparent)`
    : hover
      ? 'var(--border-strong)'
      : 'var(--glass-border)';
  const boxShadow = active
    ? `inset 0 1px 0 var(--glass-highlight), 0 0 18px -3px color-mix(in oklch, ${hue} 50%, transparent)`
    : 'inset 0 1px 0 var(--glass-highlight)';

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
          aspectRatio: '1',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12.5,
          fontWeight: 700,
          letterSpacing: '0.02em',
          fontFamily: 'inherit',
          color: active
            ? 'var(--text-primary)'
            : `color-mix(in oklch, ${hue} 55%, var(--text-secondary))`,
          background,
          border: `1px solid ${borderColor}`,
          borderRadius: 'var(--radius-soft)',
          boxShadow,
          cursor: 'pointer',
          transform: hover && !active ? 'translateY(-1px)' : 'none',
          transition:
            'transform var(--dur-fast) var(--ease-out), background var(--dur-med) var(--ease-out), border-color var(--dur-med) var(--ease-out), box-shadow var(--dur-med) var(--ease-out), color var(--dur-med) var(--ease-out)',
        }}
      >
        {projectInitials(project.name)}
        {total > 0 && (() => {
          // Permission-pending keeps the amber bell (the universal "you must
          // act" signal); pure unread alerts switch to the category tint.
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
                top: -6,
                right: -6,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 2,
                minWidth: 15,
                height: 15,
                padding: '0 4px',
                borderRadius: 'var(--radius-pill)',
                background: 'var(--glass-bg-strong)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                color: tint,
                border: `1px solid ${tint}`,
                fontSize: 8.5,
                fontWeight: 700,
                lineHeight: 1,
                flexShrink: 0,
                boxShadow: 'var(--shadow-sm)',
                animation: 'mt-pulse 1.6s ease-in-out infinite',
              }}
            >
              <BadgeIcon size={8} />
              {total}
            </span>
          );
        })()}
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
 * The always-visible leftmost project switcher, reimagined as a Zen glass
 * favicon launcher (skill: img_4 / img_7). A Home tile sits at the top, then a
 * 2-column grid of soft-glass project tiles, then an Add tile at the bottom —
 * all rounded-square glass with hairline borders and gentle hover lift. Picking
 * a project reveals its sections in the adjacent column without disturbing the
 * main pane.
 */
export function ProjectRail() {
  const projects = useAppStore((s) => s.projects);
  const selectedProcessId = useAppStore((s) => s.selectedProcessId);
  const projectOverviewOpen = useAppStore((s) => s.projectOverviewOpen);
  const setAddProjectModalOpen = useAppStore((s) => s.setAddProjectModalOpen);
  const [homeHover, setHomeHover] = useState(false);
  const [addHover, setAddHover] = useState(false);

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
      style={{
        width: 100,
        flexShrink: 0,
        height: '100%',
        // Transparent — the tiles float on the shell glass + ambient bloom.
        background: 'transparent',
        display: 'flex',
        flexDirection: 'column',
        padding: '10px 10px 12px',
        gap: 10,
        overflow: 'hidden',
      }}
    >
      {/* Home — view all projects. A glass tile; brighter when on the wall. */}
      <button
        type="button"
        onClick={goToDashboard}
        onMouseEnter={() => setHomeHover(true)}
        onMouseLeave={() => setHomeHover(false)}
        title="View all projects"
        aria-label="Home — view all projects"
        aria-current={onDashboard}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: 46,
          padding: 0,
          flexShrink: 0,
          borderRadius: 'var(--radius-soft)',
          border: `1px solid ${onDashboard ? 'var(--border-strong)' : 'var(--glass-border)'}`,
          background: onDashboard
            ? 'var(--glass-bg)'
            : homeHover
              ? 'var(--glass-bg-soft)'
              : 'transparent',
          boxShadow: onDashboard ? 'inset 0 1px 0 var(--glass-highlight)' : 'none',
          cursor: 'pointer',
          fontFamily: 'inherit',
          transform: homeHover && !onDashboard ? 'translateY(-1px)' : 'none',
          transition:
            'background var(--dur-med) var(--ease-out), border-color var(--dur-med) var(--ease-out), transform var(--dur-fast) var(--ease-out)',
        }}
      >
        <span style={{ display: 'flex', transform: 'scale(0.82)' }}>
          <LogoArt />
        </span>
      </button>

      <div
        style={{
          height: 1,
          background: 'var(--glass-border)',
          flexShrink: 0,
        }}
      />

      {/* The favicon launcher grid — 2 columns of square glass project tiles. */}
      <div
        className="mt-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 8,
          alignContent: 'start',
          paddingBottom: 2,
        }}
      >
        {projects.map((project) => (
          <ProjectRailItem key={project.id} project={project} />
        ))}
      </div>

      {/* Add a project — a quiet dashed-glass tile, full width at the bottom. */}
      <button
        type="button"
        onClick={() => setAddProjectModalOpen(true)}
        onMouseEnter={() => setAddHover(true)}
        onMouseLeave={() => setAddHover(false)}
        title="Add a new project"
        aria-label="Add a new project"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: 34,
          flexShrink: 0,
          borderRadius: 'var(--radius-soft)',
          border: `1px dashed ${addHover ? 'var(--border-strong)' : 'var(--glass-border)'}`,
          background: addHover ? 'var(--glass-bg-soft)' : 'transparent',
          color: addHover ? 'var(--text-secondary)' : 'var(--text-muted)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          transition:
            'background var(--dur-med) var(--ease-out), border-color var(--dur-med) var(--ease-out), color var(--dur-med) var(--ease-out)',
        }}
      >
        <Plus size={16} />
      </button>
    </div>
  );
}
