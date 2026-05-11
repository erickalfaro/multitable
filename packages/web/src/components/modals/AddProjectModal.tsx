import React, { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { api } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';
import toast from 'react-hot-toast';
import { Modal, Input, Button } from '../ui';
import { PastAgentsBrowser } from './PastAgentsBrowser';

interface Props {
  onClose: () => void;
}

// file:///home/me/project → /home/me/project
// file:///C:/Users/me/project → C:/Users/me/project
function fileUriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:') return uri;
    let p = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p;
  } catch {
    return uri;
  }
}

function extractDroppedPath(dt: DataTransfer): string | null {
  const uriList = dt.getData('text/uri-list');
  if (uriList) {
    const first = uriList
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    if (first) return fileUriToPath(first);
  }
  const text = dt.getData('text/plain').trim();
  if (text) return text.startsWith('file:') ? fileUriToPath(text) : text;
  return null;
}

export function AddProjectModal({ onClose }: Props) {
  const [dirPath, setDirPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const store = useAppStore();

  const handleAdd = async () => {
    if (!dirPath.trim()) return;
    setLoading(true);
    try {
      const project = await api.projects.create({ path: dirPath.trim() });
      store.addProject(project);
      store.expandProject(project.id);
      store.setProjectOverviewOpen(true);
      toast.success(`Project "${project.name}" added`);
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to add project');
    } finally {
      setLoading(false);
    }
  };

  const handleBrowse = async () => {
    setBrowsing(true);
    try {
      const { path } = await api.projects.browse();
      if (path) setDirPath(path);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to open folder picker');
    } finally {
      setBrowsing(false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLInputElement>) => {
    const path = extractDroppedPath(e.dataTransfer);
    if (path) {
      e.preventDefault();
      setDirPath(path);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleAdd();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add Project"
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleAdd}
            disabled={!dirPath.trim()}
            loading={loading}
          >
            {loading ? 'Adding...' : 'Add Project'}
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        value={dirPath}
        onChange={(e) => setDirPath(e.target.value)}
        onKeyDown={handleKeyDown}
        onDrop={handleDrop}
        placeholder="Drop, paste, or pick a folder"
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          boxShadow: 'none',
          outline: 'none',
        }}
        wrapperStyle={{
          boxShadow: 'none',
          border: '1px solid var(--border)',
        }}
        rightIcon={
          <button
            type="button"
            onClick={handleBrowse}
            disabled={browsing}
            title="Browse for folder"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'none',
              border: 'none',
              padding: 4,
              margin: -4,
              borderRadius: 'var(--radius-snug)',
              color: 'var(--text-muted)',
              cursor: browsing ? 'default' : 'pointer',
            }}
          >
            <FolderOpen size={14} />
          </button>
        }
      />
      <div
        style={{
          marginTop: 16,
          paddingTop: 12,
          borderTop: '1px solid var(--border)',
        }}
      >
        <div
          style={{
            fontSize: 9.5,
            fontWeight: 500,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
            marginBottom: 8,
          }}
        >
          Or pick from past agents
        </div>
        <PastAgentsBrowser onClose={onClose} />
      </div>
    </Modal>
  );
}
