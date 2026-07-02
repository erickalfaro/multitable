import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { api } from '../../../lib/api';
import { parseDiff } from './parseDiff';
import { GitDiffHunks } from './GitDiffHunks';
import { GitDiffHeader } from './GitDiffHeader';

interface Props {
  projectId: string;
  filePath: string | null;
  staged: boolean;
  /** Bumped by the parent when the watcher reports new status; triggers a refetch. */
  refreshKey: number;
  /** Called when the underlying fetch fails so the parent can surface it. */
  onError?: (message: string) => void;
  /** Mobile single-column mode: renders a back arrow that returns to the change list. */
  onBack?: () => void;
}

export function GitDiffEditor({ projectId, filePath, staged, refreshKey, onError, onBack }: Props) {
  const [raw, setRaw] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [currentHunk, setCurrentHunk] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filePath) {
      setRaw('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.git
      .fileDiff(projectId, filePath, { staged })
      .then((res) => {
        if (!cancelled) {
          setRaw(res.diff);
          setCurrentHunk(0);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRaw('');
          onError?.(err instanceof Error ? err.message : 'Failed to load diff');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, filePath, staged, refreshKey, onError]);

  const parsed = useMemo(() => parseDiff(raw), [raw]);
  const file = parsed.files[0] ?? null;
  const hunkCount = file?.hunks.length ?? 0;

  const scrollToHunk = (idx: number) => {
    if (!scrollRef.current) return;
    const target = scrollRef.current.querySelector<HTMLElement>(
      `[data-hunk-anchor="f0-h${idx}"]`,
    );
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const onPrev = () => {
    const next = Math.max(0, currentHunk - 1);
    setCurrentHunk(next);
    scrollToHunk(next);
  };

  const onNext = () => {
    const next = Math.min(hunkCount - 1, currentHunk + 1);
    setCurrentHunk(next);
    scrollToHunk(next);
  };

  if (!filePath) {
    return (
      <Empty>
        <FileText size={28} style={{ opacity: 0.4, marginBottom: 8 }} />
        <span>Select a file to view its diff.</span>
      </Empty>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
      <GitDiffHeader
        filePath={filePath}
        hunkCount={hunkCount}
        currentHunk={currentHunk}
        onPrev={onPrev}
        onNext={onNext}
        onBack={onBack}
      />
      <div ref={scrollRef} className="mt-scroll" style={{ flex: 1, overflow: 'auto' }}>
        {loading && !file && <Empty>Loading diff…</Empty>}
        {!loading && !file && <Empty>No changes for this file.</Empty>}
        {file && <GitDiffHunks file={file} defaultExpanded fileIndex={0} />}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        gap: 6,
        color: 'var(--text-muted)',
        fontSize: 13,
        padding: 24,
        textAlign: 'center',
        height: '100%',
      }}
    >
      {children}
    </div>
  );
}
