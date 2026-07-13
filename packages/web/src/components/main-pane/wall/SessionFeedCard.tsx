import { useMemo, type CSSProperties } from 'react';
import type { Session } from '../../../lib/types';
import { useAppStore } from '../../../stores/appStore';
import { SessionPane } from '../chat/SessionPane';
import { AgentBadge } from '../../ui';
import { getProjectColor } from '../../../lib/projectColor';
import { BUILTIN_THEMES } from '../../../lib/themes';

interface Props {
  sessionId: string;
  session: Session;
}

/**
 * Mobile Pinned Feed card (plan §5.8). Read-only — no composer, no
 * permission bar, no reasoning/tool cards. The whole card is a button:
 * tap to drill into the full SessionPane via setSelectedProcess.
 */
export function SessionFeedCard({ sessionId, session }: Props) {
  const setSelectedProcess = useAppStore((s) => s.setSelectedProcess);
  const projectName = useAppStore(
    (s) => s.projects.find((p) => p.id === session.projectId)?.name,
  );
  const activeThemeId = useAppStore((s) => s.activeThemeId);
  const customThemes = useAppStore((s) => s.customThemes);
  const isDark = useMemo(() => {
    const all = [...BUILTIN_THEMES, ...customThemes];
    return all.find((t) => t.id === activeThemeId)?.isDark ?? true;
  }, [activeThemeId, customThemes]);
  // Manual hue override — subscribing keeps the card live when the user
  // recolors the project from the rail.
  const colorOverride = useAppStore((s) => s.projectNav.colors?.[session.projectId] ?? null);
  const workspaceVars = useMemo<CSSProperties>(() => {
    void colorOverride;
    const c = getProjectColor(session.projectId, isDark);
    return {
      ['--workspace-from' as any]: c.from,
      ['--workspace-to' as any]: c.to,
    };
  }, [session.projectId, isDark, colorOverride]);

  return (
    // Not a <button> — SessionPane contains interactive children, and
    // nesting button-in-button is invalid HTML. Use role=button + keyboard
    // handler so taps and Enter/Space behave like a button anyway.
    <div
      role="button"
      tabIndex={0}
      onClick={() => setSelectedProcess(sessionId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setSelectedProcess(sessionId);
        }
      }}
      className="mt-wall-tile mt-workspace-tinted"
      style={{
        textAlign: 'left',
        cursor: 'pointer',
        padding: 0,
        minHeight: 180,
        maxHeight: 280,
        width: '100%',
        ...workspaceVars,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <AgentBadge provider={session.agentProvider} size="glyph" />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 14,
            fontWeight: 500,
            color: 'var(--text-primary)',
          }}
        >
          {session.name}
        </span>
        {projectName && (
          <span
            style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              maxWidth: 120,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {projectName}
          </span>
        )}
      </header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <SessionPane sessionId={sessionId} session={session} density="card" />
      </div>
    </div>
  );
}
