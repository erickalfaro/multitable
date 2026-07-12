import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Bell } from 'lucide-react';
import {
  useAppStore,
  useProjectAttentionTotal,
  useProjectDominantCategory,
  useProjectPermissionCount,
  useProjectUnreadCount,
  useRailPreviewSessionIds,
} from '../../stores/appStore';
import type { Project } from '../../lib/types';
import { getProjectColor } from '../../lib/projectColor';
import { useProjectColor } from '../../hooks/useProjectColor';
import { useIsDark } from '../../hooks/useIsDark';
import { orderRailEntries } from '../../lib/projectNav';
import { useRailReorder } from './railDrag';
import { RailSessionPreview } from './RailSessionPreview';
import { ProjectColorPopover } from './ProjectColorPopover';
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

/** Reorder drop indicator, rendered in the 6px gap above the target row. */
function DropLine({ color }: { color: string }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        top: -4,
        left: 2,
        right: 2,
        height: 2,
        borderRadius: 1,
        background: color,
        pointerEvents: 'none',
        zIndex: 5,
      }}
    />
  );
}

/** Props threaded from the rail's drag hook into each draggable row wrapper. */
interface EntryDragProps {
  onPointerDown: (e: React.PointerEvent) => void;
  onClickCapture: (e: React.MouseEvent) => void;
}

/**
 * A user-inserted divider between projects. Draggable like a project row;
 * right-click to remove.
 */
