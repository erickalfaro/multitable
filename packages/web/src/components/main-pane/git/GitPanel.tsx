import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { GitCommit, RefreshCw } from 'lucide-react';
import { api } from '../../../lib/api';
import { useAppStore } from '../../../stores/appStore';
import type { GitFileEntry, GitStatusSummary } from '../../../lib/types';
import { GitFileList } from './GitFileList';
import { GitDiffPane } from './GitDiffPane';
import { GitBranchPicker } from './GitBranchPicker';
import { GitCommitComposer } from './GitCommitComposer';
import { DiffFileSection, parseDiff } from './DiffFileSection';

interface Props {
  projectId: string;
  sessionId: string | null;
}

type Scope = 'agent' | 'project';

// Single panel surface used by both project- and per-agent diff scopes. The
// daemon's GitWatcher pushes status over WS, so this component never polls;
// it just reads `gitByProject[projectId]` from the store and re-renders. On
// first mount we kick a REST fetch so the slice is populated even before the
// next watcher tick.
export function GitPanel({ projectId, sessionId }: Props) {
  const status = useAppStore((s) => s.gitByProject[projectId]);
  const setGitStatus = useAppStore((s) => s.setGitStatus);
  const session = useAppStore((s) => (sessionId ? s.sessions[sessionId] : null));

  const [scope, setScope] = useState<Scope>(sessionId ? 'agent' : 'project');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedBucket, setSelectedBucket] = useState<'staged' | 'unstaged' | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [agentDiff, setAgentDiff] = useState<string>('');
  const [agentDiffLoading, setAgentDiffLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Initial REST fetch — covers the first paint before any GitWatcher tick.
  useEffect(() => {
    let cancelled = false;
    api.git
      .status(projectId)
      .then((s) => {
        if (!cancelled) setGitStatus(projectId, s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, setGitStatus]);

  // Bump refreshKey whenever status changes so child diff pane refetches.
  useEffect(() => {
    if (status) setRefreshKey((k) => k + 1);
  }, [status]);

  // Per-agent scope: fetch the baseline-relative diff lazily.
  useEffect(() => {
    if (scope !== 'agent' || !sessionId) {
      setAgentDiff('');
      return;
    }
    let cancelled = false;
    setAgentDiffLoading(true);
    api.sessions
      .diff(sessionId)
      .then((res) => {
        if (!cancelled) setAgentDiff(res.diff);
      })
      .catch(() => {
        if (!cancelled) setAgentDiff('');
      })
      .finally(() => {
        if (!cancelled) setAgentDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, sessionId, refreshKey]);

  if (!status) {
    return <Empty>Loading git status…</Empty>;
  }

  if (!status.isRepo) {
    return (
      <Empty>
        <GitCommit size={28} style={{ opacity: 0.4, marginBottom: 8 }} />
        <span>Not a git repository.</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Run <code>git init</code> in this project to enable source control.
        </span>
      </Empty>
    );
  }

  const stagedCount = status.staged.length;
  const hasUnstaged = status.unstaged.length > 0 || status.untracked.length > 0;
  const hasAnyChanges = stagedCount > 0 || hasUnstaged;

  const refresh = async () => {
    try {
      const fresh = await api.git.status(projectId);
      setGitStatus(projectId, fresh);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to refresh');
    }
  };

  const toggleSelect = (file: GitFileEntry, bucket: 'staged' | 'unstaged' | 'untracked') => {
    const key = `${bucket}:${file.path}`;
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSelect = (file: GitFileEntry, bucket: 'staged' | 'unstaged') => {
    setSelectedPath(file.path);
    setSelectedBucket(bucket);
  };

  const handleStage = async (files: string[]) => {
    if (files.length === 0) return;
    try {
      await api.git.stage(projectId, files);
      // Watcher will broadcast new status; meanwhile clear selection.
      setSelectedPaths(new Set());
    } catch (err: any) {
      toast.error(err?.message || 'Failed to stage');
    }
  };

  const handleUnstage = async (files: string[]) => {
    if (files.length === 0) return;
    try {
      await api.git.unstage(projectId, files);
      setSelectedPaths(new Set());
    } catch (err: any) {
      toast.error(err?.message || 'Failed to unstage');
    }
  };

  const handleDiscard = async (files: string[]) => {
    if (files.length === 0) return;
    const noun = files.length === 1 ? files[0] : `${files.length} files`;
    if (!confirm(`Discard changes to ${noun}? This cannot be undone.`)) return;
    try {
      await api.git.discard(projectId, files);
      setSelectedPaths(new Set());
      if (files.includes(selectedPath ?? '')) {
        setSelectedPath(null);
        setSelectedBucket(null);
      }
    } catch (err: any) {
      toast.error(err?.message || 'Failed to discard');
    }
  };

  const handleCommit = async (message: string) => {
    try {
      const result = await api.git.commit(projectId, message);
      toast.success(`Committed ${result.sha.slice(0, 7)}`);
    } catch (err: any) {
      toast.error(err?.message || 'Commit failed');
    }
  };

  const handleStash = async () => {
    try {
      await api.git.stash(projectId);
      toast.success('Changes stashed');
    } catch (err: any) {
      toast.error(err?.message || 'Stash failed');
    }
  };

  const handleStashPop = async () => {
    try {
      await api.git.stashPop(projectId);
      toast.success('Stash applied');
    } catch (err: any) {
      toast.error(err?.message || 'Stash pop failed');
    }
  };

  const handleSwitchBranch = async (branch: string) => {
    try {
      await api.git.checkout(projectId, branch);
      toast.success(`Switched to ${branch}`);
    } catch (err: any) {
      toast.error(err?.message || 'Checkout failed');
    }
  };

  const handleCreateBranch = async (name: string) => {
    try {
      await api.git.createBranch(projectId, name, true);
      toast.success(`Created and checked out ${name}`);
    } catch (err: any) {
      toast.error(err?.message || 'Branch creation failed');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          fontSize: 12,
          color: 'var(--text-secondary)',
          borderBottom: '1px solid var(--border)',
          backgroundColor: 'var(--bg-primary)',
          flexShrink: 0,
        }}
      >
        <GitBranchPicker
          projectId={projectId}
          current={status.branch}
          hasUnstagedChanges={hasUnstaged}
          onSwitch={handleSwitchBranch}
          onCreate={handleCreateBranch}
          refreshKey={refreshKey}
        />
        {(status.ahead > 0 || status.behind > 0) && (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            {status.ahead > 0 && <span>↑{status.ahead}</span>}
            {status.behind > 0 && <span>↓{status.behind}</span>}
          </span>
        )}
        {sessionId && session && (
          <div
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-snug)',
              overflow: 'hidden',
            }}
          >
            <ScopeButton active={scope === 'agent'} onClick={() => setScope('agent')}>
              Agent
            </ScopeButton>
            <ScopeButton active={scope === 'project'} onClick={() => setScope('project')}>
              Project
            </ScopeButton>
          </div>
        )}
        <button
          type="button"
          onClick={() => void refresh()}
          title="Refresh"
          style={{
            ...iconBtn,
            marginLeft: sessionId ? 0 : 'auto',
          }}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* Body */}
      {scope === 'agent' && sessionId ? (
        <AgentScopeBody loading={agentDiffLoading} raw={agentDiff} />
      ) : (
        <ProjectScopeBody
          projectId={projectId}
          status={status}
          stagedCount={stagedCount}
          hasAnyChanges={hasAnyChanges}
          selectedPath={selectedPath}
          selectedBucket={selectedBucket}
          selectedPaths={selectedPaths}
          refreshKey={refreshKey}
          onSelect={handleSelect}
          onToggleSelect={toggleSelect}
          onStage={handleStage}
          onUnstage={handleUnstage}
          onDiscard={handleDiscard}
          onCommit={handleCommit}
          onStash={handleStash}
          onStashPop={handleStashPop}
        />
      )}
    </div>
  );
}

function ProjectScopeBody({
  status,
  stagedCount,
  hasAnyChanges,
  selectedPath,
  selectedBucket,
  selectedPaths,
  refreshKey,
  projectId,
  onSelect,
  onToggleSelect,
  onStage,
  onUnstage,
  onDiscard,
  onCommit,
  onStash,
  onStashPop,
}: {
  status: GitStatusSummary;
  stagedCount: number;
  hasAnyChanges: boolean;
  selectedPath: string | null;
  selectedBucket: 'staged' | 'unstaged' | null;
  selectedPaths: Set<string>;
  refreshKey: number;
  projectId: string;
  onSelect: (file: GitFileEntry, bucket: 'staged' | 'unstaged') => void;
  onToggleSelect: (file: GitFileEntry, bucket: 'staged' | 'unstaged' | 'untracked') => void;
  onStage: (files: string[]) => void;
  onUnstage: (files: string[]) => void;
  onDiscard: (files: string[]) => void;
  onCommit: (message: string) => void | Promise<void>;
  onStash: () => void | Promise<void>;
  onStashPop: () => void | Promise<void>;
}) {
  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
      {/* Left rail: file list + commit composer pinned to bottom */}
      <div
        style={{
          width: 320,
          minWidth: 240,
          maxWidth: '40%',
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--border)',
          overflow: 'hidden',
        }}
      >
        <div style={{ flex: 1, overflow: 'auto' }}>
          <GitFileList
            staged={status.staged}
            unstaged={status.unstaged}
            untracked={status.untracked}
            conflicted={status.conflicted}
            selectedPath={selectedPath}
            selectedBucket={selectedBucket}
            selectedPaths={selectedPaths}
            onSelect={onSelect}
            onToggleSelect={onToggleSelect}
            onStage={onStage}
            onUnstage={onUnstage}
            onDiscard={onDiscard}
          />
        </div>
        <GitCommitComposer
          stagedCount={stagedCount}
          hasAnyChanges={hasAnyChanges}
          onCommit={onCommit}
          onStash={onStash}
          onStashPop={onStashPop}
        />
      </div>
      {/* Right pane: selected file diff */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <GitDiffPane
          projectId={projectId}
          filePath={selectedPath}
          staged={selectedBucket === 'staged'}
          refreshKey={refreshKey}
        />
      </div>
    </div>
  );
}

