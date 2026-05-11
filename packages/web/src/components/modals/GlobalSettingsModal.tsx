import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';
import toast from 'react-hot-toast';
import type { GlobalConfig } from '../../lib/types';
import type { Theme, ThemeColors } from '../../lib/themes';
import {
  BUILTIN_THEMES,
  BUILTIN_LIGHT,
  BUILTIN_DARK,
  THEME_COLOR_KEYS,
  cloneTheme,
} from '../../lib/themes';
import { Check, Copy, Pencil, Trash2, Plus } from 'lucide-react';
import { Modal, Input, Button, IconButton, Divider, Badge } from '../ui';
import { NotificationsSection } from './NotificationsSection';
import { IntegrationsSection } from './IntegrationsSection';

interface Props {
  onClose: () => void;
}

export function GlobalSettingsModal({ onClose }: Props) {
  const [config, setConfig] = useState<GlobalConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const {
    activeThemeId,
    customThemes,
    setActiveTheme,
    addCustomTheme,
    updateCustomTheme,
    deleteCustomTheme,
  } = useAppStore();
  const [editingThemeId, setEditingThemeId] = useState<string | null>(null);

  useEffect(() => {
    api.config.get().then(setConfig).catch(() => {
      toast.error('Failed to load settings');
      onClose();
    });
  }, [onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave();
  };

  const handleSave = async () => {
    if (!config) return;
    setLoading(true);
    try {
      await api.config.update(config);
      toast.success('Settings saved');
      onClose();
    } catch {
      toast.error('Failed to save settings');
    } finally {
      setLoading(false);
    }
  };

  const allThemes: Theme[] = [...BUILTIN_THEMES, ...customThemes];
  const editingTheme = customThemes.find((t) => t.id === editingThemeId) ?? null;

  const handleNewTheme = (baseDark: boolean) => {
    const base = baseDark ? BUILTIN_DARK : BUILTIN_LIGHT;
    const name = prompt('Name for new theme:', `${base.name} Custom`);
    if (!name) return;
    const theme = cloneTheme(base, name.trim());
    addCustomTheme(theme);
    setEditingThemeId(theme.id);
    setActiveTheme(theme.id);
  };

  const handleDuplicate = (src: Theme) => {
    const name = prompt('Name for duplicated theme:', `${src.name} Copy`);
    if (!name) return;
    const theme = cloneTheme(src, name.trim());
    addCustomTheme(theme);
    setEditingThemeId(theme.id);
  };

  const handleDelete = (id: string) => {
    const t = customThemes.find((x) => x.id === id);
    if (!t) return;
    if (!confirm(`Delete theme "${t.name}"?`)) return;
    deleteCustomTheme(id);
    if (editingThemeId === id) setEditingThemeId(null);
  };

  if (!config) return null;

  const labelStyle: React.CSSProperties = {
    fontSize: 13,
    color: 'var(--text-secondary)',
    display: 'block',
    marginBottom: 6,
    fontWeight: 500,
  };

  const sectionTitleStyle: React.CSSProperties = {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: '0 0 10px',
  };

  const fieldStyle: React.CSSProperties = {
    marginBottom: 14,
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Global Settings"
      width={700}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} loading={loading}>
            {loading ? 'Saving...' : 'Save Settings'}
          </Button>
        </>
      }
    >
      <div onKeyDown={handleKeyDown}>
        {/* Themes */}
        <h3 style={sectionTitleStyle}>Themes</h3>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Pick a default theme, or create your own. Custom themes are saved to this browser.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {allThemes.map((t) => {
            const isActive = activeThemeId === t.id;
            const isCustom = !t.builtIn;
            return (
              <div
                key={t.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  border: `1px solid ${isActive ? 'var(--accent-amber)' : 'var(--border-strong)'}`,
                  borderLeft: `3px solid ${isActive ? 'var(--accent-amber)' : 'transparent'}`,
                  borderRadius: 'var(--radius-snug)',
                  backgroundColor: isActive ? 'var(--bg-elevated)' : 'var(--bg-sidebar)',
                  transition: 'border-color var(--dur-fast) var(--ease-out), background-color var(--dur-fast) var(--ease-out)',
                }}
              >
                <button
                  onClick={() => setActiveTheme(t.id)}
                  title={isActive ? 'Active theme' : 'Set as default'}
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 'var(--radius-snug)',
                    border: `1px solid ${isActive ? 'var(--accent-amber)' : 'var(--border-strong)'}`,
                    background: 'transparent',
                    color: 'var(--accent-amber)',
                    fontFamily: 'inherit',
                    fontSize: 11,
                    lineHeight: 1,
                    cursor: 'pointer',
                    padding: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {isActive && <Check size={10} />}
                </button>
                <span
                  style={{
                    flex: 1,
                    fontSize: 14,
                    color: 'var(--text-primary)',
                    fontWeight: isActive ? 600 : 500,
                  }}
                >
                  {t.name}
                  {t.builtIn && (
                    <Badge variant="muted" size="sm" style={{ marginLeft: 8 }}>
                      built-in
                    </Badge>
                  )}
                </span>
                <div style={{ display: 'flex', gap: 4, marginRight: 6 }}>
                  {(
                    [
                      t.colors.bgPrimary,
                      t.colors.bgSidebar,
                      t.colors.textPrimary,
                      t.colors.accentBlue,
                      t.colors.statusRunning,
                      t.colors.statusError,
                    ] as string[]
                  ).map((c, i) => (
                    <span
                      key={i}
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 'var(--radius-sm)',
                        backgroundColor: c,
                        border: '1px solid var(--border)',
                      }}
                    />
                  ))}
                </div>
                {isCustom && (
                  <IconButton
                    size="sm"
                    onClick={() =>
                      setEditingThemeId(editingThemeId === t.id ? null : t.id)
                    }
                    label="Edit theme"
                  >
                    <Pencil size={13} />
                  </IconButton>
                )}
                <IconButton
                  size="sm"
                  onClick={() => handleDuplicate(t)}
                  label="Duplicate"
                >
                  <Copy size={13} />
                </IconButton>
                {isCustom && (
                  <IconButton
                    size="sm"
                    variant="danger"
                    onClick={() => handleDelete(t.id)}
                    label="Delete theme"
                  >
                    <Trash2 size={13} />
                  </IconButton>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <Button size="sm" variant="secondary" leftIcon={<Plus size={12} />} onClick={() => handleNewTheme(false)}>
            New from Light
          </Button>
          <Button size="sm" variant="secondary" leftIcon={<Plus size={12} />} onClick={() => handleNewTheme(true)}>
            New from Dark
          </Button>
        </div>

        {editingTheme && (
          <ThemeEditor
            theme={editingTheme}
            onChange={(patch) => updateCustomTheme(editingTheme.id, patch)}
            onClose={() => setEditingThemeId(null)}
          />
        )}

        <Divider margin={18} />

        {/* Appearance */}
        <h3 style={sectionTitleStyle}>Appearance</h3>

        <div style={fieldStyle}>
          <label style={labelStyle}>Terminal font size</label>
          <Input
            type="number"
            min={8}
            max={24}
            value={config.terminalFontSize}
            onChange={(e) => setConfig({ ...config, terminalFontSize: Number(e.target.value) })}
            wrapperStyle={{ maxWidth: 140 }}
          />
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle}>Terminal scrollback</label>
          <Input
            type="number"
            min={1000}
            max={100000}
            value={config.terminalScrollback}
            onChange={(e) => setConfig({ ...config, terminalScrollback: Number(e.target.value) })}
            wrapperStyle={{ maxWidth: 200 }}
          />
        </div>

        <Divider margin={18} />

        {/* Notifications */}
        <h3 style={sectionTitleStyle}>Notifications</h3>
        <NotificationsSection />

        <Divider margin={18} />

        {/* Integrations */}
        <h3 style={sectionTitleStyle}>Integrations</h3>
        <IntegrationsSection />

        <Divider margin={18} />

        {/* Behavior */}
        <h3 style={sectionTitleStyle}>Behavior</h3>

        <div style={fieldStyle}>
          <label style={labelStyle}>Default editor</label>
          <Input
            value={config.defaultEditor}
            onChange={(e) => setConfig({ ...config, defaultEditor: e.target.value })}
            placeholder="code"
            wrapperStyle={{ maxWidth: 260 }}
          />
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle}>Default shell</label>
          <Input
            value={config.defaultShell}
            onChange={(e) => setConfig({ ...config, defaultShell: e.target.value })}
            placeholder="auto-detect"
            wrapperStyle={{ maxWidth: 260 }}
          />
        </div>

        <Divider margin={18} />

        {/* Network */}
        <h3 style={sectionTitleStyle}>Network</h3>

        <div style={fieldStyle}>
          <label style={labelStyle}>Daemon port</label>
          <Input
            type="number"
            value={config.port}
            onChange={(e) => setConfig({ ...config, port: Number(e.target.value) })}
            wrapperStyle={{ maxWidth: 140 }}
          />
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle}>Bind host</label>
          <Input
            value={config.host}
            onChange={(e) => setConfig({ ...config, host: e.target.value })}
            placeholder="127.0.0.1"
            wrapperStyle={{ maxWidth: 260 }}
          />
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Restart daemon for network changes to take effect.
        </div>
      </div>
    </Modal>
  );
}

