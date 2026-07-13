import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import {
  ensureIconSets,
  getCachedSets,
  loadNamesIndex,
  searchIcons,
  type IconRef,
  type IconSetMeta,
} from '../../lib/iconifyCatalog';
import { getProjectGlyph } from '../../lib/projectGlyph';
import { ProjectGlyphIcon } from './ProjectGlyphIcon';

const ICON_SIZE = 18;
const CELL_MIN = 32;

/**
 * Searchable multi-set project glyph picker (~48k offline Iconify icons).
 * Domain-agnostic — not tech-only. Wildcard search across all sets.
 */
export function ProjectGlyphPopover({
  projectId,
  position,
  onClose,
}: {
  projectId: string;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  const current = useAppStore((s) => s.projectNav.glyphs?.[projectId] ?? null);
  const setProjectGlyphOverride = useAppStore((s) => s.setProjectGlyphOverride);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [setFilter, setSetFilter] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sets, setSets] = useState<IconSetMeta[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadNamesIndex()
      .then((idx) => {
        if (cancelled) return;
        setSets(idx.sets);
        setTotal(idx.totalIcons);
        setReady(true);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message || 'Failed to load icon catalog');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const results = useMemo(() => {
    if (!ready) return { mode: 'loading' as const, glyphs: [] as IconRef[] };
    const q = query.trim();
    if (!q && !setFilter) {
      return { mode: 'browse' as const, glyphs: searchIcons('', { limit: 500 }) };
    }
    if (!q && setFilter) {
      return {
        mode: 'set' as const,
        glyphs: searchIcons('', { set: setFilter, limit: 800 }),
      };
    }
    return {
      mode: 'search' as const,
      glyphs: searchIcons(q, { set: setFilter, limit: 400 }),
    };
  }, [query, setFilter, ready]);

  // Prefetch icon sets for visible results so cells paint.
  useEffect(() => {
    if (results.glyphs.length === 0) return;
    const prefixes = new Set(results.glyphs.map((g) => g.prefix));
    void ensureIconSets(prefixes);
  }, [results.glyphs]);

  const currentGlyph = getProjectGlyph(current);
  const browsing = results.mode === 'browse';

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.clearTimeout(t);
    };
  }, [onClose]);

  const width = 360;
  const maxHeight = 520;
  let left = position.x;
  let top = position.y;
  if (left + width > window.innerWidth) left = window.innerWidth - width - 8;
  if (top + maxHeight > window.innerHeight) top = window.innerHeight - maxHeight - 8;
  if (left < 0) left = 8;
  if (top < 0) top = 8;

  const pick = (id: string | null) => {
    setProjectGlyphOverride(projectId, id);
    onClose();
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Project glyph picker"
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 2000,
        width,
        maxHeight,
        // Clip everything — Iconify SVGs must not paint outside the panel.
        overflow: 'hidden',
        isolation: 'isolate',
        contain: 'layout paint',
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-lg)',
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 0,
        animation: 'mt-scale-in var(--dur-fast) var(--ease-out)',
        transformOrigin: 'top left',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
          padding: '0 2px',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '0.04em',
            color: 'var(--text-faint)',
          }}
        >
          Project glyph
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>
          {ready ? `${total.toLocaleString()} icons · ${sets.length} sets` : 'Loading catalog…'}
        </span>
      </div>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 8px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <Search size={13} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search any domain…  cat  pizza  *robot*  brand-*"
          spellCheck={false}
          autoComplete="off"
          disabled={!ready}
          style={{
            flex: 1,
            minWidth: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontSize: 12.5,
            fontFamily: 'inherit',
            padding: 0,
          }}
        />
      </label>

      {ready && sets.length > 0 && (
        <div
          className="mt-scroll"
          style={{
            display: 'flex',
            gap: 4,
            overflowX: 'auto',
            overflowY: 'hidden',
            paddingBottom: 2,
            flexShrink: 0,
            maxWidth: '100%',
          }}
        >
          <SetChip
            label="All"
            active={setFilter === null}
            onClick={() => setSetFilter(null)}
          />
          {sets.map((s) => (
            <SetChip
              key={s.prefix}
              label={s.name}
              count={s.count}
              active={setFilter === s.prefix}
              onClick={() => setSetFilter(s.prefix === setFilter ? null : s.prefix)}
            />
          ))}
        </div>
      )}

      <div
        style={{
          fontSize: 10,
          color: 'var(--text-faint)',
          padding: '0 2px',
          lineHeight: 1.35,
          flexShrink: 0,
        }}
      >
        {error ? (
          <span style={{ color: 'var(--status-error)' }}>{error}</span>
        ) : !ready ? (
          <>Loading offline catalog…</>
        ) : browsing ? (
          <>
            Full offline catalog · any project type · wildcards{' '}
            <code style={{ fontSize: 10 }}>* ?</code>
          </>
        ) : results.glyphs.length === 0 ? (
          <>No matches — try another word or set filter</>
        ) : (
          <>
            {results.glyphs.length.toLocaleString()}
            {results.glyphs.length >= 400 ? '+' : ''} shown
            {setFilter
              ? ` in ${getCachedSets().find((s) => s.prefix === setFilter)?.name ?? setFilter}`
              : ' across all sets'}
          </>
        )}
      </div>

      {currentGlyph && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 8px',
            borderRadius: 'var(--radius-md)',
            background: 'color-mix(in oklch, var(--space-accent) 10%, transparent)',
            border: '1px solid color-mix(in oklch, var(--space-accent) 30%, transparent)',
            fontSize: 11,
            color: 'var(--text-secondary)',
            flexShrink: 0,
            overflow: 'hidden',
          }}
        >
          <ProjectGlyphIcon id={currentGlyph.id} size={ICON_SIZE} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {currentGlyph.label}
            <span style={{ color: 'var(--text-faint)', marginLeft: 6 }}>{currentGlyph.id}</span>
          </span>
        </div>
      )}

      {/* Single scrollable grid — scroll host wraps the grid so SVGs clip. */}
      <div
        className="mt-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          maxHeight: 300,
          overflowX: 'hidden',
          overflowY: 'auto',
          maxWidth: '100%',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(8, minmax(0, 1fr))',
            gap: 4,
            alignContent: 'start',
            // Keep last row clear of the panel edge while scrolling.
            paddingBottom: 4,
          }}
        >
          {results.glyphs.map((g) => (
            <GlyphCell
              key={g.id}
              glyph={g}
              isCurrent={isCurrentId(current, g.id)}
              onPick={() => pick(g.id)}
            />
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={() => pick(null)}
        style={{
          padding: '5px 8px',
          fontSize: 12,
          fontFamily: 'inherit',
          textAlign: 'left',
          background: 'transparent',
          border: 'none',
          borderRadius: 'var(--radius-md)',
          color: current === null ? 'var(--text-primary)' : 'var(--text-muted)',
          fontWeight: current === null ? 600 : 400,
          cursor: 'pointer',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--bg-hover)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
        }}
      >
        Acronym (auto)
      </button>
    </div>
  );
}

