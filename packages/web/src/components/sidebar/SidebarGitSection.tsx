import React from 'react';
import { GitBranch } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { SidebarSection } from './SidebarSection';

interface Props {
  projectId: string;
}

export function SidebarGitSection({ projectId }: Props) {
  const status = useAppStore((s) => s.gitByProject[projectId]);
  const isSelected = useAppStore((s) => s.selectedGitProjectId === projectId);
  const setSelectedGitProject = useAppStore((s) => s.setSelectedGitProject);

  if (status && status.isRepo === false) return null;

  const unstagedCount = status ? status.unstaged.length + status.untracked.length : 0;
  const stagedCount = status ? status.staged.length : 0;
  const conflictedCount = status ? status.conflicted.length : 0;
  const totalChanges = unstagedCount + stagedCount + conflictedCount;
  const branch = status?.branch ?? null;

  const className = 'mt-sidebar-item' + (isSelected ? ' is-selected' : '');

  return (
    <SidebarSection title="SOURCE CONTROL">
      <div
        className={className}
        onClick={() => setSelectedGitProject(projectId)}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '4px 10px 4px 9px',
          margin: '1px 0',
          cursor: 'pointer',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          position: 'relative',
          borderRadius: 'var(--radius-snug)',
          backgroundColor: isSelected ? 'var(--bg-elevated)' : 'transparent',
          borderLeft: isSelected
            ? '3px solid var(--accent-amber)'
            : '3px solid transparent',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 12,
            flexShrink: 0,
            color: 'var(--text-secondary)',
          }}
        >
          <GitBranch size={12} />
        </div>
        <div style={{ marginLeft: 10, flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 13.5,
                lineHeight: 1.3,
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontWeight: isSelected ? 600 : 500,
              }}
            >
              Source Control
            </span>
            {status && totalChanges > 0 && (
              <span
                title={`${stagedCount} staged, ${unstagedCount} unstaged${conflictedCount ? `, ${conflictedCount} conflicted` : ''}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  marginLeft: 6,
                  padding: '1px 6px',
                  borderRadius: 'var(--radius-snug)',
                  background: 'transparent',
                  color: conflictedCount > 0 ? 'var(--accent-red, #e06c75)' : 'var(--accent-amber)',
                  border: `1px solid ${conflictedCount > 0 ? 'var(--accent-red, #e06c75)' : 'var(--accent-amber)'}`,
                  fontSize: 9.5,
                  fontWeight: 500,
                  letterSpacing: '0.04em',
                  flexShrink: 0,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {unstagedCount}+{stagedCount}
                {conflictedCount > 0 ? `!${conflictedCount}` : ''}
              </span>
            )}
            {status && totalChanges === 0 && (
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 10.5,
                  color: 'var(--text-faint)',
                  flexShrink: 0,
                }}
              >
                clean
              </span>
            )}
          </div>
          {branch && (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--text-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: 2,
              }}
            >
              {branch}
              {status && (status.ahead > 0 || status.behind > 0) && (
                <span style={{ marginLeft: 6, color: 'var(--text-faint)' }}>
                  {status.ahead > 0 ? `↑${status.ahead}` : ''}
                  {status.behind > 0 ? `↓${status.behind}` : ''}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </SidebarSection>
  );
}
