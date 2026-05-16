import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';
import toast from 'react-hot-toast';
import { Search, RefreshCw } from 'lucide-react';
import { Modal, Button, Input, ProviderLogo, Spinner } from '../ui';
import { useTranscripts, type TranscriptSession } from '../../hooks/useTranscripts';
import { useCodexTranscripts } from '../../hooks/useCodexTranscripts';
import { resumePastSession, resumePastCodexThread, selectPinnedSession } from '../../lib/pastAgents';
import { relativeTime } from '../../lib/relativeTime';
import type { AgentProvider, DiscoveredModel } from '../../lib/types';

type AgentProviderOption = 'claude' | 'codex' | undefined;

const AGENTS: Array<{
  name: string;
  command: string;
  provider?: AgentProviderOption;
  comingSoon?: boolean;
}> = [
  { name: 'Claude Code', command: 'claude', provider: 'claude' },
  { name: 'Codex', command: 'codex', provider: 'codex' },
  { name: 'Gemini CLI', command: 'gemini', comingSoon: true },
  { name: 'GitHub Copilot', command: 'copilot', comingSoon: true },
  { name: 'opencode', command: 'opencode', comingSoon: true },
  { name: 'Amp', command: 'amp', comingSoon: true },
  { name: 'Aider', command: 'aider', comingSoon: true },
  { name: 'Goose', command: 'goose', comingSoon: true },
  { name: 'Pi', command: 'pi', comingSoon: true },
];

interface Props {
  onClose: () => void;
  projectId: string;
}

type ModelsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; models: DiscoveredModel[] }
  | { status: 'error'; message: string };

