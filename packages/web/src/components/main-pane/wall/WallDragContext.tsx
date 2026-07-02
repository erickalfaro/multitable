import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useAppStore } from '../../../stores/appStore';
import { getProjectColor } from '../../../lib/projectColor';
import { BUILTIN_THEMES } from '../../../lib/themes';
import { AgentBadge } from '../../ui';
import { MIN_H, MIN_W, ROW_PX, WALL_COLS, pointToCell } from './grid';

// Ephemeral drag/resize state lives here in React (NOT the store) — it's
// transient UI, and keeping it out of Zustand avoids persisting it and avoids
// cross-tab churn. The store is only touched on a committed drop / resize.

const DRAG_THRESHOLD = 5; // px before a header press becomes a move (vs a click)

export type DropTarget =
  | { kind: 'region'; regionId: string; x: number; y: number }
  | { kind: 'divider'; boundaryIndex: number };

interface DragInfo {
  sessionId: string;
  w: number; // dragged tile width in cells (for the placeholder)
  h: number; // dragged tile height in cells
}
interface ResizeInfo {
  sessionId: string;
  w: number;
  h: number;
}

interface WallCtxValue {
  locked: boolean;
  drag: DragInfo | null;
  drop: DropTarget | null;
  resize: ResizeInfo | null;
  beginDrag: (sessionId: string, e: ReactPointerEvent) => void;
  beginResize: (sessionId: string, e: ReactPointerEvent) => void;
}

const WallDragContext = createContext<WallCtxValue | null>(null);

export function useWallDrag(): WallCtxValue {
  const ctx = useContext(WallDragContext);
  if (!ctx) throw new Error('useWallDrag must be used within WallDragProvider');
  return ctx;
}

interface DragSession {
  sessionId: string;
  startX: number;
  startY: number;
  grabX: number;
  grabY: number;
  wCells: number;
  hCells: number;
  wPx: number;
  hPx: number;
  moved: boolean;
}
interface ResizeSession {
  sessionId: string;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  x: number;
  pitch: number;
  cols: number;
  w: number;
  h: number;
}

function dropsEqual(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'divider' && b.kind === 'divider') return a.boundaryIndex === b.boundaryIndex;
  if (a.kind === 'region' && b.kind === 'region')
    return a.regionId === b.regionId && a.x === b.x && a.y === b.y;
  return false;
}

