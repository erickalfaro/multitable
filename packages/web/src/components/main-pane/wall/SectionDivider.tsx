import { Plus, Trash2 } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { useWallDrag } from './WallDragContext';

interface Props {
  /** Insert position for split/drop (0 = above first region, N = below last). */
  boundaryIndex: number;
  variant: 'top' | 'between' | 'bottom';
  /** For 'between' dividers: the region index to roll UP into the one above. */
  deleteBelowIndex?: number;
}

/**
 * The section divider — a friendly horizontal band between regions. Idle: a
 * hairline with hover affordances (+ Split, and Delete on internal dividers).
 * During a drag: a prominent drop zone that spins off a new region at this
 * boundary. Deleting an internal divider rolls the region below it UP into the
 * region above (no chat lost).
 */
export function SectionDivider({ boundaryIndex, variant, deleteBelowIndex }: Props) {
  const { drag, drop, locked } = useWallDrag();
  const addWallRegion = useAppStore((s) => s.addWallRegion);
  const deleteWallRegion = useAppStore((s) => s.deleteWallRegion);

  const dragging = !!drag;
  const isDropTarget = dragging && drop?.kind === 'divider' && drop.boundaryIndex === boundaryIndex;

  return (
    <div
      className="mt-wall-divider"
      data-wall-divider={boundaryIndex}
      data-variant={variant}
      data-dragging={dragging ? 'true' : undefined}
      data-drop={isDropTarget ? 'true' : undefined}
    >
      <div className="mt-wall-divider-line" />
      {dragging ? (
        <span className="mt-wall-divider-hint">Drop here to create a section</span>
      ) : (
        !locked && (
          <div className="mt-wall-divider-actions mt-auto-hide">
            <button
              type="button"
              className="mt-wall-divider-btn"
              onClick={() => addWallRegion(boundaryIndex)}
              title="Split into a new section here"
            >
              <Plus size={12} />
              Split
            </button>
            {variant === 'between' && deleteBelowIndex != null && (
              <button
                type="button"
                className="mt-wall-divider-btn mt-wall-divider-del"
                onClick={() => deleteWallRegion(deleteBelowIndex)}
                title="Delete this section — its chats roll up into the section above"
                aria-label="Delete section"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}
