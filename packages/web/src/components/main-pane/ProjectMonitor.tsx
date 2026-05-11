import React, { useState } from 'react';
import type { Session, Command, Terminal } from '../../lib/types';
import { isProcessActive } from '../../lib/processState';

type AnyProcess = Session | Command | Terminal;

const MAX_VISIBLE_WINDOWS = 6;

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function basename(p: string): string {
  if (!p) return '~';
  const parts = p.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '/';
}

function buildLines(process: AnyProcess): { text: string; dim?: boolean; accent?: string }[] {
  if (process.type === 'session') {
    const s = process as Session;
    const lines: { text: string; dim?: boolean; accent?: string }[] = [
      { text: `$ ${s.agentProvider}`, accent: 'var(--accent-amber)' },
    ];
    const label =
      s.claudeState?.userMessages?.[s.claudeState.userMessages.length - 1] ||
      null;
    lines.push({ text: label ? truncate(label, 22) : '—', dim: !label });

    const tool = s.claudeState?.currentTool;
    if (tool) {
      lines.push({ text: `▶ ${truncate(tool, 20)}`, accent: 'var(--accent-amber)' });
    } else if (isProcessActive(process)) {
      lines.push({ text: '▶ waiting', dim: true });
    }

    const cost = s.claudeState?.costUsd ?? 0;
    const tokens = s.claudeState?.tokenCount ?? 0;
    if (cost > 0 || tokens > 0) {
      const costStr = cost > 0 ? `$${cost.toFixed(2)}` : '';
      const tokStr =
        tokens > 0 ? `${tokens > 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens}↓` : '';
      lines.push({ text: `${costStr} ${tokStr}`.trim(), dim: true });
    }
    return lines;
  }

  if (process.type === 'command') {
    const lines: { text: string; dim?: boolean; accent?: string }[] = [
      {
        text: `$ ${truncate(process.command || process.name, 20)}`,
        accent: 'var(--accent-amber)',
      },
    ];
    const port = process.metrics?.detectedPort;
    if (port) {
      lines.push({ text: `▸ listening :${port}`, accent: 'var(--status-running)' });
    } else if (process.state === 'running') {
      lines.push({ text: '▸ ready', dim: true });
    }
    const cpu = process.metrics?.cpuPercent ?? 0;
    const memMb = (process.metrics?.memoryBytes ?? 0) / (1024 * 1024);
    if (cpu > 0 || memMb > 0) {
      lines.push({
        text: `${cpu.toFixed(0)}% ${memMb > 0 ? `${memMb.toFixed(0)}MB` : ''}`.trim(),
        dim: true,
      });
    }
    return lines;
  }

  return [
    {
      text: `$ ${truncate(process.command || 'shell', 20)}`,
      accent: 'var(--accent-amber)',
    },
    { text: `~ ${truncate(basename(process.workingDir || ''), 20)}`, dim: true },
  ];
}

function stateGlyph(state: AnyProcess['state']): { glyph: string; color: string } {
  switch (state) {
    case 'running':
      return { glyph: '●', color: 'var(--status-running)' };
    case 'errored':
      return { glyph: '⊘', color: 'var(--status-error)' };
    case 'stopped':
      return { glyph: '⊗', color: 'var(--status-stopped)' };
    default:
      return { glyph: '◐', color: 'var(--status-warning)' };
  }
}

interface TerminalWindowProps {
  process: AnyProcess;
  onClick?: (e: React.MouseEvent) => void;
}

