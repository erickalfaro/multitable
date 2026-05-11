import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import type { Project } from '../../lib/types';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';

interface Props {
  project: Project;
  shortcut?: string;
  expanded: boolean;
  focused: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
}

export function ProjectHeader({
  project,
  shortcut,
  expanded,
  focused,
  onToggle,
  onSelect,
  onContextMenu,
  editing = false,
  onEditingChange,
}: Props) {
  const [hover, setHover] = useState(false);
  const [toggleHover, setToggleHover] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const updateProject = useAppStore((s) => s.updateProject);

  useEffect(() => {
    if (editing) {
      setDraft(project.name);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, project.name]);

  const commitEdit = async () => {
    const trimmed = draft.trim();
    if (saving) return;
    if (!trimmed || trimmed === project.name) {
      onEditingChange?.(false);
      return;
    }
    setSaving(true);
    try {
      const updated = await api.projects.update(project.id, { name: trimmed });
      updateProject(updated);
    } catch {
      toast.error('Failed to rename project');
    } finally {
      setSaving(false);
      onEditingChange?.(false);
    }
  };

  const cancelEdit = () => {
    setDraft(project.name);
    onEditingChange?.(false);
  };

  return (
    <div
      onClick={editing ? undefined : onSelect}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={project.path}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '6px 10px',
        cursor: editing ? 'text' : 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        backgroundColor: focused
          ? 'var(--bg-elevated)'
          : hover
            ? 'var(--bg-hover)'
            : 'transparent',
        transition: 'background-color var(--dur-fast) var(--ease-out)',
      }}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        onMouseEnter={() => setToggleHover(true)}
        onMouseLeave={() => setToggleHover(false)}
        title={expanded ? 'Collapse' : 'Expand'}
        aria-label={expanded ? 'Collapse project' : 'Expand project'}
        aria-expanded={expanded}
        style={{
          width: 22,
          height: 22,
          marginRight: 8,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: toggleHover ? 'var(--bg-hover)' : 'transparent',
          border: '1px solid transparent',
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
          color: toggleHover ? 'var(--text-primary)' : 'var(--text-muted)',
          padding: 0,
          transition:
            'background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
        }}
      >
        <ChevronRight
          size={14}
          style={{
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform var(--dur-fast) var(--ease-out)',
          }}
        />
      </button>
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitEdit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelEdit();
            }
          }}
          onBlur={commitEdit}
          disabled={saving}
          style={{
            flex: 1,
            fontSize: 15,
            fontWeight: 600,
            color: 'var(--text-primary)',
            background: 'var(--bg-input, var(--bg-elevated))',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-snug)',
            padding: '1px 4px',
            margin: 0,
            outline: 'none',
            boxShadow: 'none',
            fontFamily: 'inherit',
            minWidth: 0,
          }}
        />
      ) : (
        <span
          onDoubleClick={(e) => {
            e.stopPropagation();
            onEditingChange?.(true);
          }}
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            color: 'var(--text-primary)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {project.name}
        </span>
      )}
      {shortcut && !editing && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{shortcut}</span>
      )}
    </div>
  );
}
