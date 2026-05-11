import React from 'react';
import toast from 'react-hot-toast';
import { useAppStore } from '../../stores/appStore';
import { wsClient } from '../../lib/ws';
import { AttachButton } from '../main-pane/AttachButton';
import type { AttachmentKind } from '../../lib/attachments';

type Key = { label: string; input: string; title?: string };

// Ordered by mobile-terminal usage frequency: completion + history first,
// then cursor movement, then escape/stop, then line nav.
const KEYS: Key[] = [
  { label: 'Tab', input: '\t' },
  { label: '↑', input: '\x1b[A', title: 'Up' },
  { label: '↓', input: '\x1b[B', title: 'Down' },
  { label: '←', input: '\x1b[D', title: 'Left' },
  { label: '→', input: '\x1b[C', title: 'Right' },
  { label: '⎋', input: '\x1b', title: 'Esc' },
  { label: '⌃C', input: '\x03', title: 'Ctrl+C' },
  { label: 'Home', input: '\x1b[H' },
  { label: 'End', input: '\x1b[F' },
];

const buttonStyle: React.CSSProperties = {
  minWidth: 44,
  height: 40,
  padding: '0 10px',
  borderRadius: 'var(--radius-snug)',
  border: '1px solid var(--border-strong)',
  backgroundColor: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  flexShrink: 0,
  touchAction: 'manipulation',
  boxShadow: 'none',
  letterSpacing: '0.04em',
  transition:
    'background-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  whiteSpace: 'nowrap',
};

function onPressDown(e: React.TouchEvent<HTMLButtonElement> | React.MouseEvent<HTMLButtonElement>) {
  const el = e.currentTarget as HTMLButtonElement;
  el.style.transform = 'translateY(1px)';
  el.style.backgroundColor = 'var(--bg-hover)';
}
function onPressUp(e: React.TouchEvent<HTMLButtonElement> | React.MouseEvent<HTMLButtonElement>) {
  const el = e.currentTarget as HTMLButtonElement;
  el.style.transform = 'translateY(0)';
  el.style.backgroundColor = 'var(--bg-elevated)';
}

export function TouchToolbar() {
  const selectedProcessId = useAppStore(s => s.selectedProcessId);
  const attachKind = useAppStore((s): AttachmentKind | null => {
    if (!s.selectedProcessId) return null;
    if (s.sessions[s.selectedProcessId]) return 'session';
    if (s.terminals[s.selectedProcessId]) return 'terminal';
    return null;
  });
  // Sessions don't accept raw key input — pty-input is dropped for them — and
  // the chat composer has its own attach button. Render only for PTY-backed
  // processes (terminals and commands) where these keys actually do something.
  const isPty = useAppStore((s) => {
    if (!s.selectedProcessId) return false;
    return Boolean(s.terminals[s.selectedProcessId] || s.commands[s.selectedProcessId]);
  });

  if (!selectedProcessId || !isPty) return null;

  const sendKey = (input: string) => {
    wsClient.sendInput(selectedProcessId, input);
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) wsClient.sendInput(selectedProcessId, text);
    } catch {
      toast.error('Clipboard access denied');
    }
  };

  return (
    <div
      className="mt-scroll"
      style={{
        display: 'flex',
        height: 52,
        backgroundColor: 'var(--bg-statusbar)',
        borderTop: '1px solid var(--border)',
        alignItems: 'center',
        gap: 4,
        padding: '0 6px',
        overflowX: 'auto',
        flexShrink: 0,
      }}
    >
      {attachKind && (
        <AttachButton processId={selectedProcessId} kind={attachKind} variant="toolbar" />
      )}
      <button
        onClick={pasteFromClipboard}
        title="Paste"
        aria-label="Paste"
        style={buttonStyle}
        onTouchStart={onPressDown}
        onTouchEnd={onPressUp}
      >
        Paste
      </button>
      {KEYS.map(k => (
        <button
          key={k.label}
          onClick={() => sendKey(k.input)}
          title={k.title ?? k.label}
          aria-label={k.title ?? k.label}
          style={buttonStyle}
          onTouchStart={onPressDown}
          onTouchEnd={onPressUp}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
