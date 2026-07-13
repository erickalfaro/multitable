/**
 * Left project rail — rebuilt from first principles.
 *
 * Structure:
 *   OUTER shell: clips to 60px idle, expands to 188px on hover (750ms dwell)
 *   INNER track: always 188px wide
 *   Each row: [ 60px mark column | label column ]
 *
 * Collapsed, overflow clips the label column — only the mark column is
 * visible, and marks are flex-centered in that 60px. Expand reveals labels
 * without moving the marks.
 */

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
import { ProjectGlyphPopover } from './ProjectGlyphPopover';
import { buildProjectMenuItems } from '../../lib/projectActions';
import { ContextMenu } from '../context-menu/ContextMenu';
import { LogoArt } from './LogoArt';
import { CATEGORY_COLOR_VAR, CATEGORY_ICON } from '../../lib/alertVisuals';
import { ProjectGlyphIcon } from './ProjectGlyphIcon';
import { RAIL_COLLAPSED, RAIL_EXPANDED, RAIL_MARK_COL } from '../../lib/railGeometry';


const EXPAND_DELAY_MS = 750;
const COLLAPSE_DELAY_MS = 140;
const ROW_H = 38;

function projectInitials(name: string): string {
  const words = name.trim().split(/[\s_\-/]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** 60×full-height cell — content dead-center (home / add icons). */
function MarkCell({
  children,
  color,
  strong,
}: {
  children: React.ReactNode;
  color?: string;
  strong?: boolean;
}) {
  return (
    <span
      aria-hidden
      style={{
        width: RAIL_MARK_COL,
        minWidth: RAIL_MARK_COL,
        maxWidth: RAIL_MARK_COL,
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        color,
        fontSize: 12.5,
        fontWeight: strong ? 700 : 600,
        letterSpacing: '0.02em',
        opacity: strong ? 1 : 0.85,
      }}
    >
      {children}
    </span>
  );
}

/** Emblem size — deliberately larger and more “object” than session status. */
const PROJECT_TILE = 34;

/**
 * Project monogram emblem.
 *
 * This is the entire project identity language. It is NOT a list-row chip:
 * circular stamp, solid material, monogram type. Selection / ownership /
 * hover all live on this disc — never a full-width session-style wash.
 */
function ProjectMark({
  hue,
  active,
  ownsSelection,
  hover,
  dark,
  children,
}: {
  hue: string;
  active: boolean;
  ownsSelection: boolean;
  hover: boolean;
  dark: boolean;
  children: React.ReactNode;
}) {
  const lit = active || ownsSelection;
  const base = dark ? 'oklch(18% 0.02 280)' : 'oklch(94% 0.01 80)';
  const baseLift = dark ? 'oklch(28% 0.025 280)' : 'oklch(98% 0.008 80)';
  const ink = dark ? 'oklch(96% 0.02 90)' : 'oklch(22% 0.03 280)';
  const plate: React.CSSProperties = active
    ? {
        // Solid workspace seal
        background: `linear-gradient(
          155deg,
          color-mix(in oklch, ${hue} 42%, ${baseLift}) 0%,
          color-mix(in oklch, ${hue} 26%, ${base}) 100%
        )`,
        boxShadow: [
          `inset 0 1px 0 color-mix(in oklch, ${hue} 50%, white)`,
          `inset 0 -1px 0 oklch(0% 0 0 / ${dark ? 0.35 : 0.08})`,
          `0 0 0 1.5px color-mix(in oklch, ${hue} 70%, transparent)`,
          `0 0 18px 0 color-mix(in oklch, ${hue} ${dark ? 45 : 28}%, transparent)`,
        ].join(', '),
        color: ink,
        opacity: 1,
      }
    : ownsSelection
      ? {
          background: `color-mix(in oklch, ${hue} 18%, ${base})`,
          boxShadow: [
            `inset 0 1px 0 color-mix(in oklch, ${hue} 28%, transparent)`,
            `0 0 0 1.5px color-mix(in oklch, ${hue} 58%, transparent)`,
          ].join(', '),
          color: hue,
          opacity: 1,
        }
      : hover
        ? {
            background: `color-mix(in oklch, ${hue} 14%, ${baseLift})`,
            boxShadow: `0 0 0 1px color-mix(in oklch, ${hue} 40%, transparent)`,
            color: hue,
            opacity: 1,
          }
        : {
            // Quiet stamp at rest — still a disc, never a list glyph
            background: `color-mix(in oklch, ${base} 88%, transparent)`,
            boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${hue} 24%, transparent)`,
            color: `color-mix(in oklch, ${hue} 70%, var(--text-secondary))`,
            opacity: 0.92,
          };

  return (
    <span
      aria-hidden
      data-project-mark=""
      style={{
        width: RAIL_MARK_COL,
        minWidth: RAIL_MARK_COL,
        maxWidth: RAIL_MARK_COL,
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: PROJECT_TILE,
          height: PROJECT_TILE,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: lit ? 12 : 11,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
          transition:
            'background var(--dur-med) var(--ease-out), box-shadow var(--dur-med) var(--ease-out), color var(--dur-med) var(--ease-out), transform var(--dur-med) var(--ease-out), opacity var(--dur-fast) var(--ease-out)',
          transform: active ? 'scale(1.08)' : hover ? 'scale(1.03)' : 'scale(1)',
          ...plate,
        }}
      >
        {children}
      </span>
    </span>
  );
}

/** Full-width (188px) row shell shared by home / add / project / session. */
function RailRow({
  children,
  height = ROW_H,
  onClick,
  onMouseEnter,
  onMouseLeave,
  onContextMenu,
  title,
  ariaLabel,
  ariaCurrent,
  background,
  opacity = 1,
  className,
  style,
}: {
  children: React.ReactNode;
  height?: number;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  title?: string;
  ariaLabel?: string;
  ariaCurrent?: boolean | 'true' | 'false' | 'page' | 'step' | 'location' | 'date' | 'time';
  background?: string;
  opacity?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onContextMenu={onContextMenu}
      title={title}
      aria-label={ariaLabel}
      aria-current={ariaCurrent}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        width: RAIL_EXPANDED,
        minWidth: RAIL_EXPANDED,
        height,
        padding: 0,
        margin: 0,
        border: 'none',
        borderRadius: 0,
        cursor: 'pointer',
        fontFamily: 'inherit',
        textAlign: 'left',
        background: background ?? 'transparent',
        opacity,
        flexShrink: 0,
        position: 'relative',
        overflow: 'visible',
        transition:
          'background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out)',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function LabelCell({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <span
      style={{
        flex: 1,
        minWidth: 0,
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 10,
        paddingRight: 10,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
        fontSize: 12.5,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function DropLine({ color }: { color: string }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        top: -4,
        left: 8,
        right: 8,
        height: 2,
        borderRadius: 1,
        background: color,
        pointerEvents: 'none',
        zIndex: 5,
      }}
    />
  );
}

interface EntryDragProps {
  onPointerDown: (e: React.PointerEvent) => void;
  onClickCapture: (e: React.MouseEvent) => void;
}

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
        width: RAIL_EXPANDED,
        padding: '6px 0',
        cursor: entryProps ? 'grab' : 'default',
        opacity: dragging ? 0.4 : 1,
        touchAction: entryProps ? 'none' : undefined,
      }}
    >
      {dropBefore && <DropLine color={dropColor} />}
      <div
        style={{
          height: 1.5,
          margin: '0 12px',
          borderRadius: 1,
          background: hover
            ? 'linear-gradient(90deg, transparent, var(--border-strong) 20%, var(--border-strong) 80%, transparent)'
            : 'linear-gradient(90deg, transparent, color-mix(in oklch, var(--text-muted) 45%, transparent) 25% 75%, transparent)',
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

function ProjectRailItem({
  project,
  dragging,
  dropBefore,
  dropColor,
  entryProps,
  onMenuOpenChange,
  onNavigate,
}: {
  project: Project;
  dragging: boolean;
  dropBefore: boolean;
  dropColor: string;
  entryProps?: EntryDragProps;
  onMenuOpenChange?: (open: boolean) => void;
  onNavigate?: () => void;
}) {
  const color = useProjectColor(project.id);
  const dark = useIsDark();
  const active = useAppStore((s) => s.sidebarProjectId === project.id);
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
  const previewIds = useRailPreviewSessionIds(project.id, true);
  const glyphId = useAppStore((s) => s.projectNav.glyphs?.[project.id] ?? null);
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [colorPicker, setColorPicker] = useState<{ x: number; y: number } | null>(null);
  const [glyphPicker, setGlyphPicker] = useState<{ x: number; y: number } | null>(null);
  // Session preview menus also pin the rail sheet open.
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);

  useEffect(() => {
    onMenuOpenChange?.(
      menu !== null ||
        colorPicker !== null ||
        glyphPicker !== null ||
        sessionMenuOpen,
    );
  }, [menu, colorPicker, glyphPicker, sessionMenuOpen, onMenuOpenChange]);

  const select = () => {
    const store = useAppStore.getState();
    store.setSidebarProject(project.id);
    store.setFocusedProject(project.id);
  };

  const hue = color.dot;
  // Projects never use open-right dock chrome — only the circular emblem.
  // Open-right + panel left-gap are session-only (see RailSessionPreview).
  const markLit = active || ownsSelection;

  return (
    <div
      data-rail-entry={project.id}
      {...entryProps}
      style={{
        position: 'relative',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        // Sessions nest under the emblem with a little breathing room
        gap: 2,
        width: RAIL_EXPANDED,
        opacity: dragging ? 0.4 : 1,
        touchAction: entryProps ? 'none' : undefined,
        // Separate project clusters from each other
        marginBottom: 4,
      }}
    >
      {dropBefore && <DropLine color={dropColor} />}
      <RailRow
        className="mt-rail-pill mt-rail-project"
        height={44}
        onClick={select}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title={`${project.name}\n${project.path}`}
        ariaLabel={project.name}
        ariaCurrent={active}
        opacity={1}
        style={{
          // No session-style row chrome — the circular emblem is the control.
          background: 'transparent',
          border: 'none',
          boxShadow: 'none',
        }}
      >
        <ProjectMark
          hue={hue}
          active={active}
          ownsSelection={ownsSelection}
          hover={hover}
          dark={dark}
        >
          {glyphId ? (
            <ProjectGlyphIcon id={glyphId} size={18} />
          ) : (
            projectInitials(project.name)
          )}
        </ProjectMark>
        <LabelCell
          style={{
            fontWeight: active ? 650 : 500,
            fontSize: 13,
            letterSpacing: '0.01em',
            color: active
              ? 'var(--text-primary)'
              : ownsSelection
                ? 'var(--text-secondary)'
                : 'var(--text-muted)',
          }}
        >
          {project.name}
        </LabelCell>
        {total > 0 && (() => {
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
                left: RAIL_MARK_COL - 16,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 14,
                height: 14,
                padding: '0 3px',
                borderRadius: 'var(--radius-pill)',
                color: tint,
                fontSize: 8.5,
                fontWeight: 700,
                zIndex: 2,
              }}
            >
              <BadgeIcon size={8} />
              {total}
            </span>
          );
        })()}
      </RailRow>

      {previewIds.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, width: RAIL_EXPANDED }}>
          {previewIds.map((sessionId) => (
            <RailSessionPreview
              key={sessionId}
              sessionId={sessionId}
              onNavigate={onNavigate}
              onMenuOpenChange={setSessionMenuOpen}
            />
          ))}
        </div>
      )}

      {menu && (
        <ContextMenu
          items={[
            {
              label: 'Change glyph…',
              action: () => setGlyphPicker(menu),
            },
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
      {glyphPicker && (
        <ProjectGlyphPopover
          projectId={project.id}
          position={glyphPicker}
          onClose={() => setGlyphPicker(null)}
        />
      )}
    </div>
  );
}

export function ProjectRail({
  alwaysExpanded = false,
  compact = false,
  sectionsHidden = false,
}: {
  alwaysExpanded?: boolean;
  compact?: boolean;
  /** @deprecated */
  sectionsHidden?: boolean;
}) {
  const projects = useAppStore((s) => s.projects);
  const projectNav = useAppStore((s) => s.projectNav);
  const setProjectNavEntries = useAppStore((s) => s.setProjectNavEntries);
  const selectedProcessId = useAppStore((s) => s.selectedProcessId);
  const sidebarProjectId = useAppStore((s) => s.sidebarProjectId);
  const projectOverviewOpen = useAppStore((s) => s.projectOverviewOpen);
  const setAddProjectModalOpen = useAppStore((s) => s.setAddProjectModalOpen);
  const dark = useIsDark();
  const [homeHover, setHomeHover] = useState(false);
  const [addHover, setAddHover] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [menuPinned, setMenuPinned] = useState(false);
  const enterTimer = useRef<number | undefined>(undefined);
  const leaveTimer = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);

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

  const open = !compact && (alwaysExpanded || expanded || menuPinned || dragging);

  // Panel left-gap + open-right dock are SESSION-only. Clicking a project
  // emblem must NOT open the frame — only a selected session does.
  useEffect(() => {
    const setSeam = useAppStore.getState().setRailSeamY;
    const list = listRef.current;
    const slot = slotRef.current;
    if (!list || !slot || !sidebarProjectId || !selectedProcessId) {
      setSeam(null);
      return;
    }
    let raf = 0;
    let cancelled = false;
    const measure = () => {
      raf = 0;
      if (cancelled) return;
      // Only a selected session row on the rail opens the panel.
      const mark = list.querySelector<HTMLElement>(
        `[data-rail-entry="${CSS.escape(sidebarProjectId)}"] [data-rail-session][data-selected="true"]`,
      );
      if (!mark) {
        setSeam(null);
        return;
      }
      const pr = mark.getBoundingClientRect();
      const lr = list.getBoundingClientRect();
      if (pr.bottom < lr.top || pr.top > lr.bottom) {
        setSeam(null);
        return;
      }
      const panel = slot
        .closest('.mt-sidebar-cluster')
        ?.querySelector<HTMLElement>('.mt-sections-panel');
      const originTop = panel?.getBoundingClientRect().top ?? slot.getBoundingClientRect().top;
      const openTop = Math.max(0, pr.top - originTop);
      const openBot = Math.max(openTop, pr.bottom - originTop);
      const y = (openTop + openBot) / 2;
      setSeam(y);
      if (panel) {
        panel.style.setProperty('--open-top', `${openTop}px`);
        panel.style.setProperty('--open-bot', `${openBot}px`);
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    list.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(list);
    ro.observe(slot);
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      list.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro.disconnect();
      setSeam(null);
    };
  }, [sidebarProjectId, selectedProcessId, railEntries, open, compact]);
  void sectionsHidden;

  const onEnter = () => {
    window.clearTimeout(leaveTimer.current);
    enterTimer.current = window.setTimeout(() => setExpanded(true), EXPAND_DELAY_MS);
  };
  const onLeave = () => {
    if (dragging) return;
    window.clearTimeout(enterTimer.current);
    leaveTimer.current = window.setTimeout(() => setExpanded(false), COLLAPSE_DELAY_MS);
  };
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

  /** Inner track — always full expanded width. Outer shell clips it. */
  const track = (
    <div
      style={{
        width: RAIL_EXPANDED,
        minWidth: RAIL_EXPANDED,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 8,
        paddingBottom: 10,
        gap: 2,
      }}
    >
      <RailRow
        height={40}
        onClick={goToDashboard}
        onMouseEnter={() => setHomeHover(true)}
        onMouseLeave={() => setHomeHover(false)}
        title="View all projects"
        ariaLabel="Home — view all projects"
        ariaCurrent={onDashboard}
        background={
          onDashboard || homeHover
            ? 'color-mix(in oklch, var(--text-primary) 5%, transparent)'
            : 'transparent'
        }
        opacity={onDashboard ? 1 : 0.72}
      >
        <MarkCell>
          <span style={{ display: 'flex', transform: 'scale(0.55)' }}>
            <LogoArt />
          </span>
        </MarkCell>
        <LabelCell
          style={{
            fontWeight: onDashboard ? 600 : 500,
            color: onDashboard ? 'var(--text-primary)' : 'var(--text-secondary)',
          }}
        >
          All projects
        </LabelCell>
      </RailRow>

      <RailRow
        height={36}
        onClick={() => setAddProjectModalOpen(true)}
        onMouseEnter={() => setAddHover(true)}
        onMouseLeave={() => setAddHover(false)}
        title="Add a new project"
        ariaLabel="Add a new project"
        background={
          addHover ? 'color-mix(in oklch, var(--text-primary) 5%, transparent)' : 'transparent'
        }
        opacity={0.72}
        style={{ color: addHover ? 'var(--text-secondary)' : 'var(--text-muted)' }}
      >
        <MarkCell>
          <Plus size={14} />
        </MarkCell>
        <LabelCell style={{ fontWeight: 500 }}>Add project</LabelCell>
      </RailRow>

      <div style={{ height: 4, flexShrink: 0 }} />

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
          gap: 4,
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
              margin: '0 12px',
              borderRadius: 1,
              background: dropColor,
              flexShrink: 0,
            }}
          />
        )}
      </div>
    </div>
  );

  // Mobile / always-expanded: no clip animation
  if (alwaysExpanded || compact) {
    const w = compact ? RAIL_COLLAPSED : RAIL_EXPANDED;
    return (
      <div
        ref={slotRef}
        className="mt-rail-gutter"
        style={{
          width: w,
          flex: `0 0 ${w}px`,
          height: '100%',
          overflow: 'hidden',
          background: 'transparent',
        }}
      >
        {track}
      </div>
    );
  }

  // Desktop: outer shell clips inner track
  return (
    <div
      ref={slotRef}
      className="mt-rail-gutter"
      style={{
        width: RAIL_COLLAPSED,
        flex: `0 0 ${RAIL_COLLAPSED}px`,
        height: '100%',
        position: 'relative',
        zIndex: 5,
        background: 'transparent',
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
        className={open ? 'mt-rail-sheet' : undefined}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: open ? RAIL_EXPANDED : RAIL_COLLAPSED,
          overflow: 'hidden',
          background: open ? undefined : 'transparent',
          transition:
            'width var(--dur-med) var(--ease-out), background var(--dur-med) var(--ease-out), box-shadow var(--dur-med) var(--ease-out)',
        }}
      >
        {track}
      </div>
    </div>
  );
}