function AgentScopeBody({ loading, raw }: { loading: boolean; raw: string }) {
  const parsed = useMemo(() => parseDiff(raw), [raw]);
  if (loading) {
    return (
      <Empty>
        <span>Loading diff…</span>
      </Empty>
    );
  }
  if (parsed.files.length === 0) {
    return (
      <Empty>
        <span>This agent hasn't changed any files yet.</span>
      </Empty>
    );
  }
  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 12px',
          fontSize: 12,
          color: 'var(--text-secondary)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <span>
          <strong style={{ color: 'var(--text-primary)' }}>{parsed.stats.filesChanged}</strong>{' '}
          file{parsed.stats.filesChanged !== 1 ? 's' : ''} changed
        </span>
        <span style={{ color: 'var(--status-running)' }}>
          +{parsed.stats.totalAdditions}
        </span>
        <span style={{ color: 'var(--status-error)' }}>
          -{parsed.stats.totalDeletions}
        </span>
      </div>
      {parsed.files.map((file, idx) => (
        <DiffFileSection
          key={`${file.newPath}-${idx}`}
          file={file}
          defaultExpanded={parsed.files.length <= 10}
        />
      ))}
    </div>
  );
}

function ScopeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '3px 10px',
        fontSize: 11,
        fontWeight: active ? 600 : 400,
        backgroundColor: active ? 'var(--accent-blue)' : 'transparent',
        color: active ? 'white' : 'var(--text-primary)',
        border: 'none',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
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
      }}
    >
      {children}
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 4,
  border: '1px solid var(--border)',
  background: 'var(--bg-hover)',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  borderRadius: 'var(--radius-snug)',
};
