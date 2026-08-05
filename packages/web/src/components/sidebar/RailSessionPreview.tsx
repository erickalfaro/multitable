import React, { useState } from 'react';
import {
  useAppStore,
  useRailSessionSnippet,
  useRailSessionAttention,
} from '../../stores/appStore';
import { SessionStatusLoader } from './SessionStatusLoader';
import { dockOutline, dockPool } from '../../lib/emphasis';
import { projectHueCss } from '../../lib/metalPalette';
import { useIsDark } from '../../hooks/useIsDark';
import { RAIL_MARK_COL } from '../../lib/railGeometry';
import { buildSessionMenuItems } from '../../lib/sessionMenuItems';
import { ContextMenu } from '../context-menu/ContextMenu';
import { RailTipTitle, RailTipSub, useRailTooltip } from './RailTooltip';

/**
 * Session under a project on the rail — just the status mark in the fixed
 * 60px column. Name + live snippet appear in the shared RailTooltip on hover
 * dwell / focus. Right-click opens the same session menu as the Agents list.
 */
export function RailSessionPreview({ sessionId }: { sessionId: string }) {
  const session = useAppStore((s) => s.sessions[sessionId]);
  const selected = useAppStore((s) => s.selectedProcessId === sessionId);
  const attention = useRailSessionAttention(sessionId);
  const dark = useIsDark();
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const tip = useRailTooltip();

  if (!session) return null;

  const jump = (e: React.MouseEvent) => {
    e.stopPropagation();
    const store = useAppStore.getState();
    store.clearMultiSelectedSessions();
    store.setSelectedProcess(sessionId);
  };

  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const selectHue = projectHueCss(session.projectId, dark);
  // Content is a component so the snippet stays LIVE while the tooltip is
  // open (streaming text updates render through the portal).
  const tipContent = <SessionTipContent sessionId={sessionId} />;
  // Selected session is ALWAYS open on the right — never a closed box.
  const pool = selected
    ? {
        ...dockPool(selectHue, { fill: 10, tone: 'medium' }),
        ...dockOutline(selectHue),
      }
    : hover
      ? {
          background: 'color-mix(in oklch, var(--text-primary) 5%, transparent)',
          boxShadow: 'none',
          border: 'none',
        }
      : { background: 'transparent', boxShadow: 'none', border: 'none' };

  return (
    <>
      <button
        type="button"
        data-rail-session={sessionId}
        data-selected={selected ? 'true' : undefined}
        className={'mt-rail-session' + (selected ? ' is-docked is-docked-open' : '')}
        onClick={jump}
        onContextMenu={openMenu}
        onMouseEnter={(e) => {
          setHover(true);
          tip?.show(e.currentTarget, tipContent, selectHue);
        }}
        onMouseLeave={() => {
          setHover(false);
          tip?.hide();
        }}
        onFocus={(e) => tip?.showNow(e.currentTarget, tipContent, selectHue)}
        onBlur={() => tip?.hide()}
        aria-label={session.name}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          width: '100%',
          height: 30,
          padding: 0,
          margin: 0,
          border: 'none',
          borderRadius: 0,
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          opacity: selected ? 1 : 0.82,
          ...pool,
          flexShrink: 0,
          position: 'relative',
          transition:
            'background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)',
        }}
      >
        <span
          aria-hidden
          style={{
            width: RAIL_MARK_COL,
            minWidth: RAIL_MARK_COL,
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            paddingLeft: 6,
          }}
        >
          <SessionStatusLoader
            loaderVariant={session.loaderVariant}
            state={session.state}
            projectId={session.projectId}
            size={11}
            active={session.state === 'running'}
          />
        </span>
        {attention ? (
          // The Bell used to sit in the expanded label column; collapsed rows
          // signal attention with a small amber dot beside the mark instead.
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: 5,
              left: RAIL_MARK_COL - 18,
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: 'var(--accent-amber)',
              pointerEvents: 'none',
            }}
          />
        ) : null}
      </button>

      {menu && (
        <ContextMenu
          items={buildSessionMenuItems(session)}
          position={menu}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

/** Tooltip body: session name + the live activity snippet, updating in place. */
function SessionTipContent({ sessionId }: { sessionId: string }) {
  const name = useAppStore((s) => s.sessions[sessionId]?.name);
  const snippet = useRailSessionSnippet(sessionId);
  if (!name) return null;
  return (
    <>
      <RailTipTitle>{name}</RailTipTitle>
      {snippet ? <RailTipSub>{snippet}</RailTipSub> : null}
    </>
  );
}
