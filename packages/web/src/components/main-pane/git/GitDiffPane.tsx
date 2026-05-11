import { useEffect, useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { api } from '../../../lib/api';
import { DiffFileSection, parseDiff } from './DiffFileSection';

interface Props {
  projectId: string;
  filePath: string | null;
  staged: boolean;
  // Bumped by the parent on git:status-changed so the open file's diff
  // refreshes when the agent or the user makes another edit.
  refreshKey: number;
}

export function GitDiffPane({ projectId, filePath, staged, refreshKey }: Props) {
  const [raw, setRaw] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!filePath) {
      setRaw('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.git
      .fileDiff(projectId, filePath, { staged })
      .then((res) => {
        if (cancelled) return;
        setRaw(res.diff);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load diff');
        setRaw('');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, filePath, staged, refreshKey]);

  const parsed = useMemo(() => parseDiff(raw), [raw]);

  if (!filePath) {
    return (
      <Centered>
        <FileText size={28} style={{ opacity: 0.4, marginBottom: 8 }} />
        <span>Select a file to view its diff.</span>
      </Centered>
    );
  }

  if (loading) return <Centered>Loading diff…</Centered>;
  if (error) return <Centered tone="error">{error}</Centered>;
  if (parsed.files.length === 0) {
    return <Centered>No changes for this file.</Centered>;
  }

  return (
    <div style={{ overflow: 'auto', flex: 1 }}>
      {parsed.files.map((file, idx) => (
        <DiffFileSection
          key={`${file.newPath}-${idx}`}
          file={file}
          defaultExpanded={true}
        />
      ))}
    </div>
  );
}

function Centered({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: 'error';
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        gap: 6,
        color: tone === 'error' ? 'var(--status-error)' : 'var(--text-muted)',
        fontSize: 13,
        padding: 24,
        textAlign: 'center',
      }}
    >
      {children}
    </div>
  );
}
