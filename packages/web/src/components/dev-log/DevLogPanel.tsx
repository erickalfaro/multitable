import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { X, Trash2, Copy, Pause, Play, Search } from 'lucide-react';
import { devLog, safeStringify, trimPreview } from '../../lib/devLog';
import type { DevLogEntry, LogCategory } from '../../lib/devLog';
import { useAppStore } from '../../stores/appStore';
import { IconButton } from '../ui';

const CATEGORY_LABELS: Record<LogCategory, string> = {
  'ws-in': 'WS in',
  'ws-out': 'WS out',
  'ws-conn': 'WS conn',
  'ws-pty': 'WS pty',
  api: 'API',
  timer: 'Timer',
  watchdog: 'Watchdog',
  permission: 'Perm',
  elicitation: 'Elicit',
  codex: 'Codex',
  agent: 'Agent',
  error: 'Error',
  warn: 'Warn',
  info: 'Info',
};

const CATEGORY_ORDER: LogCategory[] = [
  'ws-in',
  'ws-out',
  'ws-conn',
  'ws-pty',
  'api',
  'timer',
  'watchdog',
  'permission',
  'elicitation',
  'codex',
  'agent',
  'error',
  'warn',
  'info',
];

const CATEGORY_COLORS: Record<LogCategory, string> = {
  'ws-in': 'var(--accent-amber)',
  'ws-out': 'var(--accent-amber-dim)',
  'ws-conn': 'var(--text-secondary)',
  'ws-pty': 'var(--text-muted)',
  api: 'var(--text-secondary)',
  timer: 'var(--accent-blue, #6384ff)',
  watchdog: 'var(--accent-blue, #6384ff)',
  permission: 'var(--accent-amber)',
  elicitation: 'var(--accent-amber)',
  codex: 'var(--text-secondary)',
  agent: 'var(--text-secondary)',
  error: 'var(--status-error)',
  warn: 'var(--status-stopped)',
  info: 'var(--text-muted)',
};

const FILTER_STORAGE_KEY = 'mt:devLogFilters';
const HEIGHT_STORAGE_KEY = 'mt:devLogHeight';
const DEFAULT_FILTERS: Record<LogCategory, boolean> = {
  'ws-in': true,
  'ws-out': true,
  'ws-conn': true,
  'ws-pty': false, // pty traffic is chatty; off by default
  api: true,
  timer: true,
  watchdog: true,
  permission: true,
  elicitation: true,
  codex: true,
  agent: true,
  error: true,
  warn: true,
  info: true,
};

function loadFilters(): Record<LogCategory, boolean> {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_FILTERS;
    return { ...DEFAULT_FILTERS, ...parsed } as Record<LogCategory, boolean>;
  } catch {
    return DEFAULT_FILTERS;
  }
}

function saveFilters(filters: Record<LogCategory, boolean>): void {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // ignore quota
  }
}