function TerminalWindow({ process, onClick }: TerminalWindowProps) {
  const [hover, setHover] = useState(false);
  const state = process.state;
  const stopped = state === 'stopped';
  const errored = state === 'errored';
  const running = state === 'running';
  const lines = buildLines(process);
  const { glyph, color } = stateGlyph(state);

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={process.name}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 'var(--radius-soft)',
        border: `1px solid ${hover ? 'var(--accent-amber)' : 'var(--border-strong)'}`,
        background: 'var(--bg-sidebar)',
        overflow: 'hidden',
        cursor: 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        minHeight: 78,
        transition: 'border-color var(--dur-fast) var(--ease-out)',
        opacity: stopped ? 0.55 : 1,
      }}
    >
      {/* Window titlebar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px',
          background: 'var(--bg-elevated)',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: 'inherit',
            fontSize: 11,
            lineHeight: 1,
            color,
            flexShrink: 0,
          }}
        >
          {glyph}
        </span>
        <span
          style={{
            flex: 1,
            fontSize: 9.5,
            lineHeight: 1,
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'inherit',
            letterSpacing: '0.04em',
          }}
        >
          {truncate(process.name, 18)}
        </span>
      </div>

      {/* Window body / terminal content */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          padding: '5px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          overflow: 'hidden',
          backgroundColor: 'var(--bg-primary)',
        }}
      >
        {stopped ? (
          <div
            style={{
              margin: 'auto',
              color: 'var(--text-muted)',
              fontFamily: 'inherit',
              fontSize: 9,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
            }}
          >
            ⊗ stopped
          </div>
        ) : (
          <>
            {errored && (
              <div
                style={{
                  color: 'var(--status-error)',
                  fontFamily: 'inherit',
                  fontSize: 9,
                  lineHeight: 1.2,
                  letterSpacing: '0.06em',
                }}
              >
                ⊘ error
              </div>
            )}
            {lines.map((line, i) => (
              <div
                key={i}
                style={{
                  color: line.accent || (line.dim ? 'var(--text-muted)' : 'var(--text-primary)'),
                  fontFamily: 'inherit',
                  fontSize: 9,
                  lineHeight: 1.25,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {line.text}
                {running && i === lines.length - 1 && (
                  <span
                    aria-hidden
                    style={{
                      display: 'inline-block',
                      marginLeft: 2,
                      color: 'var(--accent-amber)',
                      fontFamily: 'inherit',
                      verticalAlign: 'middle',
                      animation: 'mt-blink 1s steps(2) infinite',
                    }}
                  >
                    ▌
                  </span>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

interface MoreTileProps {
  count: number;
  onClick?: (e: React.MouseEvent) => void;
}

function MoreTile({ count, onClick }: MoreTileProps) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        minHeight: 78,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: `1px dashed ${hover ? 'var(--accent-amber)' : 'var(--border-strong)'}`,
        borderRadius: 'var(--radius-soft)',
        background: 'transparent',
        color: hover ? 'var(--accent-amber)' : 'var(--text-muted)',
        fontFamily: 'inherit',
        fontSize: 10,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        cursor: 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        transition: 'border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
      }}
    >
      +{count} more
    </div>
  );
}

interface Props {
  processes: AnyProcess[];
  onSelectProcess?: (proc: AnyProcess) => void;
  onOpenAll?: () => void;
}

export function ProjectMonitor({ processes, onSelectProcess, onOpenAll }: Props) {
  const overflow = processes.length > MAX_VISIBLE_WINDOWS;
  const visible = overflow ? processes.slice(0, MAX_VISIBLE_WINDOWS - 1) : processes;
  const overflowCount = overflow ? processes.length - (MAX_VISIBLE_WINDOWS - 1) : 0;

  return (
    <div
      style={{
        position: 'relative',
        border: '1px solid var(--border)',
        background: 'var(--bg-elevated)',
        padding: 6,
      }}
    >
      <div
        style={{
          minHeight: 200,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gridAutoRows: 'minmax(78px, auto)',
          gap: 6,
        }}
      >
        {processes.length === 0 ? (
          <div
            style={{
              gridColumn: '1 / -1',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)',
              fontFamily: 'inherit',
              fontSize: 10,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              minHeight: 180,
            }}
          >
            ○ no sessions
          </div>
        ) : (
          <>
            {visible.map((proc) => (
              <TerminalWindow
                key={proc.id}
                process={proc}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectProcess?.(proc);
                }}
              />
            ))}
            {overflow && (
              <MoreTile
                count={overflowCount}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenAll?.();
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
