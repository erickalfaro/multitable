import { useState } from 'react';

interface Props {
  stagedCount: number;
  hasAnyChanges: boolean;
  onCommit: (message: string) => void | Promise<void>;
  onStash: () => void | Promise<void>;
  onStashPop: () => void | Promise<void>;
}

export function GitCommitComposer({
  stagedCount,
  hasAnyChanges,
  onCommit,
  onStash,
  onStashPop,
}: Props) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const canCommit = stagedCount > 0 && message.trim().length > 0 && !busy;

  const handleCommit = async () => {
    if (!canCommit) return;
    setBusy(true);
    try {
      await onCommit(message.trim());
      setMessage('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        backgroundColor: 'var(--bg-primary)',
      }}
    >
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={
          stagedCount === 0
            ? 'Stage files to commit…'
            : `Commit message (${stagedCount} staged)`
        }
        disabled={stagedCount === 0 || busy}
        rows={2}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void handleCommit();
          }
        }}
        style={{
          width: '100%',
          padding: '6px 10px',
          fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          backgroundColor: 'var(--bg-secondary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-snug)',
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => void handleCommit()}
          disabled={!canCommit}
          style={{
            ...primaryBtn,
            opacity: canCommit ? 1 : 0.5,
            cursor: canCommit ? 'pointer' : 'not-allowed',
          }}
        >
          {busy ? 'Committing…' : 'Commit'}
        </button>
        <button
          type="button"
          onClick={() => void onStash()}
          disabled={!hasAnyChanges || busy}
          title="Stash all working-tree changes"
          style={{
            ...secondaryBtn,
            opacity: hasAnyChanges ? 1 : 0.5,
            cursor: hasAnyChanges ? 'pointer' : 'not-allowed',
          }}
        >
          Stash
        </button>
        <button
          type="button"
          onClick={() => void onStashPop()}
          disabled={busy}
          title="Pop the most recent stash"
          style={secondaryBtn}
        >
          Stash Pop
        </button>
      </div>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 600,
  backgroundColor: 'var(--accent-blue)',
  color: 'white',
  border: 'none',
  borderRadius: 'var(--radius-snug)',
};

const secondaryBtn: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  backgroundColor: 'var(--bg-hover)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-snug)',
  cursor: 'pointer',
};
