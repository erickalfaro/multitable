import React, { useState } from 'react';
import { ChevronRight, Search, X } from 'lucide-react';
import { Input, Select, Spinner, IconButton } from '../ui';
import { relativeTime } from '../../lib/relativeTime';
import type {
  TranscriptGroup,
  TranscriptSession,
  TranscriptsData,
} from '../../hooks/useTranscripts';

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

interface SessionRowProps {
  session: TranscriptSession;
  inFlight: boolean;
  indent: number;
  onClick: () => void;
}

function SessionRow({ session, inFlight, indent, onClick }: SessionRowProps) {
  const isLinked = !!session.pinnedSessionId;
  return (
    <div
      onClick={() => {
        if (inFlight) return;
        onClick();
      }}
      style={{
        padding: `4px 16px 4px ${indent}px`,
        cursor: inFlight ? 'wait' : 'pointer',
        fontSize: 12,
        color: isLinked ? 'var(--text-muted)' : 'var(--text-primary)',
        opacity: isLinked ? 0.7 : 1,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
      title={
        (isLinked ? '(already pinned — click to switch)\n' : '(click to resume)\n') +
        (session.firstPrompt || '(no prompt yet)') +
        `\n\n${session.cwd}\nsession: ${session.sessionId}`
      }
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {truncate(session.firstPrompt || '(no prompt)', 80)}
      </span>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
        {relativeTime(session.mtime)}
      </span>
    </div>
  );
}

interface FlatListProps {
  sessions: TranscriptSession[];
  totalCount: number;
  perGroupLimit: number;
  hidePinned: boolean;
  inFlightSessionId: string | null;
  onPickSession: (s: TranscriptSession) => void;
  onLoadMore: () => void;
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  emptyText: string;
  loading: boolean;
  hasFetched: boolean;
}

function FlatList({
  sessions,
  totalCount,
  perGroupLimit,
  hidePinned,
  inFlightSessionId,
  onPickSession,
  onLoadMore,
  showAll,
  setShowAll,
  emptyText,
  loading,
  hasFetched,
}: FlatListProps) {
  const filtered = hidePinned ? sessions.filter((s) => !s.pinnedSessionId) : sessions;
  const visible = showAll ? filtered : filtered.slice(0, perGroupLimit);
  const hiddenLocally = filtered.length - visible.length;
  const hasMoreOnServer = totalCount > sessions.length;
  const showMore = !showAll && (hiddenLocally > 0 || hasMoreOnServer);

  if (loading && !hasFetched) {
    return (
      <div
        style={{
          padding: '6px 16px 6px 30px',
          fontSize: 11,
          color: 'var(--text-muted)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Spinner size="sm" /> Scanning{'…'}
      </div>
    );
  }
  if (filtered.length === 0) {
    return (
      <div style={{ padding: '4px 16px 6px 30px', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
        {emptyText}
      </div>
    );
  }
  return (
    <>
      {visible.map((s) => (
        <SessionRow
          key={s.sessionId}
          session={s}
          inFlight={inFlightSessionId === s.sessionId}
          indent={30}
          onClick={() => onPickSession(s)}
        />
      ))}
      {showMore && (
        <div
          onClick={() => {
            setShowAll(true);
            if (hasMoreOnServer) onLoadMore();
          }}
          style={{
            padding: '3px 16px 3px 30px',
            fontSize: 11,
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontStyle: 'italic',
          }}
        >
          Show more ({Math.max(filtered.length - perGroupLimit, totalCount - sessions.length)} more)
        </div>
      )}
      {showAll && filtered.length > perGroupLimit && (
        <div
          onClick={() => setShowAll(false)}
          style={{
            padding: '3px 16px 3px 30px',
            fontSize: 11,
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontStyle: 'italic',
          }}
        >
          Show less
        </div>
      )}
    </>
  );
}

interface ProjectModeProps {
  mode: 'project';
  group: TranscriptGroup | null;
  loading: boolean;
  error: string | null;
  hasFetched: boolean;
  hidePinned?: boolean;
  perGroupLimit?: number;
  inFlightSessionId?: string | null;
  onPickSession: (s: TranscriptSession) => void;
  onLoadMore: () => void;
  emptyText?: string;
}

interface ModalModeProps {
  mode: 'modal';
  data: TranscriptsData | null;
  grouped: TranscriptGroup[];
  loading: boolean;
  error: string | null;
  debouncedQuery: string;
  query: string;
  onQueryChange: (q: string) => void;
  scopeCwd: string;
  onScopeCwdChange: (cwd: string) => void;
  hidePinned?: boolean;
  perGroupLimit?: number;
  defaultExpandedProjects?: number;
  inFlightSessionId?: string | null;
  inFlightProjectCwd?: string | null;
  onPickSession: (s: TranscriptSession) => void;
  onPickProject?: (g: TranscriptGroup) => void;
  loadMoreForCwd: (cwd: string, totalCount: number) => Promise<void>;
  isDeepLoaded: (cwd: string) => boolean;
}

export type PastAgentsListProps = ProjectModeProps | ModalModeProps;

export function PastAgentsList(props: PastAgentsListProps) {
  if (props.mode === 'project') {
    return <ProjectModeList {...props} />;
  }
  return <ModalModeList {...props} />;
}

function ProjectModeList(props: ProjectModeProps) {
  const {
    group,
    loading,
    error,
    hasFetched,
    hidePinned = true,
    perGroupLimit = 5,
    inFlightSessionId = null,
    onPickSession,
    onLoadMore,
    emptyText = 'No past agents yet',
  } = props;
  const [showAll, setShowAll] = useState(false);

  if (error) {
    return (
      <div style={{ padding: '4px 16px 6px 30px', fontSize: 11, color: 'var(--status-error)' }}>{error}</div>
    );
  }

  const sessions = group?.sessions ?? [];
  const totalCount = group?.totalCount ?? 0;

  return (
    <FlatList
      sessions={sessions}
      totalCount={totalCount}
      perGroupLimit={perGroupLimit}
      hidePinned={hidePinned}
      inFlightSessionId={inFlightSessionId}
      onPickSession={onPickSession}
      onLoadMore={onLoadMore}
      showAll={showAll}
      setShowAll={setShowAll}
      emptyText={emptyText}
      loading={loading}
      hasFetched={hasFetched}
    />
  );
}

function ModalModeList(props: ModalModeProps) {
  const {
    data,
    grouped,
    loading,
    error,
    debouncedQuery,
    query,
    onQueryChange,
    scopeCwd,
    onScopeCwdChange,
    hidePinned = false,
    perGroupLimit = 5,
    defaultExpandedProjects = 3,
    inFlightSessionId = null,
    inFlightProjectCwd = null,
    onPickSession,
    onPickProject,
    loadMoreForCwd,
    isDeepLoaded,
  } = props;

  const [groupOverrides, setGroupOverrides] = useState<Map<string, boolean>>(new Map());
  const [groupShowAll, setGroupShowAll] = useState<Set<string>>(new Set());

  const isGroupExpanded = (cwd: string, idx: number): boolean => {
    if (groupOverrides.has(cwd)) return groupOverrides.get(cwd)!;
    if (debouncedQuery) return true;
    return idx < defaultExpandedProjects;
  };

  const toggleGroup = (cwd: string, idx: number) => {
    const currentlyExpanded = isGroupExpanded(cwd, idx);
    setGroupOverrides((prev) => {
      const next = new Map(prev);
      next.set(cwd, !currentlyExpanded);
      return next;
    });
  };

  const handleShowMore = async (cwd: string, totalCount: number) => {
    setGroupShowAll((prev) => new Set(prev).add(cwd));
    if (!isDeepLoaded(cwd)) {
      await loadMoreForCwd(cwd, totalCount);
    }
  };

  const handleShowLess = (cwd: string) => {
    setGroupShowAll((prev) => {
      const next = new Set(prev);
      next.delete(cwd);
      return next;
    });
  };

  return (
    <div>
      <div style={{ padding: '4px 0 6px' }}>
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={'Search past agents…'}
          leftIcon={<Search size={12} />}
          rightIcon={
            query ? (
              <IconButton size="sm" onClick={() => onQueryChange('')} label="Clear search">
                <X size={12} />
              </IconButton>
            ) : undefined
          }
          style={{ fontSize: 12, padding: '5px 0' }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 0 6px' }}>
        <Select
          value={scopeCwd}
          onChange={(e) => onScopeCwdChange(e.target.value)}
          style={{ fontSize: 11, padding: '5px 28px 5px 10px', flex: 1 }}
        >
          <option value="">All projects</option>
          {data?.projects.map((p) => (
            <option key={p.cwd} value={p.cwd}>
              {p.projectName} ({p.sessionCount})
            </option>
          ))}
        </Select>
      </div>

      {loading && !data && (
        <div
          style={{
            padding: '6px 4px',
            fontSize: 11,
            color: 'var(--text-muted)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Spinner size="sm" /> Scanning{'…'}
        </div>
      )}
      {error && <div style={{ padding: '6px 4px', fontSize: 11, color: 'var(--status-error)' }}>{error}</div>}
      {data && data.sessions.length === 0 && !loading && (
        <div style={{ padding: '6px 4px', fontSize: 11, color: 'var(--text-muted)' }}>
          {debouncedQuery ? 'No matches' : 'No past agents found'}
        </div>
      )}

      {grouped.map((group, idx) => {
        const expanded = isGroupExpanded(group.cwd, idx);
        const showAll = groupShowAll.has(group.cwd);
        const filteredSessions = hidePinned
          ? group.sessions.filter((s) => !s.pinnedSessionId)
          : group.sessions;
        const visibleSessions = showAll ? filteredSessions : filteredSessions.slice(0, perGroupLimit);
        const hiddenLocally = filteredSessions.length - visibleSessions.length;
        const hasMoreOnServer = group.totalCount > group.sessions.length;
        const projectInFlight = inFlightProjectCwd === group.cwd;
        return (
          <div key={group.cwd} style={{ marginBottom: 4 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '4px 6px',
                cursor: projectInFlight ? 'wait' : 'pointer',
                userSelect: 'none',
                WebkitUserSelect: 'none',
                fontSize: 12,
                color: 'var(--text-secondary)',
                borderRadius: 'var(--radius-sm)',
              }}
              title={group.cwd}
            >
              <ChevronRight
                size={11}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleGroup(group.cwd, idx);
                }}
                style={{
                  color: 'var(--text-muted)',
                  transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform var(--dur-fast) var(--ease-out)',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              />
              <span
                onClick={() => {
                  if (projectInFlight) return;
                  if (onPickProject) onPickProject(group);
                  else toggleGroup(group.cwd, idx);
                }}
                style={{ marginLeft: 4, fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {group.projectName}
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 10,
                  color: 'var(--text-muted)',
                  fontVariantNumeric: 'tabular-nums',
                  flexShrink: 0,
                }}
              >
                {group.totalCount}
              </span>
            </div>
            {expanded && (
              <>
                {visibleSessions.map((s) => (
                  <SessionRow
                    key={s.sessionId}
                    session={s}
                    inFlight={inFlightSessionId === s.sessionId}
                    indent={24}
                    onClick={() => onPickSession(s)}
                  />
                ))}
                {filteredSessions.length === 0 && (
                  <div style={{ padding: '4px 16px 4px 24px', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    No past agents
                  </div>
                )}
                {(hiddenLocally > 0 || hasMoreOnServer) && !showAll && (
                  <div
                    onClick={() => handleShowMore(group.cwd, group.totalCount)}
                    style={{
                      padding: '3px 16px 3px 24px',
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      fontStyle: 'italic',
                    }}
                  >
                    Show more ({group.totalCount - perGroupLimit} more)
                  </div>
                )}
                {showAll && filteredSessions.length > perGroupLimit && (
                  <div
                    onClick={() => handleShowLess(group.cwd)}
                    style={{
                      padding: '3px 16px 3px 24px',
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      fontStyle: 'italic',
                    }}
                  >
                    Show less
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
