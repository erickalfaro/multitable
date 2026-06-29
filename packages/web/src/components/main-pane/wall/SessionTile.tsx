import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
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

interface Props {
  sessionId: string;
  session: Session;
  locked: boolean;
  onDragStart: (sessionId: string, e: ReactPointerEvent) => void;
  onResizeStart: (sessionId: string, e: ReactPointerEvent) => void;
}

type Tier = 'roomy' | 'mid' | 'tiny';

function tierFor(width: number): Tier {
  if (width >= 400) return 'roomy';
  if (width >= 250) return 'mid';
  return 'tiny';
}

/**
 * Wall tile. The chrome flexes through three tiers based on observed tile
 * width: roomy (full 32px header), mid (compact 24px header), tiny (no header —
 * a 2px project-color stripe is the only ID; pane drops to read-only `card`).
 *
 * The header / stripe is the drag grip (pointer-down anywhere on it that isn't
 * a button begins a move); the SE corner handle begins a resize. Both delegate
 * to the wall's drag controller — the tile never touches layout state itself.
 */
function SessionTileImpl({ sessionId, session, locked, onDragStart, onResizeStart }: Props) {
  const setSelectedProcess = useAppStore((s) => s.setSelectedProcess);
  const togglePinSession = useAppStore((s) => s.togglePinSession);
  const focusedPaneId = useAppStore((s) => s.focusedPaneId);
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
      ['--workspace-from' as string]: projectColor.from,
      ['--workspace-to' as string]: projectColor.to,
    }),
    [projectColor],
  );

  const rootRef = useRef<HTMLElement | null>(null);
  const [tier, setTier] = useState<Tier>('roomy');
  const [aiLoading, setAiLoading] = useState(false);

  const handleAiRename = async () => {
    if (aiLoading) return;
    setAiLoading(true);
    try {
      const result = await api.sessions.renameAi(sessionId);
      toast.success(`Renamed to "${result.name}"`, { duration: 2200 });
    } catch (err) {
      const msg = (err as { message?: string })?.message || 'AI rename failed';
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

  // Pointer-down on the grip starts a move — unless it landed on a button.
  const onGripPointerDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input')) return;
    onDragStart(sessionId, e);
  };

  const density = tier === 'tiny' ? 'card' : 'wall';
  const headerH = tier === 'roomy' ? 32 : 24;
  const headerPad = tier === 'roomy' ? '6px 10px' : '3px 6px';
  const iconSize = tier === 'roomy' ? 12 : 11;

  return (
    <article
      ref={(el) => {
        rootRef.current = el;
      }}
      className={`mt-wall-tile mt-workspace-tinted mt-tile-${tier}`}
      data-focused={isFocused ? 'true' : undefined}
      style={workspaceVars}
    >
      {tier === 'tiny' ? (
        <>
          <div
            className="mt-tile-drag-handle"
            onPointerDown={onGripPointerDown}
            style={{
              height: 8,
              flexShrink: 0,
              background: `linear-gradient(90deg, ${projectColor.from}, ${projectColor.to})`,
              cursor: locked ? 'default' : 'grab',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              touchAction: 'none',
            }}
            title={`${projectName ?? ''} · ${session.name}${locked ? '' : ' — drag to move'}`}
          />
          <div className="mt-tile-tiny-actions mt-auto-hide" style={tinyActionsStyle}>
            <AgentBadge provider={session.agentProvider} size="glyph" />
            <span style={tinyNameStyle} title={session.name}>
              {session.name}
            </span>
            <IconButton size="sm" onClick={handleAiRename} label="Rename with AI" disabled={aiLoading}>
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
          onPointerDown={onGripPointerDown}
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
            cursor: locked ? 'default' : 'grab',
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
          <IconButton size="sm" onClick={handleAiRename} label="Rename with AI" disabled={aiLoading}>
            {aiLoading ? <Spinner size="sm" /> : <Sparkles size={iconSize} />}
          </IconButton>
          <IconButton
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setSelectedProcess(sessionId);
            }}
            label="Open in full pane"
          >
            <Maximize2 size={iconSize} />
          </IconButton>
          <IconButton
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              togglePinSession(sessionId);
            }}
            label="Unpin from Wall"
          >
            <X size={iconSize} />
          </IconButton>
        </header>
      )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <SessionPane sessionId={sessionId} session={session} density={density} />
      </div>

      {!locked && (
        <div
          className="mt-tile-resize"
          onPointerDown={(e) => onResizeStart(sessionId, e)}
          title="Drag to resize"
          aria-hidden="true"
        />
      )}
    </article>
  );
}

export const SessionTile = memo(SessionTileImpl);

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