interface EditorProps {
  theme: Theme;
  onChange: (patch: { name?: string; colors?: Partial<ThemeColors>; isDark?: boolean }) => void;
  onClose: () => void;
}

function ThemeEditor({ theme, onChange, onClose }: EditorProps) {
  return (
    <div
      style={{
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-soft)',
        padding: 14,
        marginBottom: 16,
        backgroundColor: 'var(--bg-sidebar)',
        boxShadow: 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Name</span>
        <Input
          value={theme.name}
          onChange={(e) => onChange({ name: e.target.value })}
          wrapperStyle={{ flex: 1 }}
          style={{ fontSize: 13 }}
        />
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={theme.isDark}
            onChange={(e) => onChange({ isDark: e.target.checked })}
          />
          Dark mode
        </label>
        <Button size="sm" variant="ghost" onClick={onClose}>Done</Button>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
          gap: 8,
        }}
      >
        {THEME_COLOR_KEYS.map(({ key, label }) => (
          <label
            key={key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              color: 'var(--text-secondary)',
            }}
          >
            <input
              type="color"
              value={(theme.colors[key] || '').startsWith('#') ? theme.colors[key] : '#000000'}
              onChange={(e) => onChange({ colors: { [key]: e.target.value } as Partial<ThemeColors> })}
              style={{
                width: 32,
                height: 26,
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: 0,
                background: 'none',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1 }}>{label}</span>
            <input
              value={theme.colors[key]}
              onChange={(e) => onChange({ colors: { [key]: e.target.value } as Partial<ThemeColors> })}
              style={{
                width: 90,
                padding: '2px 6px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)',
                backgroundColor: 'var(--bg-primary)',
                color: 'var(--text-primary)',
                fontSize: 11,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                outline: 'none',
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
