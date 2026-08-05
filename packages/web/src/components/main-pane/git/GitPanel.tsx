import { useEffect, useRef, useState } from 'react';
import { GitCommit } from 'lucide-react';
import { api } from '../../../lib/api';
import { useAppStore } from '../../../stores/appStore';
import { useIsMobile } from '../../../lib/useIsMobile';
import type { GitFileEntry, GitStatusSummary } from '../../../lib/types';
import { GitPanelHeader } from './GitPanelHeader';
import { GitCommitBox } from './GitCommitBox';
import { GitChangeList } from './GitChangeList';
import { GitDiffEditor } from './GitDiffEditor';
import { GitBranchQuickPick } from './GitBranchQuickPick';
import { GitConfirmDialog } from './GitConfirmDialog';
import { GitWorktreeList } from './GitWorktreeList';
import type { GitMenuItem } from './GitActionMenu';

interface Props {
  projectId: string;
}

type ConfirmState =
  | { kind: 'discard'; files: string[] }
  | { kind: 'discardAll'; files: string[] }
  | { kind: 'switchBranch'; branch: string }
  | null;

// Source-control surface for a project. The daemon's GitWatcher pushes status
// over WS, so this component never polls; it just reads
// `gitByProject[projectId]` from the store and re-renders. On first mount we
// kick a REST fetch so the slice is populated even before the next watcher
// tick.
export function GitPanel({ projectId }: Props) {
  const status = useAppStore((s) => s.gitByProject[projectId]);
  const setGitStatus = useAppStore((s) => s.setGitStatus);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedBucket, setSelectedBucket] = useState<'staged' | 'unstaged' | null>(null);
  // On phones the two-pane split leaves neither pane usable, so the body
  // becomes a single column: change list, tap a file → full-width diff with a
  // back arrow. Deriving the diff view from `selectedPath` too means discard
  // (which nulls the selection) automatically pops back to the list.
  const isMobile = useIsMobile();
  const [mobileDiffOpen, setMobileDiffOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  // Also clear any stale error on the next successful status change.
  useEffect(() => {
    if (status) {
      setRefreshKey((k) => k + 1);
      setError(null);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    }
  }, [status]);

  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  const surfaceError = (message: string) => {
    setError(message);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(null), 6000);
  };

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
  const hasUpstream = status.ahead > 0 || status.behind > 0 || !!status.branch;

  const refresh = async () => {
    try {
      const fresh = await api.git.status(projectId);
      setGitStatus(projectId, fresh);
    } catch (err) {
      surfaceError(toMessage(err, 'Failed to refresh'));
    }
  };

  const handleSelect = (file: GitFileEntry, bucket: 'staged' | 'unstaged') => {
    setSelectedPath(file.path);
    setSelectedBucket(bucket);
    setMobileDiffOpen(true);
  };

  const showMobileDiff = isMobile && mobileDiffOpen && selectedPath !== null;

  const handleStage = async (files: string[]) => {
    if (files.length === 0) return;
    try {
      await api.git.stage(projectId, files);
    } catch (err) {
      surfaceError(toMessage(err, 'Failed to stage'));
    }
  };

  const handleUnstage = async (files: string[]) => {
    if (files.length === 0) return;
    try {
      await api.git.unstage(projectId, files);
    } catch (err) {
      surfaceError(toMessage(err, 'Failed to unstage'));
    }
  };

  const runDiscard = async (files: string[]) => {
    try {
      await api.git.discard(projectId, files);
      if (files.includes(selectedPath ?? '')) {
        setSelectedPath(null);
        setSelectedBucket(null);
      }
    } catch (err) {
      surfaceError(toMessage(err, 'Failed to discard'));
    }
  };

  const handleCommit = async (message: string) => {
    try {
      await api.git.commit(projectId, message);
    } catch (err) {
      surfaceError(toMessage(err, 'Commit failed'));
      throw err;
    }
  };

  const generateMessage = async (): Promise<string | null> => {
    try {
      const r = await api.git.aiCommitMessage(projectId);
      return r.message;
    } catch (err) {
      surfaceError(toMessage(err, 'Could not generate commit message'));
      return null;
    }
  };

  const handleStash = async () => {
    try {
      await api.git.stash(projectId);
    } catch (err) {
      surfaceError(toMessage(err, 'Stash failed'));
    }
  };

  const handleStashPop = async () => {
    try {
      await api.git.stashPop(projectId);
    } catch (err) {
      surfaceError(toMessage(err, 'Stash pop failed'));
    }
  };

  const handleFetch = async () => {
    try {
      await api.git.fetch(projectId);
    } catch (err) {
      surfaceError(toMessage(err, 'Fetch failed'));
    }
  };

  const handlePull = async (rebase = false) => {
    void rebase; // placeholder — simple-git pull doesn't expose a rebase flag in this helper
    try {
      await api.git.pull(projectId);
    } catch (err) {
      surfaceError(toMessage(err, 'Pull failed'));
    }
  };

  const handlePush = async () => {
    try {
      await api.git.push(projectId);
    } catch (err) {
      const msg = toMessage(err, '');
      // First push of a new branch: simple-git surfaces a "no upstream" error.
      // Retry once with --set-upstream origin <current branch>. Silent on success.
      if (status.branch && /no upstream|set-upstream/i.test(msg)) {
        try {
          await api.git.push(projectId, {
            setUpstream: true,
            remote: 'origin',
            branch: status.branch,
          });
          return;
        } catch (err2) {
          surfaceError(toMessage(err2, 'Push failed'));
          return;
        }
      }
      surfaceError(msg || 'Push failed');
    }
  };

  const handleSync = async () => {
    try {
      await api.git.pull(projectId);
      await api.git.push(projectId);
    } catch (err) {
      surfaceError(toMessage(err, 'Sync failed'));
    }
  };

  const runSwitchBranch = async (branch: string) => {
    try {
      await api.git.checkout(projectId, branch);
      setSelectedPath(null);
      setSelectedBucket(null);
    } catch (err) {
      surfaceError(toMessage(err, 'Checkout failed'));
    }
  };

  const handleSwitchBranch = (branch: string) => {
    if (hasUnstaged) {
      setConfirm({ kind: 'switchBranch', branch });
      return;
    }
    void runSwitchBranch(branch);
  };

  const handleCreateBranch = async (name: string) => {
    try {
      await api.git.createBranch(projectId, name, true);
    } catch (err) {
      surfaceError(toMessage(err, 'Branch creation failed'));
    }
  };

  const menuItems: GitMenuItem[] = [
    {
      label: status.behind > 0 ? `Pull (${status.behind})` : 'Pull',
      onClick: () => void handlePull(),
      disabled: !hasUpstream,
    },
    { label: 'Fetch', onClick: () => void handleFetch() },
    {
      label: status.ahead > 0 ? `Push (${status.ahead})` : 'Push',
      onClick: () => void handlePush(),
    },
    {
      label: 'Sync',
      onClick: () => void handleSync(),
      disabled: !hasUpstream,
    },
    { label: 'Stash', onClick: () => void handleStash(), separatorBefore: true, disabled: !hasUnstaged && stagedCount === 0 },
    { label: 'Pop Stash', onClick: () => void handleStashPop() },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <GitPanelHeader
        branch={status.branch}
        ahead={status.ahead}
        behind={status.behind}
        onOpenBranchPicker={() => setBranchPickerOpen(true)}
        onRefresh={() => void refresh()}
        menuItems={menuItems}
        error={error}
        onDismissError={() => setError(null)}
      />

      <ProjectBody
        projectId={projectId}
        status={status}
        stagedCount={stagedCount}
        selectedPath={selectedPath}
        selectedBucket={selectedBucket}
        refreshKey={refreshKey}
        isMobile={isMobile}
        showMobileDiff={showMobileDiff}
        onBack={() => setMobileDiffOpen(false)}
        onSelect={handleSelect}
        onStage={handleStage}
        onUnstage={handleUnstage}
        onDiscard={(files) => setConfirm({ kind: 'discard', files })}
        onDiscardAll={(files) => setConfirm({ kind: 'discardAll', files })}
        onCommit={handleCommit}
        onGenerateMessage={generateMessage}
        onDiffError={surfaceError}
      />

      <GitBranchQuickPick
        open={branchPickerOpen}
        projectId={projectId}
        current={status.branch}
        onClose={() => setBranchPickerOpen(false)}
        onSwitch={handleSwitchBranch}
        onCreate={handleCreateBranch}
      />

      <GitConfirmDialog
        open={confirm?.kind === 'discard'}
        title="Discard Changes"
        destructive
        confirmLabel="Discard"
        body={
          confirm?.kind === 'discard' && confirm.files.length === 1 ? (
            <span>
              Discard changes to <code>{confirm.files[0]}</code>?
            </span>
          ) : (
            <span>
              Discard changes to {confirm?.kind === 'discard' ? confirm.files.length : 0} files?
            </span>
          )
        }
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm?.kind === 'discard') void runDiscard(confirm.files);
          setConfirm(null);
        }}
      />

      <GitConfirmDialog
        open={confirm?.kind === 'discardAll'}
        title="Discard All Changes"
        destructive
        confirmLabel="Discard All"
        body={
          <span>
            Discard all {confirm?.kind === 'discardAll' ? confirm.files.length : 0} changes? This cannot be undone.
          </span>
        }
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm?.kind === 'discardAll') void runDiscard(confirm.files);
          setConfirm(null);
        }}
      />

      <GitConfirmDialog
        open={confirm?.kind === 'switchBranch'}
        title="Switch Branch"
        confirmLabel="Switch"
        body={
          <span>
            Switching to <code>{confirm?.kind === 'switchBranch' ? confirm.branch : ''}</code> may overwrite uncommitted work. Continue?
          </span>
        }
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm?.kind === 'switchBranch') void runSwitchBranch(confirm.branch);
          setConfirm(null);
        }}
      />
    </div>
  );
}