function num(el: Element | null, attr: string, fallback: number): number {
  const v = el?.getAttribute(attr);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function WallDragProvider({
  locked,
  children,
}: {
  locked: boolean;
  children: ReactNode;
}) {
  const moveTileTo = useAppStore((s) => s.moveTileTo);
  const resizeWallTile = useAppStore((s) => s.resizeWallTile);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);

  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [resize, setResize] = useState<ResizeInfo | null>(null);

  const dragRef = useRef<DragSession | null>(null);
  const dropRef = useRef<DropTarget | null>(null);
  const resizeRef = useRef<ResizeSession | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  // ── Move (drag) ────────────────────────────────────────────────────────────
  const resolveDrop = useCallback(
    (clientX: number, clientY: number, d: DragSession): DropTarget | null => {
      const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      if (!el) return null;
      const dividerEl = el.closest('[data-wall-divider]');
      if (dividerEl) {
        return { kind: 'divider', boundaryIndex: num(dividerEl, 'data-wall-divider', 0) };
      }
      const regionEl = el.closest('[data-wall-region]') as HTMLElement | null;
      if (regionEl) {
        const regionId = regionEl.getAttribute('data-wall-region')!;
        const cols = num(regionEl, 'data-cols', WALL_COLS);
        const pitch = num(regionEl, 'data-col-pitch', regionEl.clientWidth / cols);
        const rect = regionEl.getBoundingClientRect();
        const localX = clientX - d.grabX - rect.left;
        const localY = clientY - d.grabY - rect.top;
        const { x, y } = pointToCell(localX, localY, pitch, cols, d.wCells);
        return { kind: 'region', regionId, x, y };
      }
      return null;
    },
    [],
  );

  const endDrag = useCallback(
    (commit: boolean) => {
      const d = dragRef.current;
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragUp);
      window.removeEventListener('pointercancel', onDragCancel);
      window.removeEventListener('keydown', onDragKey);
      dragRef.current = null;
      const target = dropRef.current;
      dropRef.current = null;
      setDrag(null);
      setDrop(null);
      if (!d) return;
      if (!d.moved) {
        // Sub-threshold press = a click → focus the tile (composer expands).
        if (!lockedRef.current) setFocusedPane(d.sessionId);
        return;
      }
      if (commit && target) {
        if (target.kind === 'divider') {
          moveTileTo(d.sessionId, { kind: 'divider', boundaryIndex: target.boundaryIndex });
        } else {
          moveTileTo(d.sessionId, {
            kind: 'region',
            regionId: target.regionId,
            x: target.x,
            y: target.y,
          });
        }
      }
    },
    // onDrag* are stable refs created below; deps intentionally minimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [moveTileTo, setFocusedPane],
  );

  const onDragMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved) {
        const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
        if (dist < DRAG_THRESHOLD) return;
        if (lockedRef.current) return; // locked: never enter move mode
        d.moved = true;
        setDrag({ sessionId: d.sessionId, w: d.wCells, h: d.hCells });
        if (ghostRef.current) {
          ghostRef.current.style.width = `${d.wPx}px`;
          ghostRef.current.style.height = `${d.hPx}px`;
        }
      }
      if (ghostRef.current) {
        ghostRef.current.style.transform = `translate(${e.clientX - d.grabX}px, ${e.clientY - d.grabY}px)`;
      }
      const next = resolveDrop(e.clientX, e.clientY, d);
      dropRef.current = next;
      setDrop((prev) => (dropsEqual(prev, next) ? prev : next));
    },
    [resolveDrop],
  );
  const onDragUp = useCallback(() => endDrag(true), [endDrag]);
  const onDragCancel = useCallback(() => endDrag(false), [endDrag]);
  const onDragKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') endDrag(false);
    },
    [endDrag],
  );

  const beginDrag = useCallback(
    (sessionId: string, e: ReactPointerEvent) => {
      // Left button only; ignore if already dragging/resizing.
      if (e.button !== 0 || dragRef.current || resizeRef.current) return;
      const wrap = (e.currentTarget as HTMLElement).closest('[data-tile-id]') as HTMLElement | null;
      const rect = wrap?.getBoundingClientRect();
      dragRef.current = {
        sessionId,
        startX: e.clientX,
        startY: e.clientY,
        grabX: e.clientX - (rect?.left ?? e.clientX),
        grabY: e.clientY - (rect?.top ?? e.clientY),
        wCells: num(wrap, 'data-w', 4),
        hCells: num(wrap, 'data-h', 6),
        wPx: rect?.width ?? 240,
        hPx: rect?.height ?? 160,
        moved: false,
      };
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragUp);
      window.addEventListener('pointercancel', onDragCancel);
      window.addEventListener('keydown', onDragKey);
    },
    [onDragMove, onDragUp, onDragCancel, onDragKey],
  );

  // ── Resize ──────────────────────────────────────────────────────────────────
  const endResize = useCallback(
    (commit: boolean) => {
      const r = resizeRef.current;
      window.removeEventListener('pointermove', onResizeMove);
      window.removeEventListener('pointerup', onResizeUp);
      window.removeEventListener('pointercancel', onResizeCancel);
      window.removeEventListener('keydown', onResizeKey);
      resizeRef.current = null;
      setResize(null);
      if (r && commit) resizeWallTile(r.sessionId, r.w, r.h);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resizeWallTile],
  );
  const onResizeMove = useCallback((e: PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    const dw = Math.round((e.clientX - r.startX) / r.pitch);
    const dh = Math.round((e.clientY - r.startY) / ROW_PX);
    const w = Math.max(MIN_W, Math.min(r.startW + dw, r.cols - r.x));
    const h = Math.max(MIN_H, r.startH + dh);
    r.w = w;
    r.h = h;
    setResize((prev) =>
      prev && prev.sessionId === r.sessionId && prev.w === w && prev.h === h
        ? prev
        : { sessionId: r.sessionId, w, h },
    );
  }, []);
  const onResizeUp = useCallback(() => endResize(true), [endResize]);
  const onResizeCancel = useCallback(() => endResize(false), [endResize]);
  const onResizeKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') endResize(false);
    },
    [endResize],
  );

  const beginResize = useCallback(
    (sessionId: string, e: ReactPointerEvent) => {
      if (e.button !== 0 || lockedRef.current || dragRef.current || resizeRef.current) return;
      e.stopPropagation();
      e.preventDefault();
      const wrap = (e.currentTarget as HTMLElement).closest('[data-tile-id]') as HTMLElement | null;
      const regionEl = wrap?.closest('[data-wall-region]') as HTMLElement | null;
      if (!wrap || !regionEl) return;
      const cols = num(regionEl, 'data-cols', WALL_COLS);
      resizeRef.current = {
        sessionId,
        startX: e.clientX,
        startY: e.clientY,
        startW: num(wrap, 'data-w', 4),
        startH: num(wrap, 'data-h', 6),
        x: num(wrap, 'data-x', 0),
        pitch: num(regionEl, 'data-col-pitch', regionEl.clientWidth / cols),
        cols,
        w: num(wrap, 'data-w', 4),
        h: num(wrap, 'data-h', 6),
      };
      window.addEventListener('pointermove', onResizeMove);
      window.addEventListener('pointerup', onResizeUp);
      window.addEventListener('pointercancel', onResizeCancel);
      window.addEventListener('keydown', onResizeKey);
    },
    [onResizeMove, onResizeUp, onResizeCancel, onResizeKey],
  );

  const ctx = useMemo<WallCtxValue>(
    () => ({ locked, drag, drop, resize, beginDrag, beginResize }),
    [locked, drag, drop, resize, beginDrag, beginResize],
  );

  return (
    <WallDragContext.Provider value={ctx}>
      {children}
      <div ref={ghostRef} className="mt-wall-ghost" aria-hidden="true">
        {drag && <GhostBody sessionId={drag.sessionId} />}
      </div>
    </WallDragContext.Provider>
  );
}

function GhostBody({ sessionId }: { sessionId: string }) {
  const session = useAppStore((s) => s.sessions[sessionId]);
  const projectName = useAppStore(
    (s) => s.projects.find((p) => p.id === session?.projectId)?.name,
  );
  const activeThemeId = useAppStore((s) => s.activeThemeId);
  const customThemes = useAppStore((s) => s.customThemes);
  if (!session) return null;
  const isDark = [...BUILTIN_THEMES, ...customThemes].find((t) => t.id === activeThemeId)?.isDark ?? true;
  const color = getProjectColor(session.projectId, isDark);
  return (
    <div
      className="mt-wall-ghost-body"
      style={{
        ['--workspace-from' as string]: color.from,
        ['--workspace-to' as string]: color.to,
      }}
    >
      <AgentBadge provider={session.agentProvider} size="glyph" />
      <span className="mt-wall-ghost-name">{session.name}</span>
      {projectName && <span className="mt-wall-ghost-project">{projectName}</span>}
    </div>
  );
}
