import React, { useMemo } from 'react';
import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { api } from '../../lib/api';
import toast from 'react-hot-toast';
import { BUILTIN_THEMES } from '../../lib/themes';
import { Kbd } from '../ui';

interface CommandItem {
  id: string;
  name: string;
  subtitle?: string;
  category: string;
  action: () => void;
  shortcut?: string[];
}

export function CommandPalette() {
  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    projects,
    sessions,
    commands,
    terminals,
    focusedProjectId,
    selectedProcessId,
    setSelectedProcess,
    toggleProjectExpanded,
    setFocusedProject,
    setProjectOverviewOpen,
    setAddAgentModalOpen,
    setAddProcessModalOpen,
    setAddProjectModalOpen,
    setGlobalSettingsOpen,
    setProjectSettingsOpen,
    setActiveTheme,
    activeThemeId,
    customThemes,
  } = useAppStore();

  const close = () => setCommandPaletteOpen(false);

  const requireFocused = (): string | null => {
    if (!focusedProjectId) {
      toast.error('Select a project first');
      return null;
    }
    return focusedProjectId;
  };

  const items = useMemo<CommandItem[]>(() => {
    const result: CommandItem[] = [];
    const projectName = (pid: string) =>
      projects.find((p) => p.id === pid)?.name ?? '';

    for (const s of Object.values(sessions)) {
      result.push({
        id: s.id,
        name: s.name,
        subtitle: projectName(s.projectId),
        category: 'Processes',
        action: () => setSelectedProcess(s.id),
      });
    }
    for (const c of Object.values(commands)) {
      result.push({
        id: c.id,
        name: c.name,
        subtitle: projectName(c.projectId),
        category: 'Processes',
        action: () => setSelectedProcess(c.id),
      });
    }
    for (const t of Object.values(terminals)) {
      result.push({
        id: t.id,
        name: t.name || 'Terminal',
        subtitle: projectName(t.projectId),
        category: 'Processes',
        action: () => setSelectedProcess(t.id),
      });
    }

    for (const p of projects) {
      result.push({
        id: `project-${p.id}`,
        name: p.name,
        category: 'Projects',
        action: () => {
          toggleProjectExpanded(p.id);
          setFocusedProject(p.id);
          setSelectedProcess(null);
          setProjectOverviewOpen(true);
        },
      });
    }

    if (focusedProjectId) {
      result.push({
        id: 'action-start-all',
        name: 'Start all processes',
        subtitle: projectName(focusedProjectId),
        category: 'Actions',
        action: () => {
          api.projects
            .startAll(focusedProjectId)
            .then(() => toast.success('All processes started'))
            .catch(() => toast.error('Failed to start all'));
        },
      });
      result.push({
        id: 'action-stop-all',
        name: 'Stop all processes',
        subtitle: projectName(focusedProjectId),
        category: 'Actions',
        action: () => {
          api.projects
            .stopAll(focusedProjectId)
            .then(() => toast.success('All processes stopped'))
            .catch(() => toast.error('Failed to stop all'));
        },
      });
    }

    result.push({
      id: 'nav-dashboard',
      name: 'Go to Dashboard',
      category: 'Navigation',
      action: () => {
        setSelectedProcess(null);
        setProjectOverviewOpen(false);
      },
    });

    result.push({
      id: 'create-terminal',
      name: 'New terminal',
      subtitle: focusedProjectId ? projectName(focusedProjectId) : '(select a project first)',
      category: 'Create',
      shortcut: ['Ctrl', 'T'],
      action: () => {
        const pid = requireFocused();
        if (!pid) return;
        api.terminals
          .create(pid, {})
          .then((t) => {
            const s = useAppStore.getState();
            s.upsertTerminal(t);
            s.setSelectedProcess(t.id);
            toast.success('Terminal created');
          })
          .catch(() => toast.error('Failed to create terminal'));
      },
    });
    result.push({
      id: 'create-session',
      name: 'Add agent...',
      subtitle: focusedProjectId ? projectName(focusedProjectId) : '(select a project first)',
      category: 'Create',
      action: () => {
        if (!requireFocused()) return;
        setAddAgentModalOpen(true);
      },
    });
    result.push({
      id: 'create-command',
      name: 'Add command...',
      subtitle: focusedProjectId ? projectName(focusedProjectId) : '(select a project first)',
      category: 'Create',
      action: () => {
        if (!requireFocused()) return;
        setAddProcessModalOpen(true);
      },
    });
    result.push({
      id: 'create-project',
      name: 'Add project...',
      category: 'Create',
      action: () => setAddProjectModalOpen(true),
    });

    result.push({
      id: 'settings-global',
      name: 'Open global settings',
      category: 'Settings',
      shortcut: ['Ctrl', ','],
      action: () => setGlobalSettingsOpen(true),
    });
    result.push({
      id: 'settings-project',
      name: 'Open project settings',
      subtitle: focusedProjectId ? projectName(focusedProjectId) : '(select a project first)',
      category: 'Settings',
      action: () => {
        if (!requireFocused()) return;
        setProjectSettingsOpen(true);
      },
    });
    const allThemes = [...BUILTIN_THEMES, ...customThemes];
    for (const t of allThemes) {
      result.push({
        id: `theme-${t.id}`,
        name: `Theme: ${t.name}`,
        subtitle: activeThemeId === t.id ? '(active)' : undefined,
        category: 'Themes',
        action: () => {
          setActiveTheme(t.id);
          toast.success(`Theme: ${t.name}`);
        },
      });
    }

    return result;
  }, [
    sessions,
    commands,
    terminals,
    projects,
    focusedProjectId,
    selectedProcessId,
    activeThemeId,
    customThemes,
    setSelectedProcess,
    toggleProjectExpanded,
    setFocusedProject,
    setProjectOverviewOpen,
    setAddAgentModalOpen,
    setAddProcessModalOpen,
    setAddProjectModalOpen,
    setGlobalSettingsOpen,
    setProjectSettingsOpen,
    setActiveTheme,
  ]);

  const grouped = useMemo(() => {
    const map = new Map<string, CommandItem[]>();
    for (const item of items) {
      const group = map.get(item.category) || [];
      group.push(item);
      map.set(item.category, group);
    }
    return map;
  }, [items]);

  if (!commandPaletteOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 80,
        backgroundColor: 'var(--bg-overlay)',
        backdropFilter: 'blur(12px) saturate(1.1)',
        WebkitBackdropFilter: 'blur(12px) saturate(1.1)',
        animation: 'mt-fade-in var(--dur-fast) var(--ease-out)',
      }}
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-soft)',
          width: '100%',
          maxWidth: 620,
          boxShadow: 'none',
          overflow: 'hidden',
          animation: 'mt-fade-in var(--dur-med) var(--ease-out)',
        }}
      >
        <Command label="Command palette">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '0 14px',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <span
              aria-hidden
              style={{
                color: 'var(--accent-amber)',
                fontFamily: 'inherit',
                fontSize: 16,
                fontWeight: 700,
                lineHeight: 1,
                userSelect: 'none',
                WebkitUserSelect: 'none',
              }}
            >
              :
            </span>
            <Search size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            <Command.Input
              placeholder="Search commands..."
              autoFocus
              style={{
                flex: 1,
                padding: '12px 0',
                fontSize: 12.5,
                fontFamily: 'inherit',
                border: 'none',
                outline: 'none',
                backgroundColor: 'transparent',
                color: 'var(--text-primary)',
                caretColor: 'var(--accent-amber)',
              }}
            />
          </div>
          <Command.List
            className="mt-scroll"
            style={{ maxHeight: 420, overflowY: 'auto', padding: 4 }}
          >
            <Command.Empty
              style={{
                padding: 24,
                color: 'var(--text-muted)',
                textAlign: 'center',
                fontSize: 12,
                textTransform: 'uppercase',
                letterSpacing: '0.18em',
              }}
            >
              No results
            </Command.Empty>
            {Array.from(grouped.entries()).map(([category, groupItems]) => (
              <Command.Group
                key={category}
                heading={category}
                style={{ marginBottom: 4 }}
              >
                {groupItems.map((item) => (
                  <Command.Item
                    key={item.id}
                    value={`${item.name} ${item.subtitle ?? ''}`}
                    onSelect={() => {
                      item.action();
                      close();
                    }}
                    style={{
                      padding: '5px 10px',
                      borderRadius: 'var(--radius-snug)',
                      cursor: 'pointer',
                      fontSize: 12.5,
                      color: 'var(--text-primary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.name}
                    </span>
                    {item.subtitle && (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
                        {item.subtitle}
                      </span>
                    )}
                    {item.shortcut && (
                      <span style={{ display: 'inline-flex', gap: 3, flexShrink: 0 }}>
                        {item.shortcut.map((k, i) => (
                          <Kbd key={i}>{k}</Kbd>
                        ))}
                      </span>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
        <style>{`
          [cmdk-group] {
            padding: 0 6px;
          }
          [cmdk-group-heading] {
            padding: 8px 4px 4px;
            font-size: 9.5px;
            font-weight: 500;
            color: var(--text-muted);
            letter-spacing: 0.18em;
            text-transform: uppercase;
            border-bottom: 1px solid var(--border);
            margin-bottom: 4px;
          }
          [cmdk-item][data-selected="true"] {
            background-color: var(--bg-hover);
            box-shadow: inset 3px 0 0 var(--accent-amber);
            color: var(--text-primary);
          }
        `}</style>
      </div>
    </div>
  );
}
