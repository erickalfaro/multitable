import { useEffect, useRef, useState } from 'react';
import { GitBranch, Plus, Check } from 'lucide-react';
import { api } from '../../../lib/api';
import type { GitBranchList } from '../../../lib/types';
import { Modal } from '../../ui';

interface Props {
  open: boolean;
  projectId: string;
  current: string | null;
  onClose: () => void;
  onSwitch: (branch: string) => void;
  onCreate: (name: string) => void;
}

export function GitBranchQuickPick({
  open,
  projectId,
  current,
  onClose,
  onSwitch,
  onCreate,
}: Props) {
  const [branches, setBranches] = useState<GitBranchList | null>(null);
  const [filter, setFilter] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.git
      .branches(projectId)
      .then((b) => {
        if (!cancelled) setBranches(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  useEffect(() => {
    if (open) {
      setFilter('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const localBranches = branches?.local ?? [];
  const remoteBranches = branches?.remotes ?? [];

  const q = filter.trim().toLowerCase();
  const matchLocal = q
    ? localBranches.filter((b) => b.toLowerCase().includes(q))
    : localBranches;
  const matchRemote = q
    ? remoteBranches.filter((b) => b.toLowerCase().includes(q))
    : remoteBranches;

  const canCreate = q.length > 0 && !localBranches.some((b) => b.toLowerCase() === q);

  const handleCreate = () => {
    const name = filter.trim();
    if (!name) return;
    onCreate(name);
    onClose();
  };

  const handlePick = (branch: string) => {
    if (branch === current) {
      onClose();
      return;
    }
    onSwitch(branch);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Switch Branch" width={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input
          ref={inputRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (matchLocal.length > 0) handlePick(matchLocal[0]);
              else if (canCreate) handleCreate();
            }
          }}
          placeholder="Filter branches, or type a new name…"
          style={{
            width: '100%',
            padding: '6px 10px',
            fontSize: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            backgroundColor: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-snug)',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />

        <div
          className="mt-scroll"
          style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
        >
          {canCreate && (
            <Row
              onClick={handleCreate}
              icon={<Plus size={12} color="var(--accent-blue)" />}
              label={`Create branch '${filter.trim()}'`}
              kind="action"
            />
          )}

          {matchLocal.length > 0 && (
            <GroupHeader>Local Branches</GroupHeader>
          )}
          {matchLocal.map((b) => (
            <Row
              key={`local:${b}`}
              onClick={() => handlePick(b)}
              icon={<GitBranch size={12} color="var(--text-muted)" />}
              label={b}
              current={b === current}
            />
          ))}

          {matchRemote.length > 0 && (
            <GroupHeader>Remote Branches</GroupHeader>
          )}
          {matchRemote.map((b) => (
            <Row
              key={`remote:${b}`}
              onClick={() => {
                // Checkout creates a local tracking branch with the same name.
                const local = b.replace(/^origin\//, '').replace(/^[^/]+\//, '');
                onSwitch(local);
                onClose();
              }}
              icon={<GitBranch size={12} color="var(--text-muted)" />}
              label={b}
              dim
            />
          ))}

          {!branches && (
            <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)' }}>
              Loading branches…
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Row({
  onClick,
  icon,
  label,
  current,
  dim,
  kind,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  current?: boolean;
  dim?: boolean;
  kind?: 'action';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: dim ? 'var(--text-muted)' : 'var(--text-primary)',
        fontWeight: current ? 600 : kind === 'action' ? 500 : 400,
        backgroundColor: current ? 'var(--bg-hover)' : 'transparent',
        border: 'none',
        textAlign: 'left',
        cursor: 'pointer',
        width: '100%',
      }}
      onMouseEnter={(e) => {
        if (!current) e.currentTarget.style.backgroundColor = 'var(--bg-sidebar)';
      }}
      onMouseLeave={(e) => {
        if (!current) e.currentTarget.style.backgroundColor = 'transparent';
      }}
    >
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {current && <Check size={12} color="var(--accent-blue)" />}
    </button>
  );
}

function GroupHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '6px 10px 2px',
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        color: 'var(--text-muted)',
      }}
    >
      {children}
    </div>
  );
}