function loadHeight(): number {
  try {
    const raw = localStorage.getItem(HEIGHT_STORAGE_KEY);
    if (!raw) return 320;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 120 || n > 900) return 320;
    return n;
  } catch {
    return 320;
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function useDevLogEntries(): readonly DevLogEntry[] {
  return useSyncExternalStore(devLog.subscribe, devLog.getAll, devLog.getAll);
}

interface RowProps {
  entry: DevLogEntry;
  expanded: boolean;
  onToggle: () => void;
}

const Row = React.memo(function Row({ entry, expanded, onToggle }: RowProps) {
  const color = CATEGORY_COLORS[entry.category];
  const levelColor =
    entry.level === 'error'
      ? 'var(--status-error)'
      : entry.level === 'warn'
        ? 'var(--status-stopped)'
        : 'transparent';
  return (
    <div
      onClick={onToggle}
      style={{
        padding: '4px 12px',
        cursor: 'pointer',
        borderBottom: '1px solid var(--border)',
        backgroundColor: expanded ? 'var(--bg-hover)' : 'transparent',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '94px 12px 70px 1fr 56px',
          gap: 8,
          alignItems: 'baseline',
          fontFamily: 'inherit',
          fontSize: 11,
          lineHeight: 1.45,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span style={{ color: 'var(--text-faint)' }}>{formatTime(entry.ts)}</span>
        <span
          style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: '50%',
            backgroundColor: levelColor,
            justifySelf: 'center',
          }}
        />
        <span
          style={{
            color,
            fontSize: 9.5,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontWeight: 600,
          }}
        >
          {CATEGORY_LABELS[entry.category]}
        </span>
        <span
          style={{
            color: entry.level === 'error' ? 'var(--status-error)' : 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={entry.label}
        >
          {entry.label}
          {entry.detail && (
            <span style={{ color: 'var(--text-muted)' }}> · {trimPreview(entry.detail, 200)}</span>
          )}
        </span>
        <span style={{ color: 'var(--text-faint)', textAlign: 'right' }}>
          {typeof entry.durationMs === 'number' ? `${entry.durationMs}ms` : ''}
        </span>
      </div>
      {expanded && entry.data !== undefined && (
        <pre
          style={{
            margin: '6px 0 4px 102px',
            padding: '8px 10px',
            fontSize: 11,
            lineHeight: 1.45,
            color: 'var(--text-secondary)',
            backgroundColor: 'var(--bg-primary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-snug)',
            maxHeight: 280,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {safeStringify(entry.data)}
        </pre>
      )}
    </div>
  );
});

export function DevLogPanel() {
  const open = useAppStore((s) => s.devLogOpen);
  const setOpen = useAppStore((s) => s.setDevLogOpen);

  const entries = useDevLogEntries();
  const [filters, setFilters] = useState<Record<LogCategory, boolean>>(loadFilters);
  const [search, setSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [height, setHeight] = useState<number>(loadHeight);

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  useEffect(() => {
    try {
      localStorage.setItem(HEIGHT_STORAGE_KEY, String(height));
    } catch {
      // ignore
    }
  }, [height]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (!filters[e.category]) return false;
      if (!q) return true;
      if (e.label.toLowerCase().includes(q)) return true;
      if (e.detail && e.detail.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [entries, filters, search]);

  const listRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  // Track whether the user has scrolled up — auto-scroll only sticks when
  // we're already pinned to the bottom.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      wasAtBottomRef.current = distance < 24;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [open]);

  useEffect(() => {
    if (!open || paused) return;
    const el = listRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filtered.length, open, paused]);

  // Drag-to-resize from the top edge of the panel. Pointer events so the
  // drag works with touch as well as mouse.
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(140, Math.min(window.innerHeight - 80, startH + (startY - ev.clientY)));
      setHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, [height]);

  const copyAll = useCallback(() => {
    const text = filtered
      .map((e) => {
        const base = `${formatTime(e.ts)}  ${e.category.padEnd(8)}  ${e.label}${
          e.detail ? `  · ${e.detail}` : ''
        }${typeof e.durationMs === 'number' ? `  ${e.durationMs}ms` : ''}`;
        if (e.data === undefined) return base;
        return `${base}\n${safeStringify(e.data)}`;
      })
      .join('\n');
    void navigator.clipboard?.writeText(text);
  }, [filtered]);

  const clearLog = useCallback(() => {
    devLog.clear();
    setExpandedId(null);
  }, []);

  if (!open) return null;

  const total = entries.length;
  const shown = filtered.length;

  return (
    <div
      style={{
        position: 'relative',
        height,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--bg-elevated)',
        borderTop: '1px solid var(--border-strong)',
        userSelect: 'none',
      }}
    >
      {/* Resize handle — sits at the very top of the panel so dragging
          upward grows it and pushes the rest of the app up. */}
      <div
        onPointerDown={startResize}
        style={{
          position: 'absolute',
          top: -3,
          left: 0,
          right: 0,
          height: 6,
          cursor: 'row-resize',
          zIndex: 1,
          touchAction: 'none',
        }}
      />

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 10px',
          borderBottom: '1px solid var(--border)',
          backgroundColor: 'var(--bg-statusbar)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            color: 'var(--text-primary)',
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
          }}
        >
          DEV LOG
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
          {shown}/{total}
        </span>

        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {CATEGORY_ORDER.map((cat) => {
            const on = filters[cat];
            return (
              <button
                key={cat}
                onClick={() => setFilters((f) => ({ ...f, [cat]: !f[cat] }))}
                style={{
                  height: 20,
                  padding: '0 8px',
                  fontSize: 9.5,
                  fontFamily: 'inherit',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  border: '1px solid',
                  borderColor: on ? CATEGORY_COLORS[cat] : 'var(--border-strong)',
                  borderRadius: 'var(--radius-snug)',
                  cursor: 'pointer',
                  background: on ? 'color-mix(in srgb, var(--bg-hover) 60%, transparent)' : 'transparent',
                  color: on ? CATEGORY_COLORS[cat] : 'var(--text-muted)',
                  fontWeight: 600,
                }}
              >
                {CATEGORY_LABELS[cat]}
              </button>
            );
          })}
        </div>

        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-snug)',
            padding: '0 8px',
            height: 22,
            backgroundColor: 'var(--bg-primary)',
            minWidth: 140,
            maxWidth: 320,
          }}
        >
          <Search size={11} color="var(--text-muted)" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="filter…"
            spellCheck={false}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text-primary)',
              fontFamily: 'inherit',
              fontSize: 11,
              minWidth: 0,
            }}
          />
        </div>

        <IconButton
          size="sm"
          label={paused ? 'Resume autoscroll' : 'Pause autoscroll'}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? <Play size={11} /> : <Pause size={11} />}
        </IconButton>
        <IconButton size="sm" label="Copy filtered log" onClick={copyAll}>
          <Copy size={11} />
        </IconButton>
        <IconButton size="sm" label="Clear log" onClick={clearLog}>
          <Trash2 size={11} />
        </IconButton>
        <IconButton size="sm" label="Close" onClick={() => setOpen(false)}>
          <X size={11} />
        </IconButton>
      </div>

      {/* Body */}
      <div
        ref={listRef}
        className="mt-scroll"
        style={{
          flex: 1,
          overflowY: 'auto',
          fontFamily: 'inherit',
          backgroundColor: 'var(--bg-elevated)',
          userSelect: 'text',
          WebkitUserSelect: 'text',
        }}
      >
        {filtered.length === 0 ? (
          <div
            style={{
              padding: 24,
              fontSize: 11,
              color: 'var(--text-muted)',
              textAlign: 'center',
            }}
          >
            {total === 0 ? 'No log entries yet.' : 'No entries match the current filters.'}
          </div>
        ) : (
          filtered.map((e) => (
            <Row
              key={e.id}
              entry={e}
              expanded={expandedId === e.id}
              onToggle={() => setExpandedId((id) => (id === e.id ? null : e.id))}
            />
          ))
        )}
      </div>
    </div>
  );
}
