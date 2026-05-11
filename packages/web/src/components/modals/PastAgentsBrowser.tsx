import React, { useState } from 'react';
import { useTranscripts, type TranscriptGroup, type TranscriptSession } from '../../hooks/useTranscripts';
import { PastAgentsList } from '../sidebar/PastAgentsList';
import {
  resumePastSession,
  selectPinnedSession,
  createOrOpenProjectForCwd,
} from '../../lib/pastAgents';

interface Props {
  onClose: () => void;
}

export function PastAgentsBrowser({ onClose }: Props) {
  const [query, setQuery] = useState('');
  const [scopeCwd, setScopeCwd] = useState('');
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [creatingCwd, setCreatingCwd] = useState<string | null>(null);

  const { data, loading, error, grouped, debouncedQuery, loadMoreForCwd, isDeepLoaded } =
    useTranscripts({ query, cwd: scopeCwd, enabled: true, limit: 200 });

  const handleSession = async (session: TranscriptSession) => {
    if (resumingId || creatingCwd) return;
    setResumingId(session.sessionId);
    try {
      let ok = false;
      if (session.pinnedSessionId) {
        ok = await selectPinnedSession(session.pinnedSessionId);
      } else {
        ok = await resumePastSession(session.sessionId);
      }
      if (ok) onClose();
    } finally {
      setResumingId(null);
    }
  };

  const handleProject = async (group: TranscriptGroup) => {
    if (resumingId || creatingCwd) return;
    setCreatingCwd(group.cwd);
    try {
      const ok = await createOrOpenProjectForCwd(group.cwd);
      if (ok) onClose();
    } finally {
      setCreatingCwd(null);
    }
  };

  return (
    <div style={{ maxHeight: 320, overflowY: 'auto' }} className="mt-scroll">
      <PastAgentsList
        mode="modal"
        data={data}
        grouped={grouped}
        loading={loading}
        error={error}
        debouncedQuery={debouncedQuery}
        query={query}
        onQueryChange={setQuery}
        scopeCwd={scopeCwd}
        onScopeCwdChange={setScopeCwd}
        hidePinned={false}
        perGroupLimit={5}
        defaultExpandedProjects={3}
        inFlightSessionId={resumingId}
        inFlightProjectCwd={creatingCwd}
        onPickSession={handleSession}
        onPickProject={handleProject}
        loadMoreForCwd={loadMoreForCwd}
        isDeepLoaded={isDeepLoaded}
      />
    </div>
  );
}
