import React from 'react';
import { X, GitBranch } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { IconButton } from '../../ui';
import { GitPanel } from './GitPanel';

interface Props {
  projectId: string;
}

export function GitMainView({ projectId }: Props) {
  const project = useAppStore((s) => s.projects.find((p) => p.id === projectId));
  const setSelectedGitProject = useAppStore((s) => s.setSelectedGitProject);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        backgroundColor: 'var(--bg-primary)',
      }}
    >
      <div
        style={{
          height: 38,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 10px 0 14px',
          gap: 8,
          borderBottom: '1px solid var(--border)',
          backgroundColor: 'var(--bg-sidebar)',
        }}
      >
        <GitBranch size={13} style={{ color: 'var(--text-secondary)' }} />
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-primary)',
            letterSpacing: '0.01em',
          }}
        >
          Source Control
        </span>
        {project && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· {project.name}</span>
        )}
        <div style={{ flex: 1 }} />
        <IconButton size="sm" onClick={() => setSelectedGitProject(null)} label="Close source control">
          <X size={13} />
        </IconButton>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <GitPanel projectId={projectId} />
      </div>
    </div>
  );
}