function RailDivider({
  id,
  dragging,
  dropBefore,
  dropColor,
  entryProps,
  onMenuOpenChange,
}: {
  id: string;
  dragging: boolean;
  dropBefore: boolean;
  dropColor: string;
  entryProps?: EntryDragProps;
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    onMenuOpenChange?.(menu !== null);
  }, [menu, onMenuOpenChange]);

  return (
    <div
      data-rail-entry={id}
      {...entryProps}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      style={{
        position: 'relative',
        flexShrink: 0,
        padding: '5px 2px',
        cursor: entryProps ? 'grab' : 'default',
        opacity: dragging ? 0.4 : 1,
        touchAction: entryProps ? 'none' : undefined,
      }}
    >
      {dropBefore && <DropLine color={dropColor} />}
      <div
        style={{
          height: 1,
          borderRadius: 1,
          background: hover ? 'var(--border-strong)' : 'var(--glass-border)',
          transition: 'background var(--dur-fast) var(--ease-out)',
        }}
      />
      {menu && (
        <ContextMenu
          items={[
            {
              label: 'Remove divider',
              danger: true,
              action: () => useAppStore.getState().removeDivider(id),
            },
          ]}
          position={menu}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * One project = one Zen tab-pill row: a full-width rounded glass pill in a
 * single vertical column. Identity is carried by bare hue-tinted initials on
 * the left (no chip box) with the project name beside them. Transparent at
 * rest, soft glass on hover, hue-tinted glass fill + hue hairline when active
 * — no outer glow (except the hue ring marking the project that owns the
 * currently-selected process). While the sheet is open, the project's live
 * sessions (mid-turn or needing attention) render as jump-to preview rows
 * under the pill.
 */
function ProjectRailItem({
  project,
  open,
  allowEdgeBleed,
  dragging,
  dropBefore,
  dropColor,
  entryProps,
  onMenuOpenChange,
  onNavigate,
}: {
  project: Project;
  open: boolean;
  /** Collapsed desktop rail only: the active pill bleeds to the right edge. */
  allowEdgeBleed: boolean;
  dragging: boolean;
  dropBefore: boolean;
  dropColor: string;
  entryProps?: EntryDragProps;
  onMenuOpenChange?: (open: boolean) => void;
  onNavigate?: () => void;
}) {
  const color = useProjectColor(project.id);
  const active = useAppStore((s) => s.sidebarProjectId === project.id);
  // The project that owns the currently-selected process keeps a hue ring
  // even when another project's sections are revealed — the "which project
  // does the open session belong to" anchor.
  const ownsSelection = useAppStore((s) => {
    const sel = s.selectedProcessId;
    if (!sel) return false;
    const proc = s.sessions[sel] ?? s.commands[sel] ?? s.terminals[sel];
    return proc?.projectId === project.id;
  });
  const total = useProjectAttentionTotal(project.id);
  const permissionCount = useProjectPermissionCount(project.id);
  const unreadAttention = useProjectUnreadCount(project.id);
  const dominantCategory = useProjectDominantCategory(project.id);
  const previewIds = useRailPreviewSessionIds(project.id, open);
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [colorPicker, setColorPicker] = useState<{ x: number; y: number } | null>(null);

  // The floating sheet must stay open while any popup portaled from this row
  // is up (menu or color picker) — pointer-leave would collapse it underneath.
  useEffect(() => {
    onMenuOpenChange?.(menu !== null || colorPicker !== null);
  }, [menu, colorPicker, onMenuOpenChange]);

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
  const boxShadow =
    [
      active ? 'inset 0 1px 0 var(--glass-highlight)' : null,
      ownsSelection
        ? `0 0 0 1px color-mix(in oklch, ${hue} 45%, transparent), 0 0 10px color-mix(in oklch, ${hue} 25%, transparent)`
        : null,
    ]
      .filter(Boolean)
      .join(', ') || 'none';
  // Fused-surface cue: at rest (collapsed desktop rail) the active pill drops
  // its right rounding and runs to the rail's right edge, visually touching
  // the hue-washed sections column beside it.
  const bleed = allowEdgeBleed && active;

  return (
    <div
      data-rail-entry={project.id}
      {...entryProps}
      style={{
        position: 'relative',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        opacity: dragging ? 0.4 : 1,
        touchAction: entryProps ? 'none' : undefined,
      }}
    >
      {dropBefore && <DropLine color={dropColor} />}
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
          width: bleed ? 'calc(100% + 8px)' : '100%',
          height: 40,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 7px',
          fontFamily: 'inherit',
          background,
          // Side longhands (not the `border` shorthand) so the bleed state
          // can drop the right edge without React's shorthand-conflict warning.
          borderTop: `1px solid ${borderColor}`,
          borderBottom: `1px solid ${borderColor}`,
          borderLeft: `1px solid ${borderColor}`,
          borderRight: bleed ? 'none' : `1px solid ${borderColor}`,
          borderRadius: 'var(--radius-soft)',
          borderTopRightRadius: bleed ? 0 : undefined,
          borderBottomRightRadius: bleed ? 0 : undefined,
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
            fontWeight: ownsSelection ? 700 : 600,
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
      {open && previewIds.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {previewIds.map((sessionId) => (
            <RailSessionPreview key={sessionId} sessionId={sessionId} onNavigate={onNavigate} />
          ))}
        </div>
      )}
      {menu && (
        <ContextMenu
          items={[
            {
              label: 'Change color…',
              action: () => setColorPicker(menu),
            },
            {
              label: 'Add divider below',
              action: () => useAppStore.getState().addDividerAfter(project.id),
            },
            ...buildProjectMenuItems({
              projectId: project.id,
              projectName: project.name,
              onRename: () => {
                const store = useAppStore.getState();
                store.setSidebarProject(project.id);
                store.setFocusedProject(project.id);
                store.setProjectSettingsOpen(true);
              },
            }).map((item, i) => (i === 0 ? { ...item, divider: true } : item)),
          ]}
          position={menu}
          onClose={() => setMenu(null)}
        />
      )}
      {colorPicker && (
        <ProjectColorPopover
          projectId={project.id}
          position={colorPicker}
          onClose={() => setColorPicker(null)}
        />
      )}
    </div>
  );
}

/**
 * The always-visible leftmost project switcher — Zen browser compact mode.
 * At rest it is a slim icon-only strip (bare hue-tinted initials per project);
 * hovering (or keyboard-focusing) it floats a full-width glass sheet OVER the
 * sections column, revealing labels plus live jump-to session previews per
 * project. It collapses back when the pointer leaves. Rows: Home, Add-project,
 * then the user-ordered list of glass project pills and dividers (drag any row
 * to reorder; order persists via GlobalConfig.ui.projectNav). Picking a
 * project reveals its sections in the adjacent column without disturbing the
 * main pane; clicking a session preview jumps straight to that session.
 * `alwaysExpanded` renders the static full-width column with no hover
 * behavior; `compact` (mobile drawer) renders the static icon-only strip — no
 * hover/focus expansion and no drag — so the narrow drawer keeps its width for
 * the sections column and identity is carried by the tinted initials alone.
 */
export function ProjectRail({
  alwaysExpanded = false,
  compact = false,
}: {
  alwaysExpanded?: boolean;
  compact?: boolean;
}) {
  const projects = useAppStore((s) => s.projects);
  const projectNav = useAppStore((s) => s.projectNav);
  const setProjectNavEntries = useAppStore((s) => s.setProjectNavEntries);
  const selectedProcessId = useAppStore((s) => s.selectedProcessId);
  const projectOverviewOpen = useAppStore((s) => s.projectOverviewOpen);
  const setAddProjectModalOpen = useAppStore((s) => s.setAddProjectModalOpen);
  const dark = useIsDark();
  const [homeHover, setHomeHover] = useState(false);
  const [addHover, setAddHover] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // An open right-click menu portals outside the rail, so pointer-leave must
  // not collapse the rail underneath it.
  const [menuPinned, setMenuPinned] = useState(false);
  const enterTimer = useRef<number | undefined>(undefined);
  const leaveTimer = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      window.clearTimeout(enterTimer.current);
      window.clearTimeout(leaveTimer.current);
    },
    [],
  );

  const railEntries = useMemo(() => orderRailEntries(projects, projectNav), [projects, projectNav]);

  const { dragEntryId, dropIndex, dragging, getEntryProps } = useRailReorder({
    containerRef: listRef,
    entries: railEntries,
    disabled: compact,
    onCommit: setProjectNavEntries,
  });

  // Pin the sheet open for the drag's duration — collapsing mid-drag would
  // reflow the rows under the pointer.
  const open = !compact && (alwaysExpanded || expanded || menuPinned || dragging);

  const onEnter = () => {
    window.clearTimeout(leaveTimer.current);
    enterTimer.current = window.setTimeout(() => setExpanded(true), EXPAND_DELAY_MS);
  };
  const onLeave = () => {
    if (dragging) return;
    window.clearTimeout(enterTimer.current);
    leaveTimer.current = window.setTimeout(() => setExpanded(false), COLLAPSE_DELAY_MS);
  };
  // Jump-to from a session preview: collapse immediately so the landing feels
  // instant (no 140ms grace lag over the freshly-swapped sections column).
  const collapseNow = () => {
    window.clearTimeout(enterTimer.current);
    window.clearTimeout(leaveTimer.current);
    setExpanded(false);
  };

  const dragEntry = dragEntryId ? railEntries.find((e) => e.id === dragEntryId) : undefined;
  const dropColor =
    dragEntry?.kind === 'project'
      ? getProjectColor(dragEntry.id, dark).dot
      : 'var(--accent-amber)';

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

      {/* The tab list — user-ordered project pills + dividers, drag to
          reorder. Right margin folds the container's 8px padding into the
          scroll area so the active pill's edge-bleed can reach the true rail
          edge (overflow clips at the padding box). */}
      <div
        ref={listRef}
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
          marginRight: -8,
          paddingRight: 8,
        }}
      >
        {railEntries.map((entry, i) =>
          entry.kind === 'divider' ? (
            <RailDivider
              key={entry.id}
              id={entry.id}
              dragging={dragEntryId === entry.id}
              dropBefore={dropIndex === i && dragging}
              dropColor={dropColor}
              entryProps={compact ? undefined : getEntryProps(entry.id)}
              onMenuOpenChange={setMenuPinned}
            />
          ) : (
            <ProjectRailItem
              key={entry.id}
              project={entry.project}
              open={open}
              allowEdgeBleed={!open && !compact}
              dragging={dragEntryId === entry.id}
              dropBefore={dropIndex === i && dragging}
              dropColor={dropColor}
              entryProps={compact ? undefined : getEntryProps(entry.id)}
              onMenuOpenChange={setMenuPinned}
              onNavigate={collapseNow}
            />
          ),
        )}
        {dragging && dropIndex === railEntries.length && (
          <div
            aria-hidden
            style={{
              height: 2,
              margin: '0 2px',
              borderRadius: 1,
              background: dropColor,
              flexShrink: 0,
            }}
          />
        )}
      </div>
    </>
  );

  if (alwaysExpanded || compact) {
    return (
      <div
        style={{
          width: compact ? RAIL_COLLAPSED : RAIL_EXPANDED,
          flexShrink: 0,
          height: '100%',
          // Transparent — the pills float on the shell glass + ambient bloom.
          background: 'transparent',
          display: 'flex',
          flexDirection: 'column',
          padding: '10px 8px 12px',
          gap: 6,
          overflow: 'hidden',
          borderRight: compact ? '1px solid var(--glass-border)' : undefined,
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
