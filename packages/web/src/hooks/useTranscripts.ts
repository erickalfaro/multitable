import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../lib/api';
import { PAST_AGENTS_REFRESH_EVENT } from '../lib/pastAgents';

export interface TranscriptSession {
  sessionId: string;
  cwd: string;
  projectName: string;
  gitBranch: string | null;
  firstPrompt: string | null;
  mtime: number;
  pinnedSessionId: string | null;
}

export interface TranscriptProject {
  cwd: string;
  projectName: string;
  sessionCount: number;
}

export interface TranscriptGroup {
  cwd: string;
  projectName: string;
  totalCount: number;
  sessions: TranscriptSession[];
}

export interface TranscriptsData {
  projects: TranscriptProject[];
  sessions: TranscriptSession[];
}

interface UseTranscriptsOptions {
  cwd?: string;
  query?: string;
  limit?: number;
  enabled?: boolean;
  debounceMs?: number;
}

interface UseTranscriptsResult {
  data: TranscriptsData | null;
  loading: boolean;
  error: string | null;
  grouped: TranscriptGroup[];
  debouncedQuery: string;
  loadMoreForCwd: (cwd: string, totalCount: number) => Promise<void>;
  isDeepLoaded: (cwd: string) => boolean;
  refetch: () => void;
}

export function useTranscripts(opts: UseTranscriptsOptions = {}): UseTranscriptsResult {
  const { cwd, query = '', limit = 200, enabled = true, debounceMs = 150 } = opts;

  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [data, setData] = useState<TranscriptsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [groupDeepLoaded, setGroupDeepLoaded] = useState<Set<string>>(new Set());
  const fetchSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), debounceMs);
    return () => clearTimeout(t);
  }, [query, debounceMs]);

  useEffect(() => {
    if (!enabled) return;
    const seq = ++fetchSeq.current;
    setLoading(true);
    setError(null);
    api.transcripts
      .list({ q: debouncedQuery || undefined, cwd: cwd || undefined, limit })
      .then((res) => {
        if (seq !== fetchSeq.current) return;
        setData(res);
      })
      .catch((err) => {
        if (seq !== fetchSeq.current) return;
        setError(err?.message || 'Failed to load past agents');
      })
      .finally(() => {
        if (seq !== fetchSeq.current) return;
        setLoading(false);
      });
  }, [enabled, debouncedQuery, cwd, limit, refreshTick]);

  useEffect(() => {
    const handler = () => setRefreshTick((n) => n + 1);
    window.addEventListener(PAST_AGENTS_REFRESH_EVENT, handler);
    return () => window.removeEventListener(PAST_AGENTS_REFRESH_EVENT, handler);
  }, []);

  const grouped = useMemo<TranscriptGroup[]>(() => {
    if (!data) return [];
    const byCwd = new Map<string, TranscriptSession[]>();
    for (const s of data.sessions) {
      const arr = byCwd.get(s.cwd) || [];
      arr.push(s);
      byCwd.set(s.cwd, arr);
    }
    const ordered: TranscriptGroup[] = [];
    for (const p of data.projects) {
      const arr = byCwd.get(p.cwd);
      if (arr && arr.length > 0) {
        ordered.push({ cwd: p.cwd, projectName: p.projectName, totalCount: p.sessionCount, sessions: arr });
        byCwd.delete(p.cwd);
      }
    }
    for (const [c, arr] of byCwd) {
      ordered.push({ cwd: c, projectName: arr[0].projectName, totalCount: arr.length, sessions: arr });
    }
    return ordered;
  }, [data]);

  const loadMoreForCwd = async (groupCwd: string, totalCount: number) => {
    const haveCount = (data?.sessions ?? []).filter((s) => s.cwd === groupCwd).length;
    if (haveCount >= totalCount || groupDeepLoaded.has(groupCwd)) return;
    try {
      const res = await api.transcripts.list({ cwd: groupCwd, limit: 1000 });
      setData((prev) => {
        if (!prev) return res;
        const seen = new Map(prev.sessions.map((s) => [s.sessionId, s]));
        for (const s of res.sessions) seen.set(s.sessionId, s);
        return {
          projects: prev.projects,
          sessions: Array.from(seen.values()).sort((a, b) => b.mtime - a.mtime),
        };
      });
      setGroupDeepLoaded((prev) => new Set(prev).add(groupCwd));
    } catch {
      toast.error('Failed to load more agents');
    }
  };

  const isDeepLoaded = (groupCwd: string) => groupDeepLoaded.has(groupCwd);

  const refetch = () => setRefreshTick((n) => n + 1);

  return { data, loading, error, grouped, debouncedQuery, loadMoreForCwd, isDeepLoaded, refetch };
}
