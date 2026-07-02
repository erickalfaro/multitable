import React, { useEffect, useRef, useState } from 'react';
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

const RAIL_COLLAPSED = 56;
const RAIL_EXPANDED = 184;
/** Ignore quick pointer pass-throughs before floating the rail open. */
const EXPAND_DELAY_MS = 180;
/** Grace period after the pointer leaves before collapsing back. */
const COLLAPSE_DELAY_MS = 140;

function projectInitials(name: string): string {
  const words = name.trim().split(/[\s_\-/]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Label text next to a row's identity glyph. Clipped by the row's
 * overflow while the rail width animates; fades in only after the width has
 * mostly landed, and drops out immediately on collapse.
 */
function railLabelStyle(open: boolean): React.CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    textAlign: 'left',
    fontSize: 12.5,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    opacity: open ? 1 : 0,
    transition: open
      ? 'opacity var(--dur-fast) var(--ease-out) 110ms, color var(--dur-med) var(--ease-out)'
      : 'opacity 80ms var(--ease-out), color var(--dur-med) var(--ease-out)',
  };
}

/** The fixed 26px slot that keeps glyphs centered in the collapsed rail. */
const identitySlot: React.CSSProperties = {
  flexShrink: 0,
  width: 26,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

/**
 * One project = one Zen tab-pill row: a full-width rounded glass pill in a
 * single vertical column. Identity is carried by bare hue-tinted initials on
 * the left (no chip box) with the project name beside them. Transparent at
 * rest, soft glass on hover, hue-tinted glass fill + hue hairline when active
 * — no outer glow. No pop-up motion (color is identity, applied softly).
 */
function ProjectRailItem({
  project,
  open,
  onMenuOpenChange,
}: {
  project: Project;
  open: boolean;
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const dark = useIsDark();
  const color = getProjectColor(project.id, dark);
  const active = useAppStore((s) => s.sidebarProjectId === project.id);
  const total = useProjectAttentionTotal(project.id);
  const permissionCount = useProjectPermissionCount(project.id);
  const unreadAttention = useProjectUnreadCount(project.id);
  const dominantCategory = useProjectDominantCategory(project.id);
  const [hover, setHover] = useState(false);
  const [menu, setMenuState] = useState<{ x: number; y: number } | null>(null);

  const setMenu = (m: { x: number; y: number } | null) => {
    setMenuState(m);
    onMenuOpenChange?.(m !== null);
  };

  const select = () => {
    // Reveal-only: swap the sections column to this project and make it the
    // modal target, but leave the main pane on whatever was open.
    const store = useAppStore.getState();
    store.setSidebarProject(project.id);
    store.setFocusedProject(project.id);
  };

  const hue = color.dot; // oklch(<L> <C> <H>) — band-anchored project hue.
  // Whole-pill glass material states (tinted glass fill, no glow).
  const background = active
    ? `color-mix(in oklch, ${hue} 14%, var(--glass-bg))`
    : hover
      ? 'var(--glass-bg-soft)'
      : 'transparent';
  const borderColor = active
    ? `color-mix(in oklch, ${hue} 55%, transparent)`
    : hover
      ? 'var(--border-strong)'
      : 'var(--glass-border)';
  const boxShadow = active ? 'inset 0 1px 0 var(--glass-highlight)' : 'none';

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
          height: 40,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 7px',
          fontFamily: 'inherit',
          background,
          border: `1px solid ${borderColor}`,
          borderRadius: 'var(--radius-soft)',
          boxShadow,
          overflow: 'hidden',
          cursor: 'pointer',
          transition:
            'background var(--dur-med) var(--ease-out), border-color var(--dur-med) var(--ease-out), box-shadow var(--dur-med) var(--ease-out)',
        }}
      >
        <span
          aria-hidden
          style={{
            ...identitySlot,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '0.02em',
            color: hue,
            transition: 'color var(--dur-med) var(--ease-out)',
          }}
        >
          {projectInitials(project.name)}
        </span>
        <span
          style={{
            ...railLabelStyle(open),
            fontWeight: active ? 600 : 500,
            color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >
          {project.name}
        </span>
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
                top: 2,
                right: 2,
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
 * The always-visible leftmost project switcher — Zen browser compact mode.
 * At rest it is a slim icon-only strip (bare hue-tinted initials per project);
 * hovering (or keyboard-focusing) it floats a full-width glass sheet OVER the
 * sections column, revealing labels. It collapses back when the pointer
 * leaves. Rows: Home, Add-project, then one glass tab-pill per project.
 * Picking a project reveals its sections in the adjacent column without
 * disturbing the main pane. `alwaysExpanded` (mobile drawer) renders the
 * static full-width column with no hover behavior.
 */
export function ProjectRail({ alwaysExpanded = false }: { alwaysExpanded?: boolean }) {
  const projects = useAppStore((s) => s.projects);
  const selectedProcessId = useAppStore((s) => s.selectedProcessId);
  const projectOverviewOpen = useAppStore((s) => s.projectOverviewOpen);
  const setAddProjectModalOpen = useAppStore((s) => s.setAddProjectModalOpen);
  const [homeHover, setHomeHover] = useState(false);
  const [addHover, setAddHover] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // An open right-click menu portals outside the rail, so pointer-leave must
  // not collapse the rail underneath it.
  const [menuPinned, setMenuPinned] = useState(false);
  const enterTimer = useRef<number | undefined>(undefined);
  const leaveTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(enterTimer.current);
      window.clearTimeout(leaveTimer.current);
    },
    [],
  );

  const open = alwaysExpanded || expanded || menuPinned;

  const onEnter = () => {
    window.clearTimeout(leaveTimer.current);
    enterTimer.current = window.setTimeout(() => setExpanded(true), EXPAND_DELAY_MS);
  };
  const onLeave = () => {
    window.clearTimeout(enterTimer.current);
    leaveTimer.current = window.setTimeout(() => setExpanded(false), COLLAPSE_DELAY_MS);
  };

  const onDashboard = !selectedProcessId && !projectOverviewOpen;

  const goToDashboard = () => {
    const store = useAppStore.getState();
    store.setSelectedProcess(null);
    store.setProjectOverviewOpen(false);
    store.setFocusedProject(null);
    store.setSidebarProject(null);
  };

  const body = (
    <>
      {/* Home — view all projects. A glass pill; brighter when on the wall. */}
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
          gap: 8,
          width: '100%',
          height: 40,
          padding: '0 7px',
          flexShrink: 0,
          borderRadius: 'var(--radius-soft)',
          border: `1px solid ${onDashboard ? 'var(--border-strong)' : 'var(--glass-border)'}`,
          background: onDashboard
            ? 'var(--glass-bg)'
            : homeHover
              ? 'var(--glass-bg-soft)'
              : 'transparent',
          boxShadow: onDashboard ? 'inset 0 1px 0 var(--glass-highlight)' : 'none',
          overflow: 'hidden',
          cursor: 'pointer',
          fontFamily: 'inherit',
          transition:
            'background var(--dur-med) var(--ease-out), border-color var(--dur-med) var(--ease-out)',
        }}
      >
        <span style={identitySlot}>
          <span style={{ display: 'flex', transform: 'scale(0.62)' }}>
            <LogoArt />
          </span>
        </span>
        <span
          style={{
            ...railLabelStyle(open),
            fontWeight: onDashboard ? 600 : 500,
            color: onDashboard ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >
          All projects
        </span>
      </button>

      {/* Add a project — a quiet ghost-glass row. */}
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
          gap: 8,
          width: '100%',
          height: 36,
          padding: '0 7px',
          flexShrink: 0,
          borderRadius: 'var(--radius-soft)',
          border: `1px dashed ${addHover ? 'var(--border-strong)' : 'var(--glass-border)'}`,
          background: addHover ? 'var(--glass-bg-soft)' : 'transparent',
          color: addHover ? 'var(--text-secondary)' : 'var(--text-muted)',
          overflow: 'hidden',
          cursor: 'pointer',
          fontFamily: 'inherit',
          transition:
            'background var(--dur-med) var(--ease-out), border-color var(--dur-med) var(--ease-out), color var(--dur-med) var(--ease-out)',
        }}
      >
        <span style={identitySlot}>
          <Plus size={15} />
        </span>
        <span style={{ ...railLabelStyle(open), fontWeight: 500 }}>Add project</span>
      </button>

      <div
        style={{
          height: 1,
          background: 'var(--glass-border)',
          flexShrink: 0,
          margin: '2px 0',
        }}
      />

      {/* The tab list — a single column of full-width glass project pills. */}
      <div
        className="mt-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          paddingBottom: 2,
        }}
      >
        {projects.map((project) => (
          <ProjectRailItem
            key={project.id}
            project={project}
            open={open}
            onMenuOpenChange={setMenuPinned}
          />
        ))}
      </div>
    </>
  );

  if (alwaysExpanded) {
    return (
      <div
        style={{
          width: RAIL_EXPANDED,
          flexShrink: 0,
          height: '100%',
          // Transparent — the pills float on the shell glass + ambient bloom.
          background: 'transparent',
          display: 'flex',
          flexDirection: 'column',
          padding: '10px 8px 12px',
          gap: 6,
          overflow: 'hidden',
        }}
      >
        {body}
      </div>
    );
  }

  return (
    // Fixed-width layout slot; the expanding panel floats out of it, over the
    // sections column, so the PanelGroup behind never re-lays-out.
    <div
      style={{
        width: RAIL_COLLAPSED,
        flexShrink: 0,
        height: '100%',
        position: 'relative',
        zIndex: 30,
      }}
    >
      <div
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocusCapture={() => {
          window.clearTimeout(leaveTimer.current);
          setExpanded(true);
        }}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) onLeave();
        }}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: open ? RAIL_EXPANDED : RAIL_COLLAPSED,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '10px 8px 12px',
          overflow: 'hidden',
          // Transparent at rest (floats on shell glass + ambient bloom);
          // a fully opaque sheet while expanded over the sections column —
          // nothing bleeds through, so no backdrop blur is needed.
          background: open ? 'var(--glass-bg-opaque)' : 'transparent',
          borderRight: `1px solid ${open ? 'var(--glass-border)' : 'transparent'}`,
          boxShadow: open ? 'var(--shadow-md)' : 'none',
          transition:
            'width var(--dur-med) var(--ease-out), background var(--dur-med) var(--ease-out), box-shadow var(--dur-med) var(--ease-out), border-color var(--dur-med) var(--ease-out)',
        }}
      >
        {body}
      </div>
    </div>
  );
}
