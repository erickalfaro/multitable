import type { Session } from '../../../lib/types';
import { SessionPane } from './SessionPane';

interface Props {
  sessionId: string;
  session: Session;
}

/**
 * Main-pane session view. Thin wrapper around `SessionPane` — kept as a
 * separate export so callers that haven't been updated to use density-aware
 * SessionPane continue to work, and so MainPane's per-session keying stays
 * stable across the refactor.
 */
export function SessionChat({ sessionId, session }: Props) {
  return <SessionPane sessionId={sessionId} session={session} density="comfortable" />;
}
