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
import { cleanModelLabel } from '../../lib/modelName';

// Modal body geometry. The body is given a fixed total height so the dialog
// frame never resizes after opening — every internal state transition (model
// catalog fetch, past-agents fetch, provider swap) happens inside fixed-size
// regions, so the user never sees the modal grow or shrink under them.
// Presets well shows 2 rows of tiles (56px each + 6px gap = 118px); any
// additional rows are reachable by scrolling within the well.
const BODY_HEIGHT = 620;
const PRESETS_HEIGHT = 118;
const MODEL_SECTION_HEIGHT = 120;
const SECTION_GAP = 14;

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
  // Read straight from the shared model catalog. Populated at app boot from
  // the daemon's `/api/providers/catalog` snapshot and kept fresh by the
  // `providers:catalog-updated` WS broadcast — so opening this modal never
  // triggers a fetch. The Refresh button is the only path that hits the
  // network.
  const claudeModels = useAppStore((s) => s.modelCatalog.claude);
  const codexModels = useAppStore((s) => s.modelCatalog.codex);
  const refreshError = useRef<{ provider: AgentProviderOption; message: string } | null>(null);
  const [, forceRender] = useState(0);
  const [refreshingProvider, setRefreshingProvider] = useState<AgentProviderOption>(undefined);

  const [loading, setLoading] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('Claude Code');
  const [agentProvider, setAgentProvider] = useState<AgentProviderOption>('claude');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedPastSession, setSelectedPastSession] = useState<{
    provider: AgentProvider;
    sessionId: string;
    pinnedSessionId: string | null;
  } | null>(null);

  // Derived view-state for the model picker. `null` catalog → ready+empty
  // (which the picker renders as a graceful empty-state); the boot seed
  // virtually guarantees this is populated by the time the user opens this
  // modal.
  const modelsForProvider: DiscoveredModel[] | null =
    agentProvider === 'claude'
      ? claudeModels
      : agentProvider === 'codex'
        ? codexModels
        : null;
  const modelsState: ModelsState = (() => {
    if (!agentProvider) return { status: 'idle' };
    if (refreshError.current && refreshError.current.provider === agentProvider) {
      return { status: 'error', message: refreshError.current.message };
    }
    if (refreshingProvider === agentProvider && !modelsForProvider) {
      return { status: 'loading' };
    }
    return { status: 'ready', models: modelsForProvider ?? [] };
  })();

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
    setSelectedPastSession(null);
  };

  // Pick a sensible default model whenever the active provider changes or
  // the catalog lands. No network call here — the catalog is owned by the
  // store and seeded at boot.
  useEffect(() => {
    if (selectedPastSession) return;
    if (!agentProvider) {
      setSelectedModel(null);
      return;
    }
    if (!modelsForProvider || modelsForProvider.length === 0) {
      setSelectedModel(null);
      return;
    }
    const def = modelsForProvider.find((m) => m.isDefault) ?? modelsForProvider[0];
    setSelectedModel(def?.id ?? null);
  }, [agentProvider, modelsForProvider, selectedPastSession]);

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

  const showModelSection = !selectedPastSession && !!agentProvider;
  const pastSectionHeight =
    BODY_HEIGHT - PRESETS_HEIGHT - (showModelSection ? MODEL_SECTION_HEIGHT + SECTION_GAP : 0);

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
      {/* Fixed-height body. Internal sections are laid out top-down with
          stable heights, so the modal frame never resizes during async work. */}
      <div
        onKeyDown={handleKeyDown}
        style={{
          height: BODY_HEIGHT,
          display: 'flex',
          flexDirection: 'column',
          gap: SECTION_GAP,
        }}
      >
        <AgentPresetsRow
          agents={AGENTS}
          selectedAgent={selectedAgent}
          desaturated={!!selectedPastSession}
          onPick={handlePresetClick}
          height={PRESETS_HEIGHT}
        />

        {showModelSection && (
          <div style={{ height: MODEL_SECTION_HEIGHT, flexShrink: 0 }}>
            <ModelPicker
              provider={agentProvider!}
              state={modelsState}
              selected={selectedModel}
              onSelect={setSelectedModel}
              onRefresh={async () => {
                const provider = agentProvider!;
                refreshError.current = null;
                setRefreshingProvider(provider);
                try {
                  await api.providers.refresh(provider);
                  // The daemon broadcasts the fresh catalog via the
                  // `providers:catalog-updated` WS event, which the App-
                  // level handler funnels into `setModelCatalog`. As a
                  // safety net (e.g. flaky WS) we also fetch synchronously.
                  const res = await api.providers.models(provider);
                  const refreshed = (res.models ?? []) as DiscoveredModel[];
                  store.setModelCatalog(provider, refreshed);
                  toast.success(`${provider} catalog refreshed`, { duration: 1500 });
                } catch (err) {
                  const message = err instanceof Error ? err.message : String(err);
                  refreshError.current = { provider, message };
                  forceRender((n) => n + 1);
                  toast.error(`Refresh failed: ${message}`);
                } finally {
                  setRefreshingProvider(undefined);
                }
              }}
            />
          </div>
        )}

        {projectPath && (
          <PastSessionsMerged
            heightPx={pastSectionHeight}
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

// ─── Agent preset row ─────────────────────────────────────────────────────────

interface AgentPresetsRowProps {
  agents: typeof AGENTS;
  selectedAgent: string;
  desaturated: boolean;
  onPick: (agent: typeof AGENTS[number]) => void;
  height: number;
}

function AgentPresetsRow({
  agents,
  selectedAgent,
  desaturated,
  onPick,
  height,
}: AgentPresetsRowProps) {
  return (
    <div
      className="mt-scroll"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 6,
        flexShrink: 0,
        height,
        overflowY: 'auto',
        // A few px of right padding so the scrollbar doesn't sit flush against
        // the last tile in row 1/2 when the third row spills over.
        paddingRight: 4,
      }}
    >
      {agents.map((agent) => {
        const comingSoon = !!agent.comingSoon;
        const selected = !desaturated && selectedAgent === agent.name;
        return (
          <button
            key={agent.name}
            onClick={() => onPick(agent)}
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
  );
}

// ─── Model picker ─────────────────────────────────────────────────────────────

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
  const isBusy = refreshing || state.status === 'loading';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
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
          flexShrink: 0,
        }}
      >
        <span>Model · {provider}</span>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={isBusy}
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
            cursor: isBusy ? 'not-allowed' : 'pointer',
            opacity: isBusy ? 0.55 : 1,
            transition: 'background var(--dur-fast) var(--ease-out)',
          }}
        >
          <RefreshCw
            size={11}
            strokeWidth={2.2}
            style={{ animation: refreshing ? 'mt-spin 1s linear infinite' : 'none' }}
          />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Content well. Always present, always full height, opacity-driven
          state swaps so provider changes feel like a soft crossfade rather
          than a structural rerender. */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <ModelPickerState
          state={state}
          provider={provider}
          selected={selected}
          onSelect={onSelect}
        />
      </div>
    </div>
  );
}

