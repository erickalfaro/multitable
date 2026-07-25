import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  ArrowLeft,
  Plus,
  MessageSquare,
  Check,
  Copy,
  Sparkles,
  Trash2,
  CornerUpLeft,
} from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import type { DetailPanelTab } from '../../stores/appStore';
import { emphasisFill } from '../../lib/emphasis';
import { api } from '../../lib/api';
import { wsClient } from '../../lib/ws';
import { copyToClipboard } from '../../lib/clipboard';
import { relativeTime } from '../../lib/relativeTime';
import type { Session, Note, PermissionPrompt } from '../../lib/types';
import { IconButton, Spinner } from '../ui';
import { ActivityTab } from './context/ActivityTab';
import { InfoTab } from './context/InfoTab';
import { AskQuestionCard } from '../command-console/shared/AskQuestionCard';
import { PermissionCard } from '../command-console/shared/PermissionCard';

interface Props {
  session: Session;
  /** Mobile only — renders a back button in the tab bar that calls onClose. */
  isMobile?: boolean;
  /** Invoked by the mobile back button to dismiss the full-screen panel. */
  onClose?: () => void;
}

const TABS: { id: DetailPanelTab; label: string }[] = [
  { id: 'ask', label: 'Ask' },
  { id: 'activity', label: 'Activity' },
  { id: 'cost', label: 'Cost' },
  { id: 'notes', label: 'Notes' },
  { id: 'info', label: 'Info' },
];

// True when a keystroke is being typed into an editable surface — the numeric /
// Escape shortcuts in AskTab must not hijack the composer.
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable ||
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    !!el.closest?.('.cm-editor')
  );
}

