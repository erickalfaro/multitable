import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { StatusDot } from './StatusDot';
import { SessionStatusLoader } from './SessionStatusLoader';
import { Bell } from 'lucide-react';
import type { ManagedProcess, Session } from '../../lib/types';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';
import { AgentBadge, Spinner } from '../ui';
import { relativeTime } from '../../lib/relativeTime';
import {
  CATEGORY_COLOR_VAR,
  CATEGORY_ICON,
  dominantAlertForSession,
} from '../../lib/alertVisuals';
import { dockOutline, dockPool, emphasisPool } from '../../lib/emphasis';
import { projectHueCss } from '../../lib/metalPalette';
import { useIsDark } from '../../hooks/useIsDark';

interface Props {
  process: ManagedProcess;
  subtitle?: string;
  metrics?: string;
  isSelected: boolean;
  isMultiSelected?: boolean;
  // Handlers receive the row's process so parents can pass one stable
  // callback for every row — required for the React.memo below to hold.
  onClick: (process: ManagedProcess, e: React.MouseEvent) => void;
  onContextMenu: (process: ManagedProcess, e: React.MouseEvent) => void;
}

// Memoized: the sidebar renders one row per visible process and the parent
// list re-renders on live-state changes; rows whose props are unchanged must
// not re-run. Live indicators (streaming/permission/unread) come from the
// internal per-session selectors below, so memo can't hide them.
export const SidebarItem = React.memo(function SidebarItem({
  process,
  subtitle,
  metrics,
  isSelected,
  isMultiSelected = false,
  onClick,
  onContextMenu,
}: Props) {
  const permissionCount = useAppStore(s =>
    process.type === 'session'
      ? s.pendingPermissions.reduce(
          (n, p) => (p.sessionId === process.id ? n + 1 : n),
          0,
        )
      : 0,
  );
  const unreadAttention = useAppStore(s =>
    process.type === 'session' ? s.unreadBySession[process.id] ?? 0 : 0,
  );
  // Dominant category drives the badge tint when there are unread alerts.
  // Returns the category name so the selector returns a stable scalar (a
  // SessionAlert reference would re-fire the render on every alert update).
  const dominantCategory = useAppStore(s => {
    if (process.type !== 'session') return null;
    if ((s.unreadBySession[process.id] ?? 0) === 0) return null;
    return dominantAlertForSession(s.alerts, process.id)?.category ?? null;
  });
  const hasStreamingText = useAppStore(s =>
    process.type === 'session' ? Boolean(s.streamingBySession[process.id]) : false,
  );
  const hasToolProgress = useAppStore(s =>
    process.type === 'session' ? Boolean(s.toolProgressBySession[process.id]) : false,
  );
  const hasSessionStatus = useAppStore(s =>
    process.type === 'session' ? (s.statusBySession[process.id]?.status ?? null) !== null : false,
  );
  const pendingCount = permissionCount + unreadAttention;
  const sessionActive =
    process.type === 'session' &&
    (process.state === 'running' || hasStreamingText || hasToolProgress || hasSessionStatus);

  const isIdle =
    process.type === 'session' &&
    sessionActive &&
    !(process as any).claudeState?.currentTool;

  const sessionRecency =
    process.type === 'session'
      ? (process as Session).claudeState?.lastActivity ||
        (process as Session).lastActiveAt ||
        (process as Session).createdAt ||
        0
      : 0;

  const upsertSession = useAppStore((s) => s.upsertSession);
  const [aiRenaming, setAiRenaming] = useState(false);

  // Loader-icon shortcut: activates "Rename with AI" without selecting the row.
  const handleLoaderRename = async (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    if (process.type !== 'session' || aiRenaming) return;
    const session = process as Session;
    setAiRenaming(true);
    try {
      const result = await api.sessions.renameAi(session.id);
      upsertSession({ ...session, ...result.session });
      toast.success(`Renamed to "${result.name}"`, { duration: 2200 });
    } catch (err: any) {
      toast.error(`AI rename: ${err?.message || 'failed'}`, {
        duration: 5000,
        style: { maxWidth: 480 },
      });
    } finally {
      setAiRenaming(false);
    }
  };

  const sessionTags =
    process.type === 'session' ? ((process as Session).tags ?? []) : [];

  // Selected = soft fill + open-right straight outline (never a closed box —
  // the right edge stays open so the stroke can connect into the panel frame).
  const dark = useIsDark();
  const selectHue = projectHueCss(process.projectId, dark);

  const className =
    'mt-sidebar-item' +
    (isSelected ? ' is-selected is-docked-open' : '') +
    (isMultiSelected ? ' is-multi' : '');

  return (
    <div
      className={className}
      onClick={(e) => onClick(process, e)}
      onContextMenu={(e) => onContextMenu(process, e)}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '5px 10px 5px 8px',
        // Selected sessions bleed under the scrollbar gutter so the open-right
        // top/bottom strokes reach the panel frame (not stop short of it).
        margin: isSelected ? '0 -14px 0 0' : 0,
        paddingRight: isSelected ? 24 : 10,
        cursor: 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        position: 'relative',
        borderRadius: 0,
        zIndex: isSelected ? 1 : undefined,
        transition:
          'background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)',
        ...(isSelected
          ? {
              ...dockPool(selectHue, { fill: 12, tone: 'medium' }),
              ...dockOutline(selectHue),
            }
          : isMultiSelected
            ? emphasisPool(selectHue, { fill: 7, tone: 'soft' })
            : { background: 'transparent', boxShadow: 'none', border: 'none' }),
      }}
    >
      <div
        className={
          process.type === 'session'
            ? 'mt-loader-rename' + (aiRenaming ? ' is-renaming' : '')
            : undefined
        }
        onClick={process.type === 'session' ? handleLoaderRename : undefined}
        title={process.type === 'session' ? 'Rename with AI' : undefined}
        role={process.type === 'session' ? 'button' : undefined}
        tabIndex={process.type === 'session' ? 0 : undefined}
        onKeyDown={
          process.type === 'session'
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void handleLoaderRename(e);
                }
              }
            : undefined
        }
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: process.type === 'session' ? 18 : 12,
          flexShrink: 0,
          cursor: process.type === 'session' ? 'pointer' : undefined,
        }}
      >
        {process.type === 'session' ? (
          aiRenaming ? (
            <Spinner size="sm" />
          ) : (
            <SessionStatusLoader
              loaderVariant={(process as Session).loaderVariant ?? null}
              state={process.state}
              projectId={process.projectId}
              active={sessionActive}
              isIdle={isIdle}
            />
          )
        ) : (
          <StatusDot state={process.state} isIdle={isIdle} />
        )}
      </div>
      <div style={{ marginLeft: 10, flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13.5,
              lineHeight: 1.3,
              color: 'var(--text-primary)',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              wordBreak: 'break-word',
              fontWeight: isSelected ? 600 : 500,
            }}
          >
            {process.name}
          </span>
          {process.type === 'session' && (
            <AgentBadge
              provider={(process as Session).agentProvider}
              size="glyph"
              style={{ marginLeft: 4, flexShrink: 0 }}
            />
          )}
          {pendingCount > 0 && (() => {
            // When the badge is *only* unread alerts (no pending permissions),
            // pick up the dominant category's color + icon so the user can
            // tell an `auth` from a `budget` event at a glance. The amber
            // bell is kept for the permission-only and mixed states because
            // permission prompts are the one thing that always demands the
            // user's action regardless of category.
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
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 2,
                  marginLeft: 6,
                  color: tint,
                  fontSize: 10,
                  fontWeight: 600,
                  flexShrink: 0,
                  // Signal only — no border, no chip frame.
                }}
              >
                <BadgeIcon size={10} />
                {pendingCount}
              </span>
            );
          })()}
          {/* Right-side slot: always 22px tall so hover doesn't change row
              height and cause jitter as items reflow below. */}
          <div
            style={{
              position: 'relative',
              height: 22,
              marginLeft: 6,
              display: 'flex',
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            {metrics && (
              <span
                className="mt-sidebar-item-meta"
                style={{
                  fontSize: 11.5,
                  color: 'var(--text-muted)',
                  fontVariantNumeric: 'tabular-nums',
                  pointerEvents: 'none',
                }}
              >
                {metrics}
              </span>
            )}
            {!metrics && process.type === 'session' && sessionRecency > 0 && (
              <span
                title={new Date(sessionRecency).toLocaleString()}
                className="mt-sidebar-item-meta"
                style={{
                  fontSize: 10,
                  color: 'var(--text-muted)',
                  fontVariantNumeric: 'tabular-nums',
                  pointerEvents: 'none',
                }}
              >
                {relativeTime(sessionRecency)}
              </span>
            )}
          </div>
        </div>
        {/* Tags / topics — always visible by default. */}
        {sessionTags.length > 0 && (
          <div
            title={sessionTags.join(', ')}
            style={{
              marginTop: 2,
              fontSize: 10.5,
              lineHeight: 1.3,
              color: 'var(--text-faint)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {sessionTags.join(' · ')}
          </div>
        )}
        {subtitle && (
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginTop: 2,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
});
