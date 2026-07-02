import { Pin, PinOff } from 'lucide-react';
import { IconButton } from '../ui';
import { useAppStore } from '../../stores/appStore';

interface Props {
  sessionId: string;
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Toggle a session's membership in the Pinned Session Wall (plan §5.1).
 * Pinned state lives in the store + localStorage + GlobalConfig — see
 * stores/appStore.ts `togglePinSession` for the persistence flow.
 */
export function PinToggle({ sessionId, size = 'md' }: Props) {
  const pinned = useAppStore((s) => s.pinnedSessionIds.includes(sessionId));
  const togglePinSession = useAppStore((s) => s.togglePinSession);
  return (
    <IconButton
      size={size}
      onClick={() => togglePinSession(sessionId)}
      label={pinned ? 'Unpin from Wall' : 'Pin to Wall'}
      className={pinned ? 'is-active' : undefined}
    >
      {pinned ? <PinOff size={14} /> : <Pin size={14} />}
    </IconButton>
  );
}
