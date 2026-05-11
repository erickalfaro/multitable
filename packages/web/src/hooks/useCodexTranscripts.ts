import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { PAST_AGENTS_REFRESH_EVENT } from '../lib/pastAgents';
import type { TranscriptSession, TranscriptGroup } from './useTranscripts';

interface Options {
  cwd?: string;
  enabled?: boolean;
  limit?: number;
}

interface Result {
  loading: boolean;
  error: string | null;
  group: TranscriptGroup | null;
  refetch: () => void;
}

// Mirror of useTranscripts but for ~/.codex/sessions/. The shape lines up so
// AddAgentModal can render both lists through PastAgentsList.
export function useCodexTranscripts(opts: Options = {}): Result {
  const { cwd, enabled = true, limit = 100 } = opts;
  const [sessions, setSessions] = useState<TranscriptSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const fetchSeq = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const seq = ++fetchSeq.current;
    setLoading(true);
    setError(null);
    api.transcripts
      .listCodex({ cwd: cwd || undefined, limit })
      .then((res) => {
        if (seq !== fetchSeq.current) return;
        setSessions(res.sessions);
      })
      .catch((err) => {
        if (seq !== fetchSeq.current) return;
        setError(err?.message || 'Failed to load Codex threads');
      })
      .finally(() => {
        if (seq !== fetchSeq.current) return;
        setLoading(false);
      });
  }, [enabled, cwd, limit, refreshTick]);

  useEffect(() => {
    const handler = () => setRefreshTick((n) => n + 1);
    window.addEventListener(PAST_AGENTS_REFRESH_EVENT, handler);
    return () => window.removeEventListener(PAST_AGENTS_REFRESH_EVENT, handler);
  }, []);

  const group: TranscriptGroup | null = sessions.length
    ? {
        cwd: sessions[0].cwd,
        projectName: sessions[0].projectName,
        totalCount: sessions.length,
        sessions,
      }
    : null;

  return { loading, error, group, refetch: () => setRefreshTick((n) => n + 1) };
}
