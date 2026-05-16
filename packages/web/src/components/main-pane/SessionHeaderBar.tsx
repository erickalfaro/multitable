import React, { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { PanelBottom, Copy, Check, Pencil, Sparkles, Menu } from 'lucide-react';
import { AttachButton } from './AttachButton';
import type { Session } from '../../lib/types';
import { IconButton, Spinner } from '../ui';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';
import { useIsMobile } from '../../lib/useIsMobile';

interface Props {
  session: Session;
  onToggleDetailPanel: () => void;
  /** Mobile only — small contextual project label rendered above the session name. */
  projectName?: string;
  /** Mobile only — when provided, renders a hamburger that opens the drawer. */
  onOpenDrawer?: () => void;
}

export function SessionHeaderBar({ session, onToggleDetailPanel, projectName, onOpenDrawer }: Props) {
  const claudeState = session.claudeState;
  const isMobile = useIsMobile();
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(session.name);
  const [aiLoading, setAiLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const upsertSession = useAppStore((s) => s.upsertSession);
  const provider = session.agentProvider;
  const agentSessionId = session.agentSessionId ?? claudeState?.agentSessionId ?? null;

  const buildResumeCommand = (id: string): string => {
    if (provider === 'claude') return `claude --resume ${id}`;
    if (provider === 'codex') return `codex resume ${id}`;
    if (provider === 'hermes') return `hermes acp  # session ${id}`;
    return id;
  };
  const resumeCommand = agentSessionId ? buildResumeCommand(agentSessionId) : null;

  useEffect(() => {
    if (editing) {
      setDraftName(session.name);
      // Defer to next frame so the input is mounted before focusing.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, session.name]);

  // If a server-side rename arrives while not editing, keep draft in sync so
  // the next edit starts from the latest value.
  useEffect(() => {
    if (!editing) setDraftName(session.name);
  }, [session.name, editing]);

  const commitRename = async () => {
    const next = draftName.trim();
    if (!next || next === session.name) {
      setEditing(false);
      setDraftName(session.name);
      return;
    }
    setEditing(false);
    try {
      const updated = await api.sessions.update(session.id, { name: next });
      upsertSession({ ...session, ...updated });
    } catch {
      toast.error('Failed to rename session');
      setDraftName(session.name);
    }
  };

  const cancelRename = () => {
    setEditing(false);
    setDraftName(session.name);
  };

  const handleAiRename = async () => {
    if (aiLoading) return;
    setAiLoading(true);
    try {
      const result = await api.sessions.renameAi(session.id);
      upsertSession({ ...session, ...result.session });
      toast.success(`Renamed to "${result.name}"`, { duration: 2200 });
      setEditing(false);
    } catch (err: any) {
      const msg = err?.message || 'AI rename failed';
      toast.error(`AI rename: ${msg}`, { duration: 5000, style: { maxWidth: 480 } });
    } finally {
      setAiLoading(false);
    }
  };

  const handleCopySessionId = async () => {
    if (!resumeCommand) return;
    const showCopied = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
      toast.success('Copied resume command', { duration: 1400 });
    };
    try {
      await navigator.clipboard.writeText(resumeCommand);
      showCopied();
      return;
    } catch {
      // Fall through to legacy copy below.
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = resumeCommand;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showCopied();
    } catch {
      toast.error('Failed to copy resume command');
    }
  };

  const formatTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return n.toLocaleString();
  };

  const formatCost = (n: number): string => {
    if (n >= 1) return `$${n.toFixed(2)}`;
    if (n >= 0.01) return `$${n.toFixed(3)}`;
    if (n > 0) return `$${n.toFixed(4)}`;
    return '$0.00';
  };

  const costUsd = claudeState?.costUsd ?? 0;
  const tokenCount = claudeState?.tokenCount ?? 0;

  if (isMobile) {
    return (
      <div
        style={{
          backgroundColor: 'var(--bg-sidebar)',
          borderBottom: '1px solid var(--border)',
          padding: '6px 10px 8px',
          boxSizing: 'border-box',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {onOpenDrawer && (
          <IconButton size="lg" onClick={onOpenDrawer} label="Open menu">
            <Menu size={20} />
          </IconButton>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: 2 }}>
          {projectName && (
            <span
              title={projectName}
              style={{
                fontSize: 9.5,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.18em',
                fontWeight: 500,
                lineHeight: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {projectName}
            </span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {editing ? (
              <input
                ref={inputRef}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                maxLength={120}
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 16,
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--accent-amber)',
                  borderRadius: 'var(--radius-snug)',
                  padding: '2px 8px',
                  outline: 'none',
                  lineHeight: 1.25,
                  fontFamily: 'inherit',
                }}
              />
            ) : (
              <span
                onClick={() => setEditing(true)}
                title="Tap to rename"
                style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  lineHeight: 1.25,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  cursor: 'text',
                  userSelect: 'text',
                  WebkitUserSelect: 'text',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {session.name}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {editing ? (
            <IconButton
              size="lg"
              // Trigger on mousedown so the input's onBlur (commitRename) doesn't
              // run first and unmount the AI button before the click registers.
              // preventDefault keeps focus in the input.
              onMouseDown={(e) => {
                e.preventDefault();
                handleAiRename();
              }}
              label="Rename with AI"
              disabled={aiLoading}
            >
              {aiLoading ? <Spinner size="sm" /> : <Sparkles size={16} />}
            </IconButton>
          ) : (
            <IconButton size="lg" onClick={() => setEditing(true)} label="Rename session">
              <Pencil size={16} />
            </IconButton>
          )}
          <IconButton size="lg" onClick={onToggleDetailPanel} label="Toggle detail panel">
            <PanelBottom size={16} />
          </IconButton>
        </div>
      </div>
    );
  }

  const chipStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '1px 8px',
    height: 18,
    fontSize: 10.5,
    fontFamily: 'inherit',
    color: 'var(--text-secondary)',
    backgroundColor: 'transparent',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-snug)',
    lineHeight: 1,
    letterSpacing: '0.04em',
  };

  return (
    <div
      style={{
        minHeight: 42,
        backgroundColor: 'var(--bg-sidebar)',
        borderBottom: '1px solid var(--border)',
        padding: '6px 14px',
        boxSizing: 'border-box',
        flexShrink: 0,
      }}
    >
      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0, flex: 1 }}>
          {editing ? (
            <input
              ref={inputRef}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              maxLength={120}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 13.5,
                fontWeight: 500,
                color: 'var(--text-primary)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--accent-amber)',
                borderRadius: 'var(--radius-snug)',
                padding: '2px 8px',
                outline: 'none',
                lineHeight: 1.3,
                fontFamily: 'inherit',
              }}
            />
          ) : (
            <span
              onDoubleClick={() => setEditing(true)}
              title="Double-click to rename"
              style={{
                fontSize: 13.5,
                color: 'var(--text-primary)',
                fontWeight: 500,
                lineHeight: 1.3,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
                cursor: 'text',
                userSelect: 'text',
                WebkitUserSelect: 'text',
              }}
            >
              {session.name}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, userSelect: 'none', WebkitUserSelect: 'none' }}>
          <IconButton
            size="sm"
            // mousedown + preventDefault so a click while editing doesn't blur
            // the input first (which would commit and unmount this button).
            onMouseDown={(e) => {
              e.preventDefault();
              handleAiRename();
            }}
            label="Rename with AI"
            disabled={aiLoading}
          >
            {aiLoading ? <Spinner size="sm" /> : <Sparkles size={14} />}
          </IconButton>
          <IconButton
            size="sm"
            onClick={() => setEditing(true)}
            label="Rename session"
          >
            <Pencil size={13} />
          </IconButton>
          <AttachButton processId={session.id} kind="session" />
          <IconButton size="sm" onClick={onToggleDetailPanel} label="Toggle detail panel">
            <PanelBottom size={14} />
          </IconButton>
        </div>
      </div>

      {/* Bottom row — chips */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
        {agentSessionId && (
          <button
            type="button"
            onClick={handleCopySessionId}
            title={resumeCommand ? `Click to copy: ${resumeCommand}` : 'Copy session id'}
            style={{
              ...chipStyle,
              cursor: 'pointer',
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              fontFamily: 'inherit',
              transition: 'border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent-amber)';
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-strong)';
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)';
            }}
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {agentSessionId}
            </span>
          </button>
        )}
        {session.capabilities?.costUsd !== false && costUsd > 0 && (
          <span style={chipStyle}>{formatCost(costUsd)}</span>
        )}
        {tokenCount > 0 && (
          <span style={chipStyle}>{formatTokens(tokenCount)} tokens</span>
        )}
      </div>
    </div>
  );
}