function ModelPickerState({
  state,
  provider,
  selected,
  onSelect,
}: {
  state: ModelsState;
  provider: 'claude' | 'codex';
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const wellStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    padding: 8,
    overflow: 'auto',
  };

  if (state.status === 'loading' || state.status === 'idle') {
    return (
      <div
        style={{
          ...wellStyle,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          color: 'var(--text-muted)',
          fontSize: 11.5,
        }}
      >
        <Spinner size="sm" />
        <span style={{ opacity: 0.8 }}>Fetching {provider} models…</span>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div
        style={{
          ...wellStyle,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11.5,
          color: 'var(--status-error)',
          textAlign: 'center',
          backgroundColor: 'color-mix(in srgb, var(--status-error) 6%, transparent)',
        }}
        title={state.message}
      >
        Couldn't load {provider} models: {state.message}
      </div>
    );
  }

  if (state.models.length === 0) {
    return (
      <div
        style={{
          ...wellStyle,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11.5,
          color: 'var(--text-muted)',
        }}
      >
        No models reported by {provider}.
      </div>
    );
  }

  return (
    <div
      style={{
        ...wellStyle,
        border: 'none',
        padding: 0,
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 6,
          animation: 'mt-fade-in var(--dur-fast) var(--ease-out)',
        }}
      >
        {state.models.map((m) => {
          const isSelected = selected === m.id;
          const cleanedName = cleanModelLabel(m);
          return (
            <button
              key={m.id}
              onClick={() => onSelect(m.id)}
              title={cleanedName}
              style={{
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                border: `1px solid ${isSelected ? 'var(--accent-amber)' : 'var(--border)'}`,
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
                {cleanedName}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Merged past-sessions list ────────────────────────────────────────────────

interface MergedRow extends TranscriptSession {
  provider: AgentProvider;
}

interface MergedProps {
  heightPx: number;
  claudeSessions: TranscriptSession[];
  codexSessions: TranscriptSession[];
  claudeLoading: boolean;
  codexLoading: boolean;
  error: string | null;
  selectedKey: string | null;
  onPickRow: (s: TranscriptSession, provider: AgentProvider) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onPullAllClaude: () => void;
  claudeHasMoreOnServer: boolean;
}

function PastSessionsMerged({
  heightPx,
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
        height: heightPx,
        paddingTop: 10,
        borderTop: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 8,
          flexShrink: 0,
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

      <div style={{ marginBottom: 8, flexShrink: 0 }}>
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

      {/* Scrollable list. Fills remaining vertical space; loading/empty/error
          states render inside this same well so layout is always stable. */}
      <div
        className="mt-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight > el.scrollHeight - 80) triggerPull();
        }}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          backgroundColor: 'var(--bg-primary)',
        }}
      >
        {isLoading && merged.length === 0 && (
          <div
            style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              fontSize: 11.5,
              color: 'var(--text-muted)',
            }}
          >
            <Spinner size="sm" />
            <span style={{ opacity: 0.8 }}>Scanning history…</span>
          </div>
        )}
        {!isLoading && filtered.length === 0 && !error && (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '14px 16px',
              fontSize: 11.5,
              color: 'var(--text-muted)',
              textAlign: 'center',
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

        {!isLoading &&
          filtered.map((row, idx) => {
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
                  <span aria-hidden style={{ color: 'var(--text-faint)', opacity: 0.6 }}>
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