export function AddAgentModal({ onClose, projectId }: Props) {
  const store = useAppStore();
  const projectPath = useAppStore((s) => s.projects.find((p) => p.id === projectId)?.path);
  const [loading, setLoading] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('Claude Code');
  const [agentProvider, setAgentProvider] = useState<AgentProviderOption>('claude');
  const [searchQuery, setSearchQuery] = useState('');
  // Per-provider model catalog and the user's pick. The catalog is fetched
  // every time a provider is selected — never cached across modal opens —
  // so a model added on the server side shows up the next time the user
  // creates a session.
  const [modelsState, setModelsState] = useState<ModelsState>({ status: 'idle' });
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const modelFetchSeq = useRef(0);
  // Two mutually exclusive intents: either "create a fresh session with the
  // selected preset" (selectedPastSession === null) or "resume this past
  // chat" (selectedPastSession set). Start button switches behavior on this.
  const [selectedPastSession, setSelectedPastSession] = useState<{
    provider: AgentProvider;
    sessionId: string;
    pinnedSessionId: string | null;
  } | null>(null);

  // Selected preset is the source of truth for `name` and `command`. Sessions
  // get auto-renamed from the first user prompt anyway, so the initial name is
  // just metadata until then.
  const selectedPreset = useMemo(
    () => AGENTS.find((a) => a.name === selectedAgent),
    [selectedAgent],
  );

  const { loading: pastLoading, error: pastError, grouped, loadMoreForCwd } = useTranscripts({
    cwd: projectPath,
    enabled: !!projectPath,
    limit: 20,
  });
  const pastGroup = useMemo(() => grouped[0] ?? null, [grouped]);

  const {
    group: codexGroup,
    loading: codexLoading,
    error: codexError,
  } = useCodexTranscripts({ cwd: projectPath, enabled: !!projectPath, limit: 20 });

  const handlePickPastRow = (session: TranscriptSession, provider: AgentProvider) => {
    setSelectedPastSession({
      provider,
      sessionId: session.sessionId,
      pinnedSessionId: session.pinnedSessionId,
    });
  };

  const handlePresetClick = (agent: typeof AGENTS[number]) => {
    if (agent.comingSoon) return;
    setSelectedAgent(agent.name);
    setAgentProvider(agent.provider);
    // Picking a preset clears any past-row selection — they're mutually
    // exclusive intents.
    setSelectedPastSession(null);
  };

  // Refresh the model catalog every time the provider changes (and on first
  // open). The seq guard discards the result of an in-flight request whose
  // provider is no longer selected — prevents a slow Claude fetch from
  // overwriting a faster Codex one if the user toggles between them.
  useEffect(() => {
    if (selectedPastSession) {
      // Resuming a past session inherits the model recorded on that row;
      // model picker is hidden, so skip the fetch.
      return;
    }
    if (!agentProvider) {
      setModelsState({ status: 'idle' });
      setSelectedModel(null);
      return;
    }
    const provider = agentProvider;
    const seq = ++modelFetchSeq.current;
    setModelsState({ status: 'loading' });
    setSelectedModel(null);
    api.providers
      .models(provider)
      .then((res) => {
        if (modelFetchSeq.current !== seq) return;
        const models = (res.models ?? []) as DiscoveredModel[];
        setModelsState({ status: 'ready', models });
        const def = models.find((m) => m.isDefault) ?? models[0];
        setSelectedModel(def?.id ?? null);
      })
      .catch((err: unknown) => {
        if (modelFetchSeq.current !== seq) return;
        const message = err instanceof Error ? err.message : String(err);
        setModelsState({ status: 'error', message });
        setSelectedModel(null);
      });
  }, [agentProvider, selectedPastSession]);

  const handleSubmit = async () => {
    if (loading) return;
    setLoading(true);
    try {
      if (selectedPastSession) {
        const { provider, sessionId, pinnedSessionId } = selectedPastSession;
        const ok =
          provider === 'codex'
            ? await resumePastCodexThread(sessionId)
            : pinnedSessionId
              ? await selectPinnedSession(pinnedSessionId)
              : await resumePastSession(sessionId);
        if (ok) onClose();
        return;
      }
      if (!selectedPreset || !selectedPreset.command) return;
      if (!selectedModel) {
        toast.error('Pick a model first');
        return;
      }
      const session = await api.sessions.create(projectId, {
        name: selectedPreset.name,
        command: selectedPreset.command,
        ...(agentProvider ? { agentProvider } : {}),
        model: selectedModel,
      });
      store.upsertSession(session);
      store.setSelectedProcess(session.id);
      toast.success('Agent added');
      onClose();
    } catch {
      toast.error('Failed to start');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit();
  };

  const needsModel = !selectedPastSession && !!selectedPreset && !!selectedPreset.command;
  const submitDisabled =
    loading ||
    (!selectedPastSession && (!selectedPreset || !selectedPreset.command)) ||
    (needsModel && !selectedModel);
  const startLabel = selectedPastSession
    ? loading
      ? 'Resuming…'
      : 'Resume'
    : loading
      ? 'Starting…'
      : 'Start';

  return (
    <Modal
      open
      onClose={onClose}
      width={620}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={submitDisabled}
            loading={loading}
          >
            {startLabel}
          </Button>
        </>
      }
    >
      <div onKeyDown={handleKeyDown}>
        {/* Compact agent picker. Each tile is logo + name; coming-soon
            entries are dimmed without a separate badge to keep the row tight. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 6,
            marginBottom: 12,
          }}
        >
          {AGENTS.map((agent) => {
            const comingSoon = !!agent.comingSoon;
            // The preset is "active" only when no past row is staged for resume.
            // When a past row is selected, dim the preset row so it's clear
            // which intent Start will follow.
            const selected = !selectedPastSession && selectedAgent === agent.name;
            const desaturated = !!selectedPastSession;
            return (
              <button
                key={agent.name}
                onClick={() => handlePresetClick(agent)}
                disabled={comingSoon}
                title={comingSoon ? `${agent.name} — coming soon` : agent.name}
                style={{
                  padding: '8px 8px',
                  height: 56,
                  borderRadius: 'var(--radius-md)',
                  border: `1px solid ${selected ? 'var(--accent-amber)' : 'var(--border)'}`,
                  backgroundColor: selected
                    ? 'color-mix(in srgb, var(--accent-amber) 10%, transparent)'
                    : 'var(--bg-sidebar)',
                  color: comingSoon ? 'var(--text-faint)' : 'var(--text-primary)',
                  cursor: comingSoon ? 'not-allowed' : 'pointer',
                  opacity: comingSoon ? 0.45 : desaturated ? 0.55 : 1,
                  fontSize: 11.5,
                  fontWeight: selected ? 600 : 500,
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                  gap: 8,
                  boxShadow: selected ? '0 0 0 1px var(--accent-amber)' : 'none',
                  transition:
                    'box-shadow var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out)',
                }}
              >
                {agent.provider ? (
                  <ProviderLogo
                    provider={agent.provider}
                    size={18}
                    style={{
                      color: selected ? 'var(--accent-amber)' : 'var(--text-secondary)',
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <span
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 'var(--radius-snug)',
                      border: '1px dashed var(--border-strong)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 10,
                      color: 'var(--text-faint)',
                      flexShrink: 0,
                    }}
                    aria-hidden
                  >
                    ?
                  </span>
                )}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {agent.name}
                </span>
              </button>
            );
          })}
        </div>

        {!selectedPastSession && agentProvider && (
          <ModelPicker
            provider={agentProvider}
            state={modelsState}
            selected={selectedModel}
            onSelect={setSelectedModel}
            onRefresh={async () => {
              // Trigger live discovery on the daemon side. The catalog update
              // arrives via the providers:catalog-updated WS event; we also
              // re-fetch the local picker state so the loading shimmer makes
              // sense even before the WS event lands.
              setModelsState({ status: 'loading' });
              try {
                await api.providers.refresh(agentProvider);
                // Small grace period for the daemon to finish discovery.
                // The WS handler will overwrite our state if the response
                // comes back faster; we just need a fallback fetch in case
                // the WS connection is flaky.
                const res = await api.providers.models(agentProvider);
                const refreshed = (res.models ?? []) as DiscoveredModel[];
                setModelsState({ status: 'ready', models: refreshed });
                const def = refreshed.find((m) => m.isDefault) ?? refreshed[0];
                if (!selectedModel && def) setSelectedModel(def.id);
                toast.success(`${agentProvider} catalog refreshed`, { duration: 1500 });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                setModelsState({ status: 'error', message });
                toast.error(`Refresh failed: ${message}`);
              }
            }}
          />
        )}

        {projectPath && (
          <PastSessionsMerged
            claudeSessions={pastGroup?.sessions ?? []}
            codexSessions={codexGroup?.sessions ?? []}
            claudeLoading={pastLoading}
            codexLoading={codexLoading}
            error={pastError ?? codexError}
            selectedKey={
              selectedPastSession
                ? `${selectedPastSession.provider}:${selectedPastSession.sessionId}`
                : null
            }
            onPickRow={handlePickPastRow}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            // Claude transcripts list is server-paginated; pull the rest in one
            // shot when the user actually starts searching or scrolling so the
            // search covers the full project history.
            onPullAllClaude={() => {
              if (pastGroup) loadMoreForCwd(pastGroup.cwd, pastGroup.totalCount);
            }}
            claudeHasMoreOnServer={
              !!pastGroup && pastGroup.totalCount > pastGroup.sessions.length
            }
          />
        )}
      </div>
    </Modal>
  );
}

// ─── Model picker ─────────────────────────────────────────────────────────────
// Renders the runtime-discovered model catalog for the selected provider as a
// vertical list of selectable rows. The catalog comes from the daemon's
// /api/providers/:provider/models endpoint, which probes the provider's CLI
// each call (codex: `codex debug models`; claude: Anthropic API or alias set).
// We do not cache it on the client — picking a provider always re-fetches.

interface ModelPickerProps {
  provider: 'claude' | 'codex';
  state: ModelsState;
  selected: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => Promise<void> | void;
}

function ModelPicker({ provider, state, selected, onSelect, onRefresh }: ModelPickerProps) {
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 500,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          marginBottom: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>Model · {provider}</span>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing || state.status === 'loading'}
          title={`Re-discover ${provider} models. Useful after upgrading the provider CLI or rotating API keys.`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            height: 22,
            padding: '0 8px',
            fontFamily: 'inherit',
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 999,
            cursor: refreshing || state.status === 'loading' ? 'not-allowed' : 'pointer',
            opacity: refreshing || state.status === 'loading' ? 0.55 : 1,
            transition: 'background var(--dur-fast) var(--ease-out)',
          }}
        >
          <RefreshCw
            size={11}
            strokeWidth={2.2}
            style={{
              animation: refreshing ? 'mt-spin 1s linear infinite' : 'none',
            }}
          />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {state.status === 'loading' && (
        <div
          style={{
            padding: '10px 12px',
            fontSize: 11.5,
            color: 'var(--text-muted)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <Spinner size="sm" /> Fetching available models…
        </div>
      )}
      {state.status === 'error' && (
        <div
          style={{
            padding: '10px 12px',
            fontSize: 11.5,
            color: 'var(--status-error)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            backgroundColor:
              'color-mix(in srgb, var(--status-error) 6%, transparent)',
          }}
          title={state.message}
        >
          Couldn't load {provider} models: {state.message}
        </div>
      )}
      {state.status === 'ready' && state.models.length === 0 && (
        <div
          style={{
            padding: '10px 12px',
            fontSize: 11.5,
            color: 'var(--text-muted)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          No models reported by {provider}.
        </div>
      )}
      {state.status === 'ready' && state.models.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 6,
          }}
        >
          {state.models.map((m) => {
            const isSelected = selected === m.id;
            return (
              <button
                key={m.id}
                onClick={() => onSelect(m.id)}
                title={m.description || m.displayName}
                style={{
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-md)',
                  border: `1px solid ${
                    isSelected ? 'var(--accent-amber)' : 'var(--border)'
                  }`,
                  backgroundColor: isSelected
                    ? 'color-mix(in srgb, var(--accent-amber) 10%, transparent)'
                    : 'var(--bg-sidebar)',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  fontSize: 11.5,
                  fontWeight: isSelected ? 600 : 500,
                  textAlign: 'left',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  boxShadow: isSelected ? '0 0 0 1px var(--accent-amber)' : 'none',
                  transition:
                    'box-shadow var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out)',
                }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {m.displayName}
                </span>
                {m.description && (
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 400,
                      color: 'var(--text-muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {m.description}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Merged past-sessions list ────────────────────────────────────────────────
// Interleaves Claude + Codex past sessions for the current project, sorted by
// recency. Each row shows a tiny `claude`/`codex` pill so you can tell which
// runtime authored it before clicking. Click routes to the right resume API.

interface MergedRow extends TranscriptSession {
  provider: AgentProvider;
}

interface MergedProps {
  claudeSessions: TranscriptSession[];
  codexSessions: TranscriptSession[];
  claudeLoading: boolean;
  codexLoading: boolean;
  error: string | null;
  /** `${provider}:${sessionId}` of the row currently staged for resume. */
  selectedKey: string | null;
  /** Stage a row as the resume target. The actual resume fires from the
   * Start button — clicking a row never auto-opens the session. */
  onPickRow: (s: TranscriptSession, provider: AgentProvider) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onPullAllClaude: () => void;
  claudeHasMoreOnServer: boolean;
}

function PastSessionsMerged({
  claudeSessions,
  codexSessions,
  claudeLoading,
  codexLoading,
  error,
  selectedKey,
  onPickRow,
  searchQuery,
  onSearchChange,
  onPullAllClaude,
  claudeHasMoreOnServer,
}: MergedProps) {
  // When the user starts searching, pull the rest of the server-paginated
  // Claude transcript list so the filter sees the full project history. Same
  // when the scroller approaches the bottom — keeps the scroll feel of a
  // single continuous list rather than a paginated one.
  const pulledRef = React.useRef(false);
  const triggerPull = () => {
    if (pulledRef.current) return;
    if (!claudeHasMoreOnServer) return;
    pulledRef.current = true;
    onPullAllClaude();
  };

  const merged: MergedRow[] = useMemo(() => {
    const claudeRows: MergedRow[] = claudeSessions
      .filter((s) => !s.pinnedSessionId)
      .map((s) => ({ ...s, provider: 'claude' as const }));
    const codexRows: MergedRow[] = codexSessions.map((s) => ({
      ...s,
      provider: 'codex' as const,
    }));
    return [...claudeRows, ...codexRows].sort((a, b) => b.mtime - a.mtime);
  }, [claudeSessions, codexSessions]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return merged;
    return merged.filter((row) => (row.firstPrompt ?? '').toLowerCase().includes(q));
  }, [merged, searchQuery]);

  const isLoading = claudeLoading || codexLoading;

  return (
    <div
      style={{
        marginTop: 16,
        paddingTop: 14,
        borderTop: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {/* Header — section title with subtle count, search occupies its own row.
          Title + count uses dot-separator (cleaner than parens) and lives at
          a small caps weight so it reads as label, not heading. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 10,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            fontSize: 10,
            fontWeight: 500,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
          }}
        >
          <span>Past agents</span>
          {merged.length > 0 && (
            <span
              style={{
                color: 'var(--text-muted)',
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: 0,
                textTransform: 'none',
              }}
            >
              · {searchQuery.trim() ? `${filtered.length} of ${merged.length}` : merged.length}
            </span>
          )}
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <Input
          value={searchQuery}
          onChange={(e) => {
            onSearchChange(e.target.value);
            triggerPull();
          }}
          placeholder="Search history"
          leftIcon={<Search size={13} />}
        />
      </div>

      {/* Scrollable list. Rows are grouped visually by a 3px transparent strip
          on the left — the strip flips to the accent color when selected,
          giving a clear "this is your pick" without the gaudy full-row tint. */}
      <div
        className="mt-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight > el.scrollHeight - 80) triggerPull();
        }}
        style={{
          maxHeight: 360,
          overflowY: 'auto',
          flex: 1,
          // Subtle inset feel: very faint border + a slightly recessed bg so
          // the list feels like a panel, not loose body text.
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          backgroundColor: 'var(--bg-primary)',
        }}
      >
        {isLoading && merged.length === 0 && (
          <div
            style={{
              padding: '14px 16px',
              fontSize: 11.5,
              color: 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Spinner size="sm" /> Scanning history…
          </div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div
            style={{
              padding: '14px 16px',
              fontSize: 11.5,
              color: 'var(--text-muted)',
            }}
          >
            {searchQuery.trim() ? 'No matches.' : 'No past agents for this project yet.'}
          </div>
        )}
        {error && (
          <div
            style={{
              padding: '12px 16px',
              fontSize: 11.5,
              color: 'var(--status-error)',
            }}
          >
            {error}
          </div>
        )}

        {filtered.map((row, idx) => {
          const rowKey = `${row.provider}:${row.sessionId}`;
          const isSelected = selectedKey === rowKey;
          const isLast = idx === filtered.length - 1;
          return (
            <div
              key={rowKey}
              onClick={() => onPickRow(row, row.provider)}
              title={
                (row.firstPrompt || '(no prompt yet)') +
                `\n\n${row.cwd}\n${row.provider}: ${row.sessionId}` +
                '\n\nClick to select · Start to resume'
              }
              style={{
                position: 'relative',
                padding: '11px 14px 11px 16px',
                cursor: 'pointer',
                color: 'var(--text-primary)',
                borderBottom: isLast ? 'none' : '1px solid var(--border)',
                backgroundColor: isSelected ? 'var(--bg-elevated)' : 'transparent',
                transition: 'background-color var(--dur-fast) var(--ease-out)',
              }}
              onMouseEnter={(e) => {
                if (isSelected) return;
                (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--bg-hover)';
              }}
              onMouseLeave={(e) => {
                if (isSelected) return;
                (e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent';
              }}
            >
              {/* Left-edge accent strip — invisible by default, amber when
                  selected. 3px wide, full row height, sits flush left so it
                  reads as a list-item indicator, not a border. */}
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 3,
                  backgroundColor: isSelected ? 'var(--accent-amber)' : 'transparent',
                  transition: 'background-color var(--dur-fast) var(--ease-out)',
                }}
              />

              {/* Prompt text — the hero. Two-line clamp, primary color. */}
              <div
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.4,
                  color: 'var(--text-primary)',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  wordBreak: 'break-word',
                }}
              >
                {row.firstPrompt || '(no prompt)'}
              </div>

              {/* Metadata row — provider monogram + name + relative time, all
                  at the same low-contrast tier so it doesn't compete with
                  the prompt. Provider name is the only color cue. */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 5,
                  fontSize: 10.5,
                  color: 'var(--text-muted)',
                  letterSpacing: '0.04em',
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    color:
                      row.provider === 'claude'
                        ? 'var(--accent-amber)'
                        : 'var(--text-secondary)',
                    opacity: 0.85,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <ProviderLogo provider={row.provider} size={11} />
                  {row.provider}
                </span>
                <span
                  aria-hidden
                  style={{ color: 'var(--text-faint)', opacity: 0.6 }}
                >
                  ·
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {relativeTime(row.mtime)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
