import React from 'react';
import { StatusDot } from './StatusDot';
import { SessionStatusLoader } from './SessionStatusLoader';
import { Bell, Square } from 'lucide-react';
import type { ManagedProcess, Session } from '../../lib/types';
import { api, stopProcessByType } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';
import { IconButton, AgentBadge } from '../ui';
import { relativeTime } from '../../lib/relativeTime';

interface Props {
  process: ManagedProcess;
  subtitle?: string;
  metrics?: string;
  isSelected: boolean;
  isMultiSelected?: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export function SidebarItem({
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

  const className =
    'mt-sidebar-item' +
    (isSelected ? ' is-selected' : '') +
    (isMultiSelected ? ' is-multi' : '');

  return (
    <div
      className={className}
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '4px 10px 4px 9px',
        margin: '1px 0',
        cursor: 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        position: 'relative',
        borderRadius: 'var(--radius-snug)',
        backgroundColor: isSelected
          ? 'var(--bg-elevated)'
          : isMultiSelected
            ? 'var(--bg-hover)'
            : 'transparent',
        borderLeft: isSelected
          ? '3px solid var(--accent-amber)'
          : isMultiSelected
            ? '3px solid var(--accent-amber-dim)'
            : '3px solid transparent',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 12,
          flexShrink: 0,
        }}
      >
        {process.type === 'session' ? (
          <SessionStatusLoader
            loaderVariant={(process as Session).loaderVariant ?? null}
            state={process.state}
            projectId={process.projectId}
            active={sessionActive}
            isIdle={isIdle}
          />
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
          {pendingCount > 0 && (
            <span
              title={
                permissionCount > 0 && unreadAttention > 0
                  ? `${permissionCount} permission${permissionCount === 1 ? '' : 's'} pending, ${unreadAttention} unread alert${unreadAttention === 1 ? '' : 's'}`
                  : permissionCount > 0
                    ? `${permissionCount} confirmation${permissionCount === 1 ? '' : 's'} pending`
                    : `${unreadAttention} unread alert${unreadAttention === 1 ? '' : 's'}`
              }
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                marginLeft: 6,
                padding: '1px 6px',
                borderRadius: 'var(--radius-snug)',
                background: 'transparent',
                color: 'var(--accent-amber)',
                border: '1px solid var(--accent-amber)',
                fontSize: 9.5,
                fontWeight: 500,
                letterSpacing: '0.06em',
                flexShrink: 0,
                animation: 'mt-pulse 1.6s ease-in-out infinite',
              }}
            >
              <Bell size={9} />
              {pendingCount}
            </span>
          )}
          {/* Right-side slot: always 22px tall so hover doesn't change row
              height and cause jitter as items reflow below. Metrics and the
              Stop button share the slot and cross-fade via opacity. */}
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
                className={
                  process.state === 'running' ? 'mt-sidebar-item-meta hide-on-hover' : 'mt-sidebar-item-meta'
                }
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
                className={
                  process.state === 'running' ? 'mt-sidebar-item-meta hide-on-hover' : 'mt-sidebar-item-meta'
                }
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
            {process.state === 'running' && (
              <div
                className="mt-sidebar-item-actions"
                style={{
                  position: 'absolute',
                  right: 0,
                  top: 0,
                  display: 'flex',
                  gap: 2,
                }}
              >
                <IconButton
                  size="sm"
                  label="Stop"
                  onClick={(e) => {
                    e.stopPropagation();
                    stopProcessByType(process).catch(() => {/* swallow */});
                  }}
                >
                  <Square size={11} />
                </IconButton>
              </div>
            )}
          </div>
        </div>
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
}
