import React, { useMemo, useState } from 'react';
import {
  Eye,
  Pencil,
  Terminal as TerminalIcon,
  Search as SearchIcon,
  Plug,
  Brain,
  ChevronRight,
} from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import type { AttentionEvent, AttentionKind } from '../../../stores/appStore';
import type { AgentProvider } from '../../../lib/types';

interface Props {
  sessionId: string;
}

const FILTERS: { kind: AttentionKind; label: string }[] = [
  { kind: 'edit', label: 'Edits' },
  { kind: 'read', label: 'Reads' },
  { kind: 'command', label: 'Cmd' },
  { kind: 'search', label: 'Search' },
  { kind: 'mcp', label: 'MCP' },
  { kind: 'reasoning', label: 'Reasoning' },
];

function kindIcon(kind: AttentionKind, size = 12) {
  switch (kind) {
    case 'read':
      return <Eye size={size} />;
    case 'edit':
      return <Pencil size={size} />;
    case 'command':
      return <TerminalIcon size={size} />;
    case 'search':
      return <SearchIcon size={size} />;
    case 'mcp':
      return <Plug size={size} />;
    case 'reasoning':
      return <Brain size={size} />;
  }
}

function providerStripe(provider: AgentProvider): string {
  switch (provider) {
    case 'claude':
      return 'var(--accent-amber)';
    case 'codex':
      return 'var(--node-fs-read)';
    case 'copilot':
      return 'var(--node-subagent)';
    default:
      return 'var(--text-muted)';
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

const EMPTY_EVENTS: AttentionEvent[] = [];
const EMPTY_FILTERS: AttentionKind[] = [];

export function AttentionStream({ sessionId }: Props) {
  const events = useAppStore((s) => s.attentionBySession[sessionId] ?? EMPTY_EVENTS);
  const filters = useAppStore((s) => s.attentionFilters[sessionId] ?? EMPTY_FILTERS);
  const toggleFilter = useAppStore((s) => s.toggleAttentionFilter);
  const clearAttention = useAppStore((s) => s.clearAttention);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // If no filter is selected the stream shows everything except reasoning
  // (reasoning gets explicit opt-in via the pill).
  const visible = useMemo(() => {
    if (filters.length === 0) {
      return events.filter((e) => e.kind !== 'reasoning');
    }
    const set = new Set(filters);
    return events.filter((e) => set.has(e.kind));
  }, [events, filters]);

  const toggleRow = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        backgroundColor: 'var(--bg-sidebar)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      {/* Header — title + filter pills + clear */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontSize: 9.5,
            letterSpacing: '0.18em',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            fontWeight: 600,
            marginRight: 6,
          }}
        >
          Attention
        </span>
        {FILTERS.map((f) => {
          const active = filters.includes(f.kind);
          return (
            <button
              key={f.kind}
              onClick={() => toggleFilter(sessionId, f.kind)}
              className="mt-toolbar-button"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 10.5,
                padding: '2px 7px',
                height: 19,
                border: `1px solid ${active ? 'var(--accent-amber)' : 'var(--border-strong)'}`,
                borderRadius: 'var(--radius-snug)',
                background: active ? 'color-mix(in srgb, var(--accent-amber) 12%, transparent)' : 'transparent',
                color: active ? 'var(--accent-amber)' : 'var(--text-muted)',
                cursor: 'pointer',
                letterSpacing: '0.04em',
                lineHeight: 1,
              }}
            >
              {kindIcon(f.kind, 11)}
              {f.label}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        {events.length > 0 && (
          <button
            onClick={() => clearAttention(sessionId)}
            className="mt-toolbar-button"
            style={{
              fontSize: 10,
              padding: '2px 7px',
              height: 19,
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-snug)',
              background: 'transparent',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              lineHeight: 1,
            }}
            title="Clear attention stream for this session"
          >
            Clear
          </button>
        )}
      </div>

      {/* Stream list */}
      <div
        className="mt-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
        }}
      >
        {visible.length === 0 ? (
          <div
            style={{
              padding: '20px 14px',
              fontSize: 11.5,
              color: 'var(--text-faint)',
              fontStyle: 'italic',
            }}
          >
            No agent activity yet. Reads, edits, commands, and MCP calls will appear here as the agent works.
          </div>
        ) : (
          visible.map((e) => {
            const isOpen = !!expanded[e.id];
            const stripe = providerStripe(e.provider);
            return (
              <button
                key={e.id}
                onClick={() => e.detail && toggleRow(e.id)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: 0,
                  border: 'none',
                  borderBottom: '1px solid var(--border)',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: e.detail ? 'pointer' : 'default',
                  fontFamily: 'inherit',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px 6px 0',
                    minHeight: 28,
                    borderLeft: `3px solid ${stripe}`,
                    paddingLeft: 10,
                  }}
                >
                  <span
                    className="mt-mono-tabular"
                    style={{
                      fontSize: 10,
                      color: 'var(--text-faint)',
                      flexShrink: 0,
                    }}
                  >
                    {formatTime(e.timestamp)}
                  </span>
                  <span
                    style={{
                      flexShrink: 0,
                      color: e.isError ? 'var(--status-error)' : 'var(--text-muted)',
                      display: 'inline-flex',
                      alignItems: 'center',
                    }}
                  >
                    {kindIcon(e.kind)}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: e.isError ? 'var(--status-error)' : 'var(--text-primary)',
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {e.label}
                  </span>
                  {e.detail && (
                    <ChevronRight
                      size={11}
                      style={{
                        color: 'var(--text-faint)',
                        transition: 'transform var(--dur-fast) var(--ease-out)',
                        transform: isOpen ? 'rotate(90deg)' : 'none',
                        flexShrink: 0,
                      }}
                    />
                  )}
                </div>
                {isOpen && e.detail && (
                  <pre
                    className="mt-scroll"
                    style={{
                      margin: 0,
                      padding: '6px 12px 10px 30px',
                      fontSize: 11,
                      lineHeight: 1.45,
                      color: 'var(--text-secondary)',
                      backgroundColor: 'var(--bg-primary)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      maxHeight: 260,
                      overflowY: 'auto',
                      fontFamily: 'inherit',
                    }}
                  >
                    {e.detail}
                  </pre>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
