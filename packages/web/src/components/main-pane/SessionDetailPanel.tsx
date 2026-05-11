import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, Folder, File, Plus, MessageSquare, Check, Copy, Sparkles, Trash2 } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../lib/api';
import { wsClient } from '../../lib/ws';
import { copyToClipboard } from '../../lib/clipboard';
import type { Session, Note } from '../../lib/types';
import { IconButton, Badge, Spinner } from '../ui';
import { TasksTab } from './chat/TasksTab';
import { GitPanel } from './git/GitPanel';

interface Props {
  session: Session;
  projectId: string;
}

type TabId = 'files' | 'diff' | 'cost' | 'prompts' | 'brainstorm' | 'tasks';

const TABS: { id: TabId; label: string }[] = [
  { id: 'files', label: 'Files' },
  { id: 'diff', label: 'Git' },
  { id: 'cost', label: 'Cost' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'brainstorm', label: 'Brainstorm' },
  { id: 'tasks', label: 'Tasks' },
];

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

function FilesTab({ projectId }: { projectId: string }) {
  const projects = useAppStore(s => s.projects);
  const projectPath = useMemo(() => {
    const p = projects.find(pr => pr.id === projectId);
    return p?.path ?? '';
  }, [projects, projectId]);

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FileEntry[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Track the last-copied entry path for transient feedback — keyed by the
  // entry's relative path, cleared after ~1.2s.
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors the App-level mobile breakpoint so we can flip the copy-path
  // button to the right edge on touch layouts.
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!projectId) {
      setLoading(false);
      setError('No project ID available');
      return;
    }
    setLoading(true);
    setError(null);
    api.projects
      .files(projectId)
      .then((result) => {
        setFiles(result);
        setLoading(false);
      })
      .catch((err) => {
        console.error('[FilesTab] Failed to load root files:', err);
        setError(err?.message || 'Failed to load files');
        setLoading(false);
      });
  }, [projectId]);

  const toggleFolder = async (path: string) => {
    if (expandedPaths.has(path)) {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    } else {
      try {
        const children = await api.projects.files(projectId, path);
        setExpanded((prev) => ({ ...prev, [path]: children }));
        setExpandedPaths((prev) => new Set(prev).add(path));
      } catch (err) {
        console.error('[FilesTab] Failed to expand folder:', path, err);
      }
    }
  };

  const copyEntryPath = async (entry: FileEntry, e: React.MouseEvent) => {
    // Prevent the click from bubbling to the row and triggering folder expand.
    e.stopPropagation();
    const abs = projectPath
      ? `${projectPath.replace(/\/$/, '')}/${entry.path}`
      : entry.path;
    const ok = await copyToClipboard(abs);
    if (!ok) return;
    setCopiedPath(entry.path);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopiedPath(null), 1200);
  };

  const handleRowClick = (entry: FileEntry) => {
    // Folders expand/collapse on click. Files do nothing — the only way to
    // interact with a file is the copy-path button.
    if (entry.type === 'directory') toggleFolder(entry.path);
  };

  const renderEntries = (entries: FileEntry[], depth: number) => (
    <>
      {entries.map((entry) => {
        const isCopied = copiedPath === entry.path;
        const isDir = entry.type === 'directory';
        const copyBtn = (
          <button
            type="button"
            onClick={(e) => copyEntryPath(entry, e)}
            title="Copy path"
            aria-label={`Copy path for ${entry.name}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              background: isCopied
                ? 'color-mix(in srgb, var(--accent-blue) 20%, transparent)'
                : 'transparent',
              border: '1px solid',
              borderColor: isCopied ? 'var(--accent-blue)' : 'var(--border)',
              color: isCopied ? 'var(--accent-blue)' : 'var(--text-muted)',
              padding: '2px 6px',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              fontSize: 11,
              flexShrink: 0,
              transition: 'background-color var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast)',
            }}
            onMouseEnter={(e) => {
              if (!isCopied) {
                (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)';
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--text-muted)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isCopied) {
                (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)';
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
              }
            }}
          >
            {isCopied ? <Check size={12} /> : <Copy size={12} />}
            {isCopied ? 'Copied' : 'Copy'}
          </button>
        );
        return (
          <React.Fragment key={entry.path}>
            <div
              onClick={() => handleRowClick(entry)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 8px',
                paddingLeft: 8 + depth * 16,
                cursor: isDir ? 'pointer' : 'default',
                userSelect: 'none',
                WebkitUserSelect: 'none',
                fontSize: 13,
                color: 'var(--text-primary)',
                borderRadius: 'var(--radius-sm)',
                transition: 'background-color var(--dur-fast) var(--ease-out)',
              }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--bg-hover)')
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent')
              }
            >
              {!isMobile && copyBtn}
              {isDir ? (
                <Folder size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              ) : (
                <File size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              )}
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {entry.name}
              </span>
              {isMobile && copyBtn}
            </div>
            {isDir &&
              expandedPaths.has(entry.path) &&
              expanded[entry.path] &&
              renderEntries(expanded[entry.path], depth + 1)}
          </React.Fragment>
        );
      })}
    </>
  );

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'var(--text-muted)', fontSize: 13, padding: 24, gap: 8 }}>
        <Spinner size="sm" /> Loading files...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 8, color: 'var(--text-muted)', padding: 24 }}>
        <Folder size={32} style={{ opacity: 0.4 }} />
        <span style={{ fontSize: 13, color: 'var(--status-error)' }}>{error}</span>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 8, color: 'var(--text-muted)', padding: 24 }}>
        <Folder size={32} style={{ opacity: 0.4 }} />
        <span style={{ fontSize: 13 }}>No files found</span>
      </div>
    );
  }

  return <div className="mt-scroll" style={{ padding: 8, overflowY: 'auto', flex: 1 }}>{renderEntries(files, 0)}</div>;
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

  // Codex SDK exposes only token counts — no USD field on Usage. Hiding the
  // big cost figure for codex sessions until/unless we wire a model-rate
  // lookup. Token usage and cache breakdown still render below.
  const showDollarCost = provider !== 'codex';

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
          {showDollarCost ? 'Total session cost' : 'Cost not tracked for Codex'}
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
          <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{provider === 'codex' ? 'Thread ID' : 'Session ID'}</span>
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

function PromptsTab({ session }: { session: Session }) {
  const [prompts, setPrompts] = useState<Array<{ text: string; timestamp: number | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  const fetchPrompts = () => {
    return api.sessions
      .prompts(session.id)
      .then((res) => {
        setPrompts(res.prompts);
      })
      .catch(() => {});
  };

  useEffect(() => {
    setLoading(true);
    fetchPrompts().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // Live-refresh whenever a new user prompt arrives. After the SDK migration
  // (Phase 4+) the user-prompt signal is `session:user-message`, emitted by
  // AgentSessionManager when sendTurn pushes the user's text. Refetch so we
  // pick up the full text from the JSONL/prompts endpoint.
  useEffect(() => {
    const off = wsClient.on('session:user-message', (msg: any) => {
      const pid = msg?.processId || msg?.payload?.processId;
      if (pid === session.id) {
        fetchPrompts();
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const filtered = useMemo(() => {
    if (!query.trim()) return prompts;
    const q = query.toLowerCase();
    return prompts.filter((p) => p.text.toLowerCase().includes(q));
  }, [prompts, query]);

  const formatTime = (ts: number | null, idx: number) => {
    if (ts) {
      const d = new Date(ts);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
    return `#${idx + 1}`;
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 8, color: 'var(--text-muted)', fontSize: 13, padding: 24 }}>
        <Spinner size="sm" /> Loading prompts...
      </div>
    );
  }

  if (prompts.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 8, color: 'var(--text-muted)', padding: 24 }}>
        <MessageSquare size={32} style={{ opacity: 0.4 }} />
        <span style={{ fontSize: 14, fontWeight: 500 }}>No prompts yet</span>
        <span style={{ fontSize: 12, textAlign: 'center' }}>
          User prompts in this session will appear here.
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Search + count */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          backgroundColor: 'var(--bg-primary)',
        }}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter prompts…"
          style={{
            flex: 1,
            fontSize: 12,
            padding: '4px 8px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            backgroundColor: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            outline: 'none',
          }}
        />
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
          {query.trim() ? `${filtered.length} / ${prompts.length}` : `${prompts.length} prompt${prompts.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {/* Prompt list */}
      <div className="mt-scroll" style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        {filtered.map((p, i) => {
          const idx = prompts.indexOf(p);
          return (
            <div
              key={idx}
              style={{
                padding: '8px 10px',
                marginBottom: 6,
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)',
                backgroundColor: 'var(--bg-elevated)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: 'var(--text-muted)',
                    fontVariantNumeric: 'tabular-nums',
                    backgroundColor: 'color-mix(in srgb, var(--bg-sidebar) 70%, transparent)',
                    padding: '2px 6px',
                    borderRadius: 'var(--radius-sm)',
                  }}
                >
                  {formatTime(p.timestamp, idx)}
                </span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {p.text.length.toLocaleString()} chars
                </span>
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--text-primary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  lineHeight: 1.45,
                }}
              >
                {p.text}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && query.trim() && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            No prompts match "{query}"
          </div>
        )}
      </div>
    </div>
  );
}

function NoteCard({
  note,
  onChange,
  onDelete,
  onRefine,
}: {
  note: Note;
  onChange: (patch: Partial<Pick<Note, 'title' | 'content' | 'scope'>>) => void;
  onDelete: () => void;
  onRefine: () => Promise<{ refined: string; original: string } | null>;
}) {
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<{ refined: string; original: string } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep local state in sync when the note object identity changes (e.g.
  // refresh after a scope toggle). Skip if user is mid-edit for the same id.
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

  const toggleScope = () => {
    const next: 'session' | 'project' = note.scope === 'session' ? 'project' : 'session';
    onChange({ scope: next });
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

  const isSession = note.scope === 'session';

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
      {/* Header: title + scope pill + actions */}
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
          placeholder="Untitled note"
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
        <button
          type="button"
          onClick={toggleScope}
          title={isSession ? 'Visible only in this session — click to share with project' : 'Visible in every session of this project — click to scope to this session'}
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            padding: '3px 8px',
            borderRadius: 'var(--radius-snug)',
            border: '1px solid',
            borderColor: isSession ? 'var(--border)' : 'var(--accent-blue)',
            color: isSession ? 'var(--text-muted)' : 'var(--accent-blue)',
            backgroundColor: isSession
              ? 'transparent'
              : 'color-mix(in srgb, var(--accent-blue) 12%, transparent)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {isSession ? 'Session' : 'Project'}
        </button>
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
        placeholder="Jot down an idea…"
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

function BrainstormTab({ session }: { session: Session }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'session' | 'project'>('all');

  const load = () => {
    return api.notes
      .listForSession(session.id, session.projectId)
      .then((res) => setNotes(res.notes))
      .catch(() => {});
  };

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.projectId]);

  const addNote = async (scope: 'session' | 'project') => {
    const note = await api.notes.create({
      projectId: session.projectId,
      sessionId: scope === 'session' ? session.id : null,
      scope,
      title: '',
      content: '',
    });
    setNotes((prev) => [note, ...prev]);
  };

  const updateNote = async (id: string, patch: Partial<Pick<Note, 'title' | 'content' | 'scope'>>) => {
    // When flipping scope to 'project', the API clears session_id; flipping
    // back to 'session' needs the current session id.
    const payload: any = { ...patch };
    if (patch.scope === 'session') payload.sessionId = session.id;
    if (patch.scope === 'project') payload.sessionId = null;

    const updated = await api.notes.update(id, payload);
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

  const filtered = useMemo(() => {
    if (filter === 'all') return notes;
    return notes.filter((n) => n.scope === filter);
  }, [notes, filter]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 8, color: 'var(--text-muted)', fontSize: 13, padding: 24 }}>
        <Spinner size="sm" /> Loading notes…
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
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: 2, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
          {(['all', 'session', 'project'] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              style={{
                fontSize: 11,
                padding: '4px 10px',
                textTransform: 'capitalize',
                background: filter === id ? 'var(--accent-blue)' : 'transparent',
                color: filter === id ? 'white' : 'var(--text-secondary)',
                border: 'none',
                cursor: 'pointer',
                fontWeight: filter === id ? 600 : 500,
              }}
            >
              {id}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => addNote('session')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            padding: '4px 10px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border)',
            backgroundColor: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          <Plus size={12} /> Session note
        </button>
        <button
          type="button"
          onClick={() => addNote('project')}
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
          <Plus size={12} /> Project note
        </button>
      </div>

      {/* Notes list */}
      <div className="mt-scroll" style={{ flex: 1, overflow: 'auto', padding: 10 }}>
        {filtered.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 40, gap: 8, color: 'var(--text-muted)' }}>
            <MessageSquare size={32} style={{ opacity: 0.4 }} />
            <span style={{ fontSize: 14, fontWeight: 500 }}>No notes yet</span>
            <span style={{ fontSize: 12, textAlign: 'center', maxWidth: 280 }}>
              Capture ideas as you think of them. Click "AI refine" on any note to rewrite it as a clear prompt.
            </span>
          </div>
        ) : (
          filtered.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              onChange={(patch) => updateNote(note.id, patch)}
              onDelete={() => deleteNote(note.id)}
              onRefine={() => refineNote(note.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

export function SessionDetailPanel({ session, projectId }: Props) {
  const { detailPanelTab, setDetailPanelTab, setDetailPanelOpen } = useAppStore();

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        height: '100%',
      }}
    >
      {/* Tab bar */}
      <div
        style={{
          height: 38,
          display: 'flex',
          alignItems: 'center',
          backgroundColor: 'var(--bg-sidebar)',
          borderTop: '1px solid var(--border)',
          flexShrink: 0,
          paddingLeft: 8,
          paddingRight: 6,
          position: 'relative',
        }}
      >
        {TABS.map((tab) => {
          const active = detailPanelTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setDetailPanelTab(tab.id)}
              style={{
                position: 'relative',
                background: 'none',
                border: 'none',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                padding: '0 14px',
                height: '100%',
                cursor: 'pointer',
                transition: 'color var(--dur-fast) var(--ease-out)',
              }}
              onMouseEnter={(e) => {
                if (!active) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)';
              }}
              onMouseLeave={(e) => {
                if (!active) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)';
              }}
            >
              {tab.label}
              <span
                style={{
                  position: 'absolute',
                  left: 12,
                  right: 12,
                  bottom: 0,
                  height: 2,
                  backgroundColor: 'var(--accent-blue)',
                  borderRadius: 'var(--radius-snug) var(--radius-snug) 0 0',
                  transform: active ? 'scaleX(1)' : 'scaleX(0)',
                  transformOrigin: 'center',
                  transition: 'transform var(--dur-med) var(--ease-out)',
                }}
              />
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <IconButton size="sm" onClick={() => setDetailPanelOpen(false)} label="Close detail panel">
          <X size={13} />
        </IconButton>
      </div>

      {/* Content */}
      <div className="mt-scroll" style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        {detailPanelTab === 'files' && <FilesTab projectId={projectId} />}
        {detailPanelTab === 'diff' && (
          <GitPanel projectId={projectId} sessionId={session.id} />
        )}
        {detailPanelTab === 'cost' && <CostTab session={session} />}
        {detailPanelTab === 'prompts' && <PromptsTab session={session} />}
        {detailPanelTab === 'brainstorm' && <BrainstormTab session={session} />}
        {detailPanelTab === 'tasks' && <TasksTab sessionId={session.id} />}
      </div>
    </div>
  );
}