interface ProjectBodyProps {
  projectId: string;
  status: GitStatusSummary;
  stagedCount: number;
  selectedPath: string | null;
  selectedBucket: 'staged' | 'unstaged' | null;
  refreshKey: number;
  isMobile: boolean;
  showMobileDiff: boolean;
  onBack: () => void;
  onSelect: (file: GitFileEntry, bucket: 'staged' | 'unstaged') => void;
  onStage: (files: string[]) => void;
  onUnstage: (files: string[]) => void;
  onDiscard: (files: string[]) => void;
  onDiscardAll: (files: string[]) => void;
  onCommit: (message: string) => Promise<void>;
  onGenerateMessage: () => Promise<string | null>;
  onDiffError: (message: string) => void;
}

function ProjectBody({
  projectId,
  status,
  stagedCount,
  selectedPath,
  selectedBucket,
  refreshKey,
  isMobile,
  showMobileDiff,
  onBack,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  onDiscardAll,
  onCommit,
  onGenerateMessage,
  onDiffError,
}: ProjectBodyProps) {
  const listRail = (
    <div
      style={{
        ...(isMobile
          ? { width: '100%' }
          : {
              width: 320,
              minWidth: 240,
              maxWidth: '40%',
              borderRight: '1px solid var(--border)',
            }),
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <GitCommitBox
        stagedCount={stagedCount}
        onCommit={onCommit}
        onGenerateMessage={onGenerateMessage}
      />
      <div className="mt-scroll" style={{ flex: 1, overflow: 'auto' }}>
        <GitChangeList
          projectId={projectId}
          staged={status.staged}
          unstaged={status.unstaged}
          untracked={status.untracked}
          conflicted={status.conflicted}
          selectedPath={selectedPath}
          selectedBucket={selectedBucket}
          onSelect={onSelect}
          onStage={onStage}
          onUnstage={onUnstage}
          onDiscard={onDiscard}
          onDiscardAll={onDiscardAll}
        />
        <GitWorktreeList projectId={projectId} refreshKey={refreshKey} onError={onDiffError} />
      </div>
    </div>
  );

  const diffPane = (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <GitDiffEditor
        projectId={projectId}
        filePath={selectedPath}
        staged={selectedBucket === 'staged'}
        refreshKey={refreshKey}
        onError={onDiffError}
        onBack={isMobile ? onBack : undefined}
      />
    </div>
  );

  // Mobile: single column — the change list, or the selected file's diff.
  // Desktop: list rail + diff pane side by side.
  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
      {isMobile ? (showMobileDiff ? diffPane : listRail) : (
        <>
          {listRail}
          {diffPane}
        </>
      )}
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
      }}
    >
      {children}
    </div>
  );
}

function toMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === 'object' && err && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string') return m || fallback;
  }
  return fallback;
}
