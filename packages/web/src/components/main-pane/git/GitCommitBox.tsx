import { useState } from 'react';
import { Sparkles } from 'lucide-react';

interface Props {
  stagedCount: number;
  onCommit: (message: string) => Promise<void> | void;
  onGenerateMessage: () => Promise<string | null>;
}

export function GitCommitBox({ stagedCount, onCommit, onGenerateMessage }: Props) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);

  const canCommit = stagedCount > 0 && message.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canCommit) return;
    setBusy(true);
    try {
      await onCommit(message);
      setMessage('');
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const generate = async () => {
    if (stagedCount === 0 || generating) return;
    setGenerating(true);
    try {
      const m = await onGenerateMessage();
      if (m) setMessage(m);
    } finally {
      setGenerating(false);
    }
  };

  const buttonLabel = stagedCount === 0
    ? 'Commit'
    : `Commit ${stagedCount} file${stagedCount === 1 ? '' : 's'}`;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 10,
        borderBottom: '1px solid var(--border)',
        backgroundColor: 'var(--bg-primary)',
      }}
    >
      <div style={{ position: 'relative' }}>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message (Ctrl+Enter to commit)"
          rows={2}
          style={{
            width: '100%',
            padding: '6px 30px 6px 8px',
            fontSize: 12,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            backgroundColor: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-snug)',
            resize: 'none',
            outline: 'none',
            boxSizing: 'border-box',
          }}
          disabled={busy}
        />
        <button
          type="button"
          onClick={() => void generate()}
          title={stagedCount === 0 ? 'Stage files to generate a message' : 'Generate Commit Message'}
          disabled={stagedCount === 0 || generating || busy}
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            width: 22,
            height: 22,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            cursor: stagedCount === 0 ? 'default' : 'pointer',
            color: stagedCount === 0 ? 'var(--text-muted)' : 'var(--accent-amber)',
            opacity: stagedCount === 0 ? 0.4 : 1,
            borderRadius: 'var(--radius-snug)',
          }}
        >
          <Sparkles
            size={13}
            style={{
              animation: generating ? 'mt-pulse 1.2s ease-in-out infinite' : undefined,
            }}
          />
        </button>
      </div>
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canCommit}
        style={{
          padding: '6px 10px',
          fontSize: 12,
          fontWeight: 500,
          textAlign: 'center',
          backgroundColor: canCommit ? 'var(--accent-blue)' : 'transparent',
          color: canCommit ? 'white' : 'var(--text-muted)',
          border: canCommit ? '1px solid var(--accent-blue)' : '1px solid var(--border)',
          borderRadius: 'var(--radius-snug)',
          cursor: canCommit ? 'pointer' : 'default',
        }}
      >
        {busy ? 'Committing…' : buttonLabel}
      </button>
    </div>
  );
}
