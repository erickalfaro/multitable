import React, { useState } from 'react';
import { Bell } from 'lucide-react';
import {
  useAppStore,
  useRailSessionSnippet,
  useRailSessionAttention,
} from '../../stores/appStore';
import { SessionStatusLoader } from './SessionStatusLoader';
import { dockOutline, dockPool } from '../../lib/emphasis';
import { projectHueCss } from '../../lib/metalPalette';
import { useIsDark } from '../../hooks/useIsDark';
import { RAIL_EXPANDED, RAIL_MARK_COL } from '../../lib/railGeometry';

/**
 * Session under a project on the rail.
 * Row is always RAIL_EXPANDED wide; mark sits centered in the left RAIL_MARK_COL.
 * Parent clips to 60px when collapsed → mark is centered in the panel.
 */
export function RailSessionPreview({
  sessionId,
  onNavigate,
}: {
  sessionId: string;
  onNavigate?: () => void;
}) {
  const session = useAppStore((s) => s.sessions[sessionId]);
  const selected = useAppStore((s) => s.selectedProcessId === sessionId);
  const snippet = useRailSessionSnippet(sessionId);
  const attention = useRailSessionAttention(sessionId);
  const dark = useIsDark();
  const [hover, setHover] = useState(false);
  if (!session) return null;

  const jump = (e: React.MouseEvent) => {
    e.stopPropagation();
    const store = useAppStore.getState();
    store.clearMultiSelectedSessions();
    store.setSelectedProcess(sessionId);
    onNavigate?.();
  };

  const selectHue = projectHueCss(session.projectId, dark);
  // Selected session is ALWAYS open on the right — never a closed box.
  // That open edge meets the panel's left gap when this project is viewed.
  const title = snippet ? `${session.name}\n${snippet}` : session.name;
  // Sessions = thin activity rows (not project identity tiles).
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
    <button
      type="button"
      data-rail-session={sessionId}
      data-selected={selected ? 'true' : undefined}
      className={'mt-rail-session' + (selected ? ' is-docked is-docked-open' : '')}
      onClick={jump}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      aria-label={session.name}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        width: RAIL_EXPANDED,
        minWidth: RAIL_EXPANDED,
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
        transition:
          'background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)',
      }}
    >
      {/* Nested under the project emblem — small status, not a monogram. */}
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
          // Pull status slightly right so it reads as a child of the disc above
          paddingLeft: 6,
        }}
      >
        <SessionStatusLoader
          loaderVariant={session.loaderVariant}
          state={session.state}
          projectId={session.projectId}
          size={11}
          // Live only — quiet 24h jump-backs keep a resting glyph.
          active={session.state === 'running'}
        />
      </span>

      {/* Label column — revealed when parent shell expands */}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingRight: 10,
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 0,
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: selected ? 560 : 450,
              lineHeight: 1.25,
              color: selected ? 'var(--text-primary)' : 'var(--text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {session.name}
          </span>
          <span
            style={{
              fontSize: 10,
              lineHeight: 1.2,
              color: 'var(--text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
              minHeight: 12,
            }}
          >
            {snippet || '\u00a0'}
          </span>
        </span>
        {attention ? (
          <span
            aria-hidden
            style={{
              flexShrink: 0,
              color: 'var(--accent-amber)',
              display: 'inline-flex',
            }}
          >
            <Bell size={9} />
          </span>
        ) : null}
      </span>
    </button>
  );
}
