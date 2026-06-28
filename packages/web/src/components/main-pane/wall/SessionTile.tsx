import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Maximize2, Sparkles, X } from 'lucide-react';
import toast from 'react-hot-toast';
import type { Session } from '../../../lib/types';
import { useAppStore } from '../../../stores/appStore';
import { api } from '../../../lib/api';
import { SessionPane } from '../chat/SessionPane';
import { ModelChip } from '../chat/ModelChip';
import { IconButton, AgentBadge, Spinner } from '../../ui';
import { getProjectColor } from '../../../lib/projectColor';
import { BUILTIN_THEMES } from '../../../lib/themes';

// NOTE: focus-on-click on the wall tile is intentionally dropped during the
// gridstack rewrite — the old article-level onClick conflicted with drag
// detection. Will reintroduce via gridstack's dragstart guard in a follow-up.

interface Props {
  sessionId: string;
  session: Session;
}

type Tier = 'roomy' | 'mid' | 'tiny';

function tierFor(width: number): Tier {
  if (width >= 400) return 'roomy';
  if (width >= 250) return 'mid';
  return 'tiny';
}

/**
 * Wall tile. The chrome flexes through three tiers based on observed tile
 * width: roomy (full 32px header + composer-friendly SessionPane density),
 * mid (compact 24px header), tiny (no header — 2px project-color stripe
 * is the only ID; pane drops to read-only `card` density).
 *
 * Tier switches happen automatically as the user drags the SE resize handle
 * — there's no setting; the tile reads its own ResizeObserver.
 *
 * `.mt-tile-drag-handle` on the header is the RGL drag grip; resizing
 * happens from the SE corner handle RGL renders.
 */
export function SessionTile({ sessionId, session }: Props) {
  const focusedPaneId = useAppStore((s) => s.focusedPaneId);
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
  const projectColor = useMemo(
    () => getProjectColor(session.projectId, isDark),
    [session.projectId, isDark],
  );
  const workspaceVars = useMemo<CSSProperties>(
    () => ({
      ['--workspace-from' as any]: projectColor.from,
      ['--workspace-to' as any]: projectColor.to,
    }),
    [projectColor],
  );

  const rootRef = useRef<HTMLElement | null>(null);
  const [tier, setTier] = useState<Tier>('roomy');
  const [aiLoading, setAiLoading] = useState(false);

  const handleAiRename = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (aiLoading) return;
    setAiLoading(true);
    try {
      const result = await api.sessions.renameAi(sessionId);
      toast.success(`Renamed to "${result.name}"`, { duration: 2200 });
    } catch (err: any) {
      const msg = err?.message || 'AI rename failed';
      toast.error(`AI rename: ${msg}`, { duration: 5000, style: { maxWidth: 480 } });
    } finally {
      setAiLoading(false);
    }
  };

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      const next = tierFor(w);
      setTier((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const density = tier === 'tiny' ? 'card' : 'wall';
  const headerH = tier === 'roomy' ? 32 : 24;
  const headerPad = tier === 'roomy' ? '6px 10px' : '3px 6px';

  return (
    <article
      ref={(el) => {
        rootRef.current = el;
      }}
      className={`mt-wall-tile mt-workspace-tinted mt-tile-${tier}`}
      data-focused={isFocused ? 'true' : undefined}
      style={workspaceVars}
    >
      {/* Tiny tier: no header bar — a 2px project-color stripe carries the
          identity instead. Hovering the tile still reveals action buttons
          in the top-right corner via .mt-tile-tiny-actions. */}
      {tier === 'tiny' ? (
        <>
          <div
            className="mt-tile-drag-handle"
            style={{
              height: 8,
              flexShrink: 0,
              background: `linear-gradient(90deg, ${projectColor.from}, ${projectColor.to})`,
              cursor: 'grab',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              touchAction: 'none',
            }}
            title={`${projectName ?? ''} · ${session.name} — drag to move`}
          />
          <div className="mt-tile-tiny-actions mt-auto-hide" style={tinyActionsStyle}>
            <AgentBadge provider={session.agentProvider} size="glyph" />
            <span style={tinyNameStyle} title={session.name}>
              {session.name}
            </span>
            <IconButton
              size="sm"
              onMouseDown={(e) => {
                e.preventDefault();
                handleAiRename(e);
              }}
              label="Rename with AI"
              disabled={aiLoading}
            >
              {aiLoading ? <Spinner size="sm" /> : <Sparkles size={11} />}
            </IconButton>
            <IconButton
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setSelectedProcess(sessionId);
              }}
              label="Open in full pane"
            >
              <Maximize2 size={11} />
            </IconButton>
            <IconButton
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                togglePinSession(sessionId);
              }}
              label="Unpin from Wall"
            >
              <X size={11} />
            </IconButton>
          </div>
        </>
      ) : (
        <header
          className="mt-auto-hide mt-tile-drag-handle"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: headerPad,
            borderBottom: `1px solid color-mix(in oklch, ${projectColor.from} 30%, var(--border))`,
            borderLeft: `3px solid ${projectColor.from}`,
            background: `linear-gradient(90deg, color-mix(in oklch, ${projectColor.from} 16%, var(--bg-elevated)), color-mix(in oklch, ${projectColor.to} 8%, var(--bg-elevated)))`,
            flexShrink: 0,
            minHeight: headerH,
            cursor: 'grab',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            touchAction: 'none',
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
              fontSize: tier === 'roomy' ? 12.5 : 11.5,
              fontWeight: 500,
              color: 'var(--text-primary)',
            }}
            title={`${projectName ?? ''} · ${session.name}`}
          >
            {session.name}
          </span>
          {tier === 'roomy' && projectName && (
            <span
              style={{
                fontSize: 10,
                color: `color-mix(in oklch, ${projectColor.from} 70%, var(--text-primary))`,
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                fontWeight: 600,
                maxWidth: 110,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {projectName}
            </span>
          )}
          {tier === 'roomy' && <ModelChip session={session} />}
          <IconButton
            size="sm"
            // mousedown so the global blur handler doesn't run first and
            // collapse the focused composer underneath us.
            onMouseDown={(e) => {
              e.preventDefault();
              handleAiRename(e);
            }}
            label="Rename with AI"
            disabled={aiLoading}
          >
            {aiLoading ? <Spinner size="sm" /> : <Sparkles size={tier === 'roomy' ? 12 : 11} />}
          </IconButton>
          <IconButton
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedProcess(sessionId);
            }}
            label="Open in full pane"
          >
            <Maximize2 size={tier === 'roomy' ? 12 : 11} />
          </IconButton>
          <IconButton
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              togglePinSession(sessionId);
            }}
            label="Unpin from Wall"
          >
            <X size={tier === 'roomy' ? 12 : 11} />
          </IconButton>
        </header>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <SessionPane sessionId={sessionId} session={session} density={density} />
      </div>
    </article>
  );
}

const tinyActionsStyle: CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 6,
  zIndex: 5,
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 4px',
  borderRadius: 6,
  background: 'color-mix(in oklch, var(--bg-elevated) 80%, transparent)',
  backdropFilter: 'blur(6px)',
};

const tinyNameStyle: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 500,
  color: 'var(--text-primary)',
  maxWidth: 100,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
