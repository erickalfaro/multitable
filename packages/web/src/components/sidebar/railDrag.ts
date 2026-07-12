import React, { useEffect, useRef, useState } from 'react';
import type { RailEntry } from '../../lib/projectNav';
import type { ProjectNavEntry } from '../../lib/types';

// Pointer-drag reorder for the ProjectRail's entry list (projects + dividers).
// Same discipline as the Wall's WallDragContext: transient state lives in refs
// (never the store), listeners attach to window for the drag's duration, a
// sub-threshold press stays a plain click, and Escape aborts.

const DRAG_THRESHOLD = 5; // px before a press becomes a move (vs a click)
const AUTOSCROLL_EDGE = 28; // px from the list's top/bottom that autoscrolls
const AUTOSCROLL_STEP = 6;

interface PressState {
  entryId: string;
  startX: number;
  startY: number;
  moved: boolean;
}

export function useRailReorder({
  containerRef,
  entries,
  disabled = false,
  onCommit,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  entries: RailEntry[];
  disabled?: boolean;
  onCommit: (next: ProjectNavEntry[]) => void;
}): {
  /** Entry currently being dragged (dimmed at its source position). */
  dragEntryId: string | null;
  /** Insertion index the drop line renders before (entries.length = at end). */
  dropIndex: number | null;
  dragging: boolean;
  getEntryProps: (entryId: string) => {
    onPointerDown: (e: React.PointerEvent) => void;
    onClickCapture: (e: React.MouseEvent) => void;
  };
} {
  const [dragEntryId, setDragEntryId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // Live copies so the window handlers (bound once per press) never read
  // stale closures.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const pressRef = useRef<PressState | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  // Set on a drag's pointerup so the click that follows it is swallowed by
  // the wrapper's capture handler instead of selecting the project.
  const suppressClickRef = useRef(false);
  const detachRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      detachRef.current?.();
      document.body.style.cursor = '';
    },
    [],
  );

  const endDrag = (commit: boolean) => {
    const press = pressRef.current;
    const finalDrop = dropIndexRef.current;
    detachRef.current?.();
    detachRef.current = null;
    pressRef.current = null;
    dropIndexRef.current = null;
    setDragEntryId(null);
    setDropIndex(null);
    document.body.style.cursor = '';
    if (!commit || !press?.moved || finalDrop === null) return;
    const current = entriesRef.current;
    const from = current.findIndex((e) => e.id === press.entryId);
    if (from === -1) return;
    let to = finalDrop;
    if (to > from) to -= 1; // removing the source shifts later indices left
    if (to === from) return;
    const next: ProjectNavEntry[] = current.map((e) => ({ kind: e.kind, id: e.id }));
    const [movedEntry] = next.splice(from, 1);
    next.splice(to, 0, movedEntry);
    onCommitRef.current(next);
  };

  const beginPress = (entryId: string, e: React.PointerEvent) => {
    if (disabled || e.button !== 0 || detachRef.current) return;
    suppressClickRef.current = false;
    pressRef.current = { entryId, startX: e.clientX, startY: e.clientY, moved: false };

    const onMove = (ev: PointerEvent) => {
      const press = pressRef.current;
      if (!press) return;
      if (!press.moved) {
        const dist = Math.hypot(ev.clientX - press.startX, ev.clientY - press.startY);
        if (dist < DRAG_THRESHOLD) return;
        press.moved = true;
        setDragEntryId(press.entryId);
        document.body.style.cursor = 'grabbing';
      }
      // Insertion index from row midpoints. Rows are few (≤ dozens), so a
      // full scan per move is cheap and always agrees with the live DOM.
      const container = containerRef.current;
      const rows = container
        ? Array.from(container.querySelectorAll<HTMLElement>('[data-rail-entry]'))
        : [];
      let idx = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        if (ev.clientY < rect.top + rect.height / 2) {
          idx = i;
          break;
        }
      }
      if (dropIndexRef.current !== idx) {
        dropIndexRef.current = idx;
        setDropIndex(idx);
      }
      if (container) {
        const rect = container.getBoundingClientRect();
        if (ev.clientY < rect.top + AUTOSCROLL_EDGE) container.scrollTop -= AUTOSCROLL_STEP;
        else if (ev.clientY > rect.bottom - AUTOSCROLL_EDGE) container.scrollTop += AUTOSCROLL_STEP;
      }
    };
    const onUp = () => {
      if (pressRef.current?.moved) {
        suppressClickRef.current = true;
        // The browser's compatibility click (if any) fires synchronously
        // after pointerup, before this macrotask runs — so this only clears
        // a flag left stale by a drag that ended outside any wrapper, where
        // no click follows and the next real click must not be swallowed.
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      endDrag(true);
    };
    const onCancel = () => endDrag(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') endDrag(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    detachRef.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
    };
  };

  const onClickCapture = (e: React.MouseEvent) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return {
    dragEntryId,
    dropIndex,
    dragging: dragEntryId !== null,
    getEntryProps: (entryId: string) => ({
      onPointerDown: (e: React.PointerEvent) => beginPress(entryId, e),
      onClickCapture,
    }),
  };
}
