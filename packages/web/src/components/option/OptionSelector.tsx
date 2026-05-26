import React, { useEffect } from 'react';
import { useAppStore } from '../../stores/appStore';
import { wsClient } from '../../lib/ws';
import { Button } from '../ui';

export function OptionSelector() {
  const { currentOption, setOption } = useAppStore();

  useEffect(() => {
    if (!currentOption) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOption(null);
        return;
      }
      const n = parseInt(e.key);
      if (n >= 1 && n <= currentOption.options.length) {
        wsClient.sendInput(currentOption.sessionId, `${n}\r`);
        setOption(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentOption, setOption]);

  // Auto-clear on new PTY output
  useEffect(() => {
    if (!currentOption) return;
    const off = wsClient.on('pty-output', (msg) => {
      if (msg.processId === currentOption.sessionId) setOption(null);
    });
    return off;
  }, [currentOption, setOption]);

  if (!currentOption) return null;

  return (
    <div
      style={{
        padding: '10px 14px',
        borderTop: '1px solid var(--border)',
        backgroundColor: 'var(--bg-statusbar)',
        animation: 'mt-slide-up var(--dur-med) var(--ease-out)',
      }}
    >
      <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 8, fontWeight: 500, userSelect: 'none', WebkitUserSelect: 'none' }}>
        {currentOption.question}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {currentOption.options.map((opt, i) => (
          <Button
            key={i}
            size="sm"
            variant={i === 0 ? 'primary' : 'secondary'}
            onClick={() => {
              wsClient.sendInput(currentOption.sessionId, `${i + 1}\r`);
              setOption(null);
            }}
            // Let long options wrap instead of overflowing the viewport on
            // small screens — the container already wraps rows (flexWrap), this
            // wraps text within a single oversized option. Short options keep
            // their pill height via minHeight.
            style={{
              maxWidth: '100%',
              whiteSpace: 'normal',
              height: 'auto',
              minHeight: 24,
              paddingTop: 3,
              paddingBottom: 3,
              textAlign: 'left',
            }}
          >
            <span style={{ opacity: 0.7, marginRight: 4, fontVariantNumeric: 'tabular-nums' }}>
              {i + 1}.
            </span>
            {opt}
          </Button>
        ))}
      </div>
    </div>
  );
}
