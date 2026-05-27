import React, { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { PanelBottom, Pencil, Sparkles, Menu } from 'lucide-react';
import { AttachButton } from './AttachButton';
import { ModeBadge } from './ModeBadge';
import { ModelChip } from './chat/ModelChip';
import { UsageLimitBadge } from './UsageLimitBadge';
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
  const isMobile = useIsMobile();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(session.name);
  const [aiLoading, setAiLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const upsertSession = useAppStore((s) => s.upsertSession);

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
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {/* Row 1: menu + title + actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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

        {/* Row 2: model selection + behavior (mode/effort) controls. Moved off
            the composer toolbar on mobile to free up vertical space in the
            chatbox. Menus open downward since the header sits at the top.
            Left-aligned to the header edge — the title row leaves this space
            unused, so the chips fill it rather than indenting under the title. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
          }}
        >
          <ModelChip session={session} />
          <ModeBadge session={session} placement="bottom" />
          <UsageLimitBadge session={session} placement="bottom" />
        </div>
      </div>
    );
  }

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
          {/* Always-present usage-limits indicator (hidden when the provider
              has no live feed). Sits ahead of the action buttons so it's the
              first thing in the header's right cluster. */}
          <UsageLimitBadge session={session} placement="bottom" />
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

    </div>
  );
}
