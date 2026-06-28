import { useMemo, type CSSProperties } from 'react';
import { Maximize2, X } from 'lucide-react';
import type { Session } from '../../../lib/types';
import { useAppStore } from '../../../stores/appStore';
import { SessionPane } from '../chat/SessionPane';
import { IconButton, AgentBadge } from '../../ui';
import { getProjectColor } from '../../../lib/projectColor';
import { BUILTIN_THEMES } from '../../../lib/themes';

interface Props {
  sessionId: string;
  session: Session;
}

/**
 * One tile in the Wall — wraps `<SessionPane density="wall">` with the
 * tile chrome:
 *   - hover-revealed header (project label · session name · expand · unpin)
 *   - focus ring on the focused tile (CSS rule in globals.css)
 *   - workspace tint (TODO Phase 5 — wired by wrapping in `<WorkspaceTint>`)
 *
 * Clicking anywhere on a non-focused tile focuses it (routes keyboard input
 * to its composer). Clicking the expand icon promotes the session to the
 * full main-pane view via selectedProcessId.
 */
export function SessionTile({ sessionId, session }: Props) {
  const focusedPaneId = useAppStore((s) => s.focusedPaneId);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  const setSelectedProcess = useAppStore((s) => s.setSelectedProcess);
  const togglePinSession = useAppStore((s) => s.togglePinSession);
  const projectName = useAppStore(
    (s) => s.projects.find((p) => p.id === session.projectId)?.name,
  );
  const isFocused = focusedPaneId === sessionId;
  const activeThemeId = useAppStore((s) => s.activeThemeId);
  const customThemes = useAppStore((s) => s.customThemes);
  const isDark = useMemo(() => {
    const all = [...BUILTIN_THEMES, ...customThemes];
    return all.find((t) => t.id === activeThemeId)?.isDark ?? true;
  }, [activeThemeId, customThemes]);
  const workspaceVars = useMemo<CSSProperties>(() => {
    const c = getProjectColor(session.projectId, isDark);
    return {
      ['--workspace-from' as any]: c.from,
      ['--workspace-to' as any]: c.to,
    };
  }, [session.projectId, isDark]);

  return (
    <article
      className="mt-wall-tile mt-workspace-tinted"
      data-focused={isFocused ? 'true' : undefined}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('button, input, textarea, a, [contenteditable="true"]')) return;
        if (!isFocused) setFocusedPane(sessionId);
      }}
      style={workspaceVars}
    >
      {/* Hover-reveal header — auto-hide pattern keeps the tile body the
          dominant signal at rest; on hover/focus the controls fade in. */}
      <header
        className="mt-auto-hide"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: '6px 10px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-elevated)',
          flexShrink: 0,
          minHeight: 32,
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
            fontSize: 12.5,
            fontWeight: 500,
            color: 'var(--text-primary)',
          }}
          title={`${projectName ?? ''} · ${session.name}`}
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
              maxWidth: 110,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {projectName}
          </span>
        )}
        <IconButton
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setSelectedProcess(sessionId);
          }}
          label="Open in full pane"
        >
          <Maximize2 size={12} />
        </IconButton>
        <IconButton
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            togglePinSession(sessionId);
          }}
          label="Unpin from Wall"
        >
          <X size={12} />
        </IconButton>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <SessionPane sessionId={sessionId} session={session} density="wall" />
      </div>
    </article>
  );
}
