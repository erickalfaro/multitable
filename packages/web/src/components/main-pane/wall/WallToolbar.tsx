import { Lock, LockOpen } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { IconButton } from '../../ui';

/**
 * Wall toolbar — floats top-right of the wall scroller. Layout is hand-managed
 * by the user (drag / resize / split), so the only control here is the lock
 * toggle, which freezes all gestures.
 */
export function WallToolbar() {
  const locked = useAppStore((s) => s.wallLayoutLocked);
  const setWallLayoutLocked = useAppStore((s) => s.setWallLayoutLocked);

  return (
    <div
      className="mt-wall-toolbar mt-auto-hide"
      style={{
        position: 'absolute',
        top: 4,
        right: 4,
        zIndex: 30,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <IconButton
        size="sm"
        label={locked ? 'Unlock layout' : 'Lock layout'}
        onClick={() => setWallLayoutLocked(!locked)}
      >
        {locked ? <Lock size={12} /> : <LockOpen size={12} />}
      </IconButton>
    </div>
  );
}