// The unified "agent needs your input" tab: blocking permission / AskUserQuestion
// prompts (pendingPermissions) and post-turn detected numbered-list options
// (optionsBySession), rendered through the same shared cards. Detected options
// resolve by sending a new turn (they have no blocking tool call), injected via
// AskQuestionCard's onSubmit/onSkip overrides.
function AskTab({ session }: { session: Session }) {
  const sessionId = session.id;
  const pendingPermissions = useAppStore((s) => s.pendingPermissions);
  const optionsBySession = useAppStore((s) => s.optionsBySession);
  const clearSessionOptions = useAppStore((s) => s.clearSessionOptions);

  const filtered = pendingPermissions.filter((p) => p.sessionId === sessionId);
  const detected = optionsBySession[sessionId] ?? null;

  const chooseDetected = (text: string | undefined) => {
    if (text) wsClient.sendTurn(sessionId, text);
    clearSessionOptions(sessionId);
    wsClient.dismissOption(sessionId); // drop server-side so it doesn't re-hydrate
  };
  const skipDetected = () => {
    clearSessionOptions(sessionId);
    wsClient.dismissOption(sessionId);
  };

  // Keyboard fast-path for detected options (1–N pick, Esc dismiss) when they're
  // the only pending item — ambiguity-free against a blocking question.
  useEffect(() => {
    if (!detected || filtered.length > 0) return;
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === 'Escape') {
        skipDetected();
        return;
      }
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= detected.options.length) chooseDetected(detected.options[n - 1]);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detected, filtered.length, sessionId]);

  // Adapt the flat detected OptionPrompt into the shared card's shape: one
  // single-select question, options as bare labels.
  const detectedPrompt: PermissionPrompt | null = detected
    ? {
        id: `detected:${sessionId}`,
        sessionId,
        claudeSessionId: '',
        toolName: 'DetectedOptions',
        toolInput: {},
        createdAt: 0,
        kind: 'ask-question',
        questions: [
          {
            question: detected.question,
            multiSelect: false,
            options: detected.options.map((o) => ({ label: o })),
          },
        ],
      }
    : null;

  const isEmpty = filtered.length === 0 && !detectedPrompt;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div className="mt-scroll" style={{ flex: 1, overflow: 'auto', padding: 10 }}>
        {isEmpty ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 40,
              gap: 8,
              color: 'var(--text-muted)',
            }}
          >
            <MessageSquare size={32} style={{ opacity: 0.4 }} />
            <span style={{ fontSize: 14, fontWeight: 500 }}>No pending questions</span>
            <span style={{ fontSize: 12, textAlign: 'center', maxWidth: 280 }}>
              When the agent asks you to approve an action or pick an option, it shows up here.
            </span>
          </div>
        ) : (
          <>
            {filtered.map((prompt) =>
              prompt.kind === 'ask-question' ? (
                <AskQuestionCard key={prompt.id} prompt={prompt} />
              ) : (
                <PermissionCard key={prompt.id} prompt={prompt} />
              ),
            )}
            {detectedPrompt && (
              <AskQuestionCard
                key={detectedPrompt.id}
                prompt={detectedPrompt}
                onSubmit={(sel) => chooseDetected(sel[0]?.[0])}
                onSkip={skipDetected}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CostTab({ session }: { session: Session }) {
  const [costData, setCostData] = useState<{
    tokensIn: number;
    tokensOut: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    costUsd: number;
    model: string;
    messageCount: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState(false);

  const provider = session.agentProvider;
  const agentSessionId = session.agentSessionId ?? session.claudeState?.agentSessionId ?? null;
  const handleCopyId = () => {
    if (!agentSessionId) return;
    copyToClipboard(agentSessionId);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 1200);
  };

  useEffect(() => {
    setLoading(true);
    api.sessions
      .cost(session.id)
      .then(setCostData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [session.id]);

  // Refresh when claudeState updates (turn ends)
  const stateTokenCount = session.claudeState?.tokenCount ?? 0;
  useEffect(() => {
    if (stateTokenCount > 0) {
      api.sessions.cost(session.id).then(setCostData).catch(() => {});
    }
  }, [stateTokenCount, session.id]);

  const tokensIn = costData?.tokensIn ?? 0;
  const tokensOut = costData?.tokensOut ?? 0;
  const cacheCreation = costData?.cacheCreationTokens ?? 0;
  const cacheRead = costData?.cacheReadTokens ?? 0;
  const costUsd = costData?.costUsd ?? 0;
  const model = costData?.model ?? '';
  const messageCount = costData?.messageCount ?? 0;
  const totalTokens = tokensIn + tokensOut + cacheCreation + cacheRead;

  const formatTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return n.toLocaleString();
  };

  const formatCost = (n: number): string => {
    if (n >= 1) return `$${n.toFixed(2)}`;
    if (n >= 0.01) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(4)}`;
  };

  if (loading) {
    return (
      <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>
        Loading cost data...
      </div>
    );
  }

  if (totalTokens === 0) {
    return (
      <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>
        No cost data available yet. Cost tracking begins after the first agent response.
      </div>
    );
  }

  // Codex and Hermes expose only token counts — no USD field on Usage. Hiding
  // the big cost figure for these providers until/unless we wire a model-rate
  // lookup. Token usage and cache breakdown still render below.
  const showDollarCost = provider !== 'codex' && provider !== 'hermes' && provider !== 'grok';

  return (
    <div style={{ padding: 16 }}>
      {/* Big cost display */}
      <div style={{
        backgroundColor: 'var(--bg-hover)',
        borderRadius: 'var(--radius-soft)',
        padding: '12px 16px',
        marginBottom: 16,
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 24, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
          {showDollarCost ? formatCost(costUsd) : '—'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
          {showDollarCost
            ? 'Total session cost'
            : provider === 'hermes'
              ? 'Cost not tracked for Hermes'
              : provider === 'grok'
                ? 'Cost not tracked for Grok Build'
                : 'Cost not tracked for Codex'}
        </div>
      </div>

      {/* Token breakdown */}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, fontWeight: 500 }}>
        Token Usage
      </div>
      {[
        { label: 'Input tokens', value: formatTokens(tokensIn), raw: tokensIn },
        { label: 'Output tokens', value: formatTokens(tokensOut), raw: tokensOut },
        { label: 'Cache write', value: formatTokens(cacheCreation), raw: cacheCreation },
        { label: 'Cache read', value: formatTokens(cacheRead), raw: cacheRead },
      ]
        .filter((r) => r.raw > 0)
        .map((row) => (
          <div
            key={row.label}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '5px 0',
              fontSize: 13,
              borderBottom: '1px solid var(--border)',
            }}
          >
            <span style={{ color: 'var(--text-secondary)' }}>{row.label}</span>
            <span style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{row.value}</span>
          </div>
        ))}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          padding: '5px 0',
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        <span style={{ color: 'var(--text-primary)' }}>Total</span>
        <span style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{formatTokens(totalTokens)}</span>
      </div>

      {/* Session info */}
      <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, fontWeight: 500 }}>
        Details
      </div>
      {[
        { label: 'Model', value: model || 'Unknown' },
        { label: 'API calls', value: messageCount.toLocaleString() },
      ].map((row) => (
        <div
          key={row.label}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '5px 0',
            fontSize: 13,
          }}
        >
          <span style={{ color: 'var(--text-secondary)' }}>{row.label}</span>
          <span style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>{row.value}</span>
        </div>
      ))}
      {agentSessionId && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            padding: '5px 0',
            fontSize: 13,
          }}
        >
          <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>
            {provider === 'codex'
              ? 'Thread ID'
              : provider === 'hermes'
                ? 'Hermes session ID'
                : provider === 'grok'
                  ? 'Grok session ID'
                  : 'Session ID'}
          </span>
          <button
            onClick={handleCopyId}
            title={copiedId ? 'Copied' : 'Click to copy'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              maxWidth: '100%',
              padding: 0,
              background: 'transparent',
              border: 'none',
              color: 'var(--text-primary)',
              fontFamily: 'monospace',
              fontSize: 12,
              cursor: 'pointer',
              overflow: 'hidden',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {agentSessionId}
            </span>
            {copiedId ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      )}
    </div>
  );
}

function NoteCard({
  note,
  onChange,
  onDelete,
  onRefine,
  onLoadIntoComposer,
}: {
  note: Note;
  onChange: (patch: Partial<Pick<Note, 'title' | 'content'>>) => void;
  onDelete: () => void;
  onRefine: () => Promise<{ refined: string; original: string } | null>;
  onLoadIntoComposer: () => void;
}) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<{ refined: string; original: string } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep local state in sync when the note object identity changes (e.g.
  // refresh after a save elsewhere). Skip if user is mid-edit for the same id.
  useEffect(() => {
    setTitle(note.title);
    setContent(note.content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id, note.updatedAt]);

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  const scheduleSave = (patch: Partial<Pick<Note, 'title' | 'content'>>) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      onChange(patch);
    }, 500);
  };

  const handleTitle = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value);
    scheduleSave({ title: e.target.value });
  };

  const handleContent = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    scheduleSave({ content: e.target.value });
  };

  const handleRefine = async () => {
    setRefining(true);
    setRefineError(null);
    try {
      // Flush any pending save so the refine sees current content.
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        onChange({ title, content });
      }
      const result = await onRefine();
      if (result) setSuggestion(result);
      else setRefineError('Refine failed — try again?');
    } catch (err: any) {
      setRefineError(err?.message || 'Refine failed');
    } finally {
      setRefining(false);
    }
  };

  const acceptSuggestion = () => {
    if (!suggestion) return;
    setContent(suggestion.refined);
    onChange({ content: suggestion.refined });
    setSuggestion(null);
  };

  const rejectSuggestion = () => setSuggestion(null);

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        backgroundColor: 'var(--bg-elevated)',
        marginBottom: 10,
        overflow: 'hidden',
      }}
    >
      {/* Header: title + timestamp + actions */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          borderBottom: '1px solid var(--border)',
          backgroundColor: 'color-mix(in srgb, var(--bg-sidebar) 40%, transparent)',
        }}
      >
        <input
          value={title}
          onChange={handleTitle}
          placeholder="Untitled prompt"
          style={{
            flex: 1,
            minWidth: 0,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        />
        <span
          title={new Date(note.updatedAt).toLocaleString()}
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {relativeTime(note.updatedAt)}
        </span>
        <button
          type="button"
          onClick={handleRefine}
          disabled={refining || !content.trim()}
          title="Rewrite this note as a refined prompt using AI"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            padding: '3px 8px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--accent-blue)',
            color: refining || !content.trim() ? 'var(--text-muted)' : 'var(--accent-blue)',
            backgroundColor: refining
              ? 'color-mix(in srgb, var(--accent-blue) 15%, transparent)'
              : 'transparent',
            cursor: refining || !content.trim() ? 'default' : 'pointer',
            opacity: refining || !content.trim() ? 0.6 : 1,
            flexShrink: 0,
          }}
        >
          <Sparkles size={12} />
          {refining ? 'Refining…' : 'AI refine'}
        </button>
        <button
          type="button"
          onClick={onLoadIntoComposer}
          disabled={!content.trim()}
          title="Load this prompt into the composer to edit and send"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            padding: '3px 8px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border)',
            color: !content.trim() ? 'var(--text-muted)' : 'var(--text-secondary)',
            backgroundColor: 'transparent',
            cursor: !content.trim() ? 'default' : 'pointer',
            opacity: !content.trim() ? 0.6 : 1,
            flexShrink: 0,
          }}
        >
          <CornerUpLeft size={12} />
          Load
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Delete this note"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            background: 'transparent',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            padding: 4,
            flexShrink: 0,
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Body: content */}
      <textarea
        value={content}
        onChange={handleContent}
        placeholder="Write a prompt…"
        rows={Math.max(3, Math.min(14, content.split('\n').length + 1))}
        style={{
          width: '100%',
          resize: 'vertical',
          minHeight: 60,
          padding: 10,
          fontSize: 13,
          fontFamily: 'inherit',
          backgroundColor: 'transparent',
          color: 'var(--text-primary)',
          border: 'none',
          outline: 'none',
          boxSizing: 'border-box',
          lineHeight: 1.5,
        }}
      />

      {/* Refine error */}
      {refineError && (
        <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--status-error)', borderTop: '1px solid var(--border)' }}>
          {refineError}
        </div>
      )}

      {/* Refine suggestion preview */}
      {suggestion && (
        <div style={{ borderTop: '1px solid var(--border)', padding: 10, backgroundColor: 'color-mix(in srgb, var(--accent-blue) 8%, transparent)' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--accent-blue)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Sparkles size={11} /> Refined version
          </div>
          <pre
            className="mt-scroll"
            style={{
              fontSize: 12,
              color: 'var(--text-primary)',
              margin: 0,
              padding: 8,
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 200,
              overflow: 'auto',
            }}
          >
            {suggestion.refined}
          </pre>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button
              type="button"
              onClick={acceptSuggestion}
              style={{
                fontSize: 10.5,
                padding: '3px 10px',
                borderRadius: 'var(--radius-snug)',
                backgroundColor: 'transparent',
                color: 'var(--accent-amber)',
                border: '1px solid var(--accent-amber)',
                cursor: 'pointer',
                fontWeight: 500,
                fontFamily: 'inherit',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Replace note
            </button>
            <button
              type="button"
              onClick={rejectSuggestion}
              style={{
                fontSize: 11,
                padding: '4px 10px',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'transparent',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border)',
                cursor: 'pointer',
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PromptBuilderTab({ session }: { session: Session }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  // Bumped when a note is created outside this tab (e.g. the composer's Save
  // button) so we refetch and surface it.
  const notesVersion = useAppStore((s) => s.notesVersionByProject[session.projectId] ?? 0);
  const requestComposerRecall = useAppStore((s) => s.requestComposerRecall);

  const load = () => {
    return api.notes
      .listForProject(session.projectId)
      .then((res) => setNotes(res.notes))
      .catch(() => {});
  };

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.projectId, notesVersion]);

  const addNote = async () => {
    const note = await api.notes.create({
      projectId: session.projectId,
      scope: 'project',
      title: '',
      content: '',
    });
    setNotes((prev) => [note, ...prev]);
  };

  const updateNote = async (id: string, patch: Partial<Pick<Note, 'title' | 'content'>>) => {
    const updated = await api.notes.update(id, patch);
    setNotes((prev) => prev.map((n) => (n.id === id ? updated : n)));
  };

  const deleteNote = async (id: string) => {
    await api.notes.delete(id);
    setNotes((prev) => prev.filter((n) => n.id !== id));
  };

  const refineNote = async (id: string) => {
    try {
      return await api.notes.refine(id);
    } catch {
      return null;
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 8, color: 'var(--text-muted)', fontSize: 13, padding: 24 }}>
        <Spinner size="sm" /> Loading prompts…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 10px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          backgroundColor: 'var(--bg-primary)',
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
          Saved prompts
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={addNote}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            padding: '4px 10px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--accent-blue)',
            backgroundColor: 'color-mix(in srgb, var(--accent-blue) 10%, transparent)',
            color: 'var(--accent-blue)',
            cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          <Plus size={12} /> New prompt
        </button>
      </div>

      {/* Prompt list */}
      <div className="mt-scroll" style={{ flex: 1, overflow: 'auto', padding: 10 }}>
        {notes.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 40, gap: 8, color: 'var(--text-muted)' }}>
            <MessageSquare size={32} style={{ opacity: 0.4 }} />
            <span style={{ fontSize: 14, fontWeight: 500 }}>No saved prompts yet</span>
            <span style={{ fontSize: 12, textAlign: 'center', maxWidth: 280 }}>
              Save a draft from the composer, or click "New prompt". Load any prompt back into the composer to edit and send.
            </span>
          </div>
        ) : (
          notes.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              onChange={(patch) => updateNote(note.id, patch)}
              onDelete={() => deleteNote(note.id)}
              onRefine={() => refineNote(note.id)}
              onLoadIntoComposer={() => requestComposerRecall(session.id, note.content, note.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

export function SessionDetailPanel({ session, isMobile, onClose }: Props) {
  const detailPanelTab = useAppStore((s) => s.detailPanelTab);
  const setDetailPanelTab = useAppStore((s) => s.setDetailPanelTab);
  const setDetailPanelOpen = useAppStore((s) => s.setDetailPanelOpen);
  // Badge count for the Ask tab: blocking prompts + a detected-options set.
  const askCount = useAppStore(
    (s) =>
      s.pendingPermissions.filter((p) => p.sessionId === session.id).length +
      (s.optionsBySession[session.id] ? 1 : 0),
  );

  // Migrate any legacy detailPanelTab values to the new id set so existing
  // sessions (in-memory store state from before the rename) don't render an
  // empty tab body. Runs once per mount and is a no-op for fresh stores.
  useEffect(() => {
    const tab = detailPanelTab as string;
    if (tab === 'tasks' || tab === 'files' || tab === 'prompts' || tab === 'diff')
      setDetailPanelTab('activity');
    else if (tab === 'prompt-builder' || tab === 'brainstorm') setDetailPanelTab('notes');
  }, [detailPanelTab, setDetailPanelTab]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        height: '100%',
        borderLeft: isMobile ? 'none' : '1px solid var(--border)',
        backgroundColor: 'var(--bg-primary)',
      }}
    >
      {/* Tab bar */}
      <div
        style={{
          height: isMobile ? 44 : 32,
          display: 'flex',
          alignItems: 'center',
          backgroundColor: 'var(--bg-sidebar)',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          paddingLeft: 4,
          paddingRight: 6,
          position: 'relative',
          overflowX: 'auto',
        }}
        className="mt-scroll"
      >
        {isMobile && (
          <IconButton size="md" onClick={() => onClose?.()} label="Back to chat">
            <ArrowLeft size={18} />
          </IconButton>
        )}
        {TABS.map((tab) => {
          const active = detailPanelTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setDetailPanelTab(tab.id)}
              className="mt-toolbar-button"
              style={{
                position: 'relative',
                border: 'none',
                borderRadius: 'var(--radius-pill)',
                // Active tab = filled glass pill (segmented-control style);
                // the background transition replaces the old underline motion.
                ...(active
                  ? emphasisFill('var(--accent-amber)', { fill: 12, ring: 40 })
                  : { background: 'transparent' }),
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: isMobile ? 13 : 11.5,
                fontWeight: active ? 600 : 500,
                padding: isMobile ? '0 14px' : '0 10px',
                height: isMobile ? 30 : 22,
                alignSelf: 'center',
                margin: '0 2px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition:
                  'color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out)',
              }}
            >
              {tab.label}
              {tab.id === 'ask' && askCount > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: isMobile ? 2 : 0,
                    right: isMobile ? 4 : 2,
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    backgroundColor: 'var(--accent-amber)',
                  }}
                />
              )}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        {!isMobile && (
          <IconButton size="sm" onClick={() => setDetailPanelOpen(false)} label="Close panel (Cmd+.)">
            <X size={13} />
          </IconButton>
        )}
      </div>

      {/* Tab content — each tab manages its own scroll. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {detailPanelTab === 'ask' && <AskTab session={session} />}
        {detailPanelTab === 'activity' && <ActivityTab sessionId={session.id} />}
        {detailPanelTab === 'cost' && (
          <div className="mt-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <CostTab session={session} />
          </div>
        )}
        {detailPanelTab === 'notes' && <PromptBuilderTab session={session} />}
        {detailPanelTab === 'info' && <InfoTab session={session} />}
      </div>
    </div>
  );
}
