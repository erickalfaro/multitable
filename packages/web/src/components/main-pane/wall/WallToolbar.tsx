import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { ChevronDown, Lock, LockOpen, RotateCcw, Trash2 } from 'lucide-react';
import type { GridStack } from 'gridstack';
import { useAppStore } from '../../../stores/appStore';
import { IconButton } from '../../ui';
import {
  BUILTIN_PRESETS,
  buildPresetLayouts,
  equalGrid,
  type PresetGenerator,
} from './layoutPresets';
import type { WallLayoutItem } from '../../../lib/types';

interface Props {
  pinnedIds: string[];
  gridRef: RefObject<GridStack | null>;
}

// Push a layout into gridstack imperatively so the user sees the preset take
// effect immediately. Gridstack's onChange handler then mirrors back to the
// store, but we also call setWallLayout proactively so the persisted state
// is correct even if onChange doesn't fire (e.g. identical layout).
function applyToGridstack(grid: GridStack | null, items: WallLayoutItem[]) {
  if (!grid) return;
  grid.load(
    items.map((it) => ({
      id: it.i,
      x: it.x,
      y: it.y,
      w: it.w,
      h: it.h,
    })),
  );
}

export function WallToolbar({ pinnedIds, gridRef }: Props) {
  const presets = useAppStore((s) => s.wallLayoutPresets);
  const locked = useAppStore((s) => s.wallLayoutLocked);
  const setWallLayout = useAppStore((s) => s.setWallLayout);
  const saveLayoutPreset = useAppStore((s) => s.saveLayoutPreset);
  const applyLayoutPreset = useAppStore((s) => s.applyLayoutPreset);
  const deleteLayoutPreset = useAppStore((s) => s.deleteLayoutPreset);
  const resetWallLayout = useAppStore((s) => s.resetWallLayout);
  const setWallLayoutLocked = useAppStore((s) => s.setWallLayoutLocked);

  const [open, setOpen] = useState(false);
  const [savingName, setSavingName] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setSavingName(null);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const applyBuiltin = (gen: PresetGenerator) => {
    const layouts = buildPresetLayouts(gen, pinnedIds);
    setWallLayout(layouts);
    if (layouts.lg) applyToGridstack(gridRef.current, layouts.lg);
    setOpen(false);
  };

  const applySaved = (id: string) => {
    applyLayoutPreset(id);
    const preset = useAppStore.getState().wallLayoutPresets.find((p) => p.id === id);
    if (preset?.layouts.lg) applyToGridstack(gridRef.current, preset.layouts.lg);
    setOpen(false);
  };

  const handleReset = () => {
    resetWallLayout();
    // Generate the default Equal Grid in-place so the user sees the wall
    // snap to a clean state rather than going blank.
    applyToGridstack(gridRef.current, equalGrid(pinnedIds, 'lg'));
  };

  const handleSave = () => {
    const name = (savingName ?? '').trim();
    if (!name) {
      setSavingName(null);
      return;
    }
    saveLayoutPreset(name);
    setSavingName(null);
    setOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className="mt-wall-toolbar mt-auto-hide"
      style={{
        position: 'absolute',
        top: 4,
        right: 4,
        zIndex: 30,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={btnStyle}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          Layout
          <ChevronDown size={11} style={{ marginLeft: 4, opacity: 0.7 }} />
        </button>
        {open && (
          <div role="menu" style={menuStyle}>
            <div style={menuLabel}>Auto layouts</div>
            {BUILTIN_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                style={menuItemStyle}
                onClick={() => applyBuiltin(p)}
                role="menuitem"
              >
                {p.name}
              </button>
            ))}
            {presets.length > 0 && (
              <>
                <div style={menuDivider} />
                <div style={menuLabel}>Saved</div>
                {presets.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 2,
                    }}
                  >
                    <button
                      type="button"
                      style={{ ...menuItemStyle, flex: 1, paddingRight: 4 }}
                      onClick={() => applySaved(p.id)}
                      role="menuitem"
                    >
                      {p.name}
                    </button>
                    <button
                      type="button"
                      style={menuTrashStyle}
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteLayoutPreset(p.id);
                      }}
                      aria-label={`Delete preset ${p.name}`}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </>
            )}
            <div style={menuDivider} />
            {savingName === null ? (
              <button
                type="button"
                style={menuItemStyle}
                onClick={() => setSavingName('')}
                role="menuitem"
              >
                Save current as…
              </button>
            ) : (
              <div style={{ padding: '4px 6px', display: 'flex', gap: 4 }}>
                <input
                  autoFocus
                  value={savingName}
                  onChange={(e) => setSavingName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSave();
                    if (e.key === 'Escape') setSavingName(null);
                  }}
                  placeholder="Layout name"
                  style={inputStyle}
                />
                <button type="button" style={btnStyle} onClick={handleSave}>
                  Save
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <IconButton
        size="sm"
        label="Reset to auto layout"
        onClick={handleReset}
      >
        <RotateCcw size={12} />
      </IconButton>
      <IconButton
        size="sm"
        label={locked ? 'Unlock layout' : 'Lock layout'}
        onClick={() => setWallLayoutLocked(!locked)}
      >
        {locked ? <Lock size={12} /> : <LockOpen size={12} />}
      </IconButton>
    </div>
  );
}

const btnStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 22,
  padding: '0 8px',
  fontSize: 11,
  fontWeight: 500,
  color: 'var(--text-secondary)',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  cursor: 'pointer',
};

const menuStyle: CSSProperties = {
  position: 'absolute',
  top: 26,
  right: 0,
  minWidth: 180,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  boxShadow: 'var(--shadow-md)',
  padding: 4,
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

const menuLabel: CSSProperties = {
  fontSize: 9.5,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  color: 'var(--text-muted)',
  padding: '4px 6px 2px',
};

const menuItemStyle: CSSProperties = {
  textAlign: 'left',
  padding: '5px 8px',
  fontSize: 12,
  color: 'var(--text-primary)',
  background: 'transparent',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
};

const menuTrashStyle: CSSProperties = {
  height: 22,
  width: 22,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  borderRadius: 4,
  color: 'var(--text-muted)',
  cursor: 'pointer',
};

const menuDivider: CSSProperties = {
  height: 1,
  background: 'var(--border)',
  margin: '4px 0',
};

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 22,
  padding: '0 6px',
  fontSize: 12,
  color: 'var(--text-primary)',
  background: 'var(--bg-base)',
  border: '1px solid var(--border)',
  borderRadius: 4,
};