function isCurrentId(current: string | null, id: string): boolean {
  if (!current) return false;
  if (current === id) return true;
  const a = getProjectGlyph(current);
  const b = getProjectGlyph(id);
  return !!a && !!b && a.id === b.id;
}

function SetChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flexShrink: 0,
        padding: '3px 8px',
        fontSize: 10.5,
        fontFamily: 'inherit',
        borderRadius: 999,
        border: '1px solid',
        borderColor: active
          ? 'color-mix(in oklch, var(--space-accent) 45%, transparent)'
          : 'var(--border)',
        background: active
          ? 'color-mix(in oklch, var(--space-accent) 14%, transparent)'
          : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
      {count != null ? (
        <span style={{ opacity: 0.65, marginLeft: 4, fontVariantNumeric: 'tabular-nums' }}>
          {count > 999 ? `${Math.round(count / 1000)}k` : count}
        </span>
      ) : null}
    </button>
  );
}

function GlyphCell({
  glyph,
  isCurrent,
  onPick,
}: {
  glyph: IconRef;
  isCurrent: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      title={`${glyph.label} (${glyph.id})`}
      aria-label={`Set glyph ${glyph.label}`}
      aria-pressed={isCurrent}
      onClick={onPick}
      style={{
        width: '100%',
        minWidth: 0,
        minHeight: CELL_MIN,
        aspectRatio: '1',
        padding: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 6,
        border: 'none',
        // Clip SVG overflow inside the cell.
        overflow: 'hidden',
        background: isCurrent
          ? 'color-mix(in oklch, var(--space-accent) 18%, transparent)'
          : 'transparent',
        color: isCurrent ? 'var(--text-primary)' : 'var(--text-secondary)',
        boxShadow: isCurrent
          ? '0 0 0 1px color-mix(in oklch, var(--space-accent) 50%, transparent)'
          : 'none',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        if (!isCurrent) {
          e.currentTarget.style.background =
            'color-mix(in oklch, var(--text-primary) 6%, transparent)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isCurrent) e.currentTarget.style.background = 'transparent';
      }}
    >
      <ProjectGlyphIcon id={glyph.id} size={ICON_SIZE} />
    </button>
  );
}
