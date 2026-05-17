import React from 'react';
import { FolderTree } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { SidebarSection } from './SidebarSection';

interface Props {
  projectId: string;
}

export function SidebarFileViewerSection({ projectId }: Props) {
  const isSelected = useAppStore((s) => s.selectedFileViewerProjectId === projectId);
  const setSelectedFileViewer = useAppStore((s) => s.setSelectedFileViewer);

  const className = 'mt-sidebar-item' + (isSelected ? ' is-selected' : '');

  return (
    <SidebarSection title="FILE VIEWER">
      <div
        className={className}
        onClick={() => setSelectedFileViewer(projectId)}
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
          <FolderTree size={12} />
        </div>
        <div style={{ marginLeft: 10, flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: 'block',
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
            File Viewer
          </span>
        </div>
      </div>
    </SidebarSection>
  );
}
