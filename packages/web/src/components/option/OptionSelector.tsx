import React, { useEffect } from 'react';
import { useAppStore } from '../../stores/appStore';
import { wsClient } from '../../lib/ws';
import { Button } from '../ui';

// True when a keystroke is being typed into an editable surface (composer,
// inputs). The numeric/Escape shortcuts below must not hijack those.
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable ||
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    !!el.closest?.('.cm-editor')
  );
}

export function OptionSelector() {
  const selectedProcessId = useAppStore((s) => s.selectedProcessId);
  const option = useAppStore((s) =>
    selectedProcessId ? s.optionsBySession[selectedProcessId] ?? null : null,
  );
  const clearSessionOptions = useAppStore((s) => s.clearSessionOptions);

  const sessionId = option?.sessionId ?? null;

  function choose(text: string) {
    if (!sessionId) return;
    // SDK sessions have no PTY — reply by sending the chosen option as a new
    // turn (the old wsClient.sendInput PTY write went nowhere).
    wsClient.sendTurn(sessionId, text);
    clearSessionOptions(sessionId);
  }

  function dismiss() {
    if (!sessionId) return;
    clearSessionOptions(sessionId);
    wsClient.dismissOption(sessionId); // also drop it server-side so it doesn't re-hydrate
  }

  // Keyboard shortcuts: 1–N to pick, Escape to dismiss. Skipped while typing so
  // they don't steal keystrokes from the composer.
  useEffect(() => {
    if (!option) return;
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === 'Escape') {
        dismiss();
        return;
      }
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= option.options.length) {
        choose(option.options[n - 1]);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [option, sessionId]);

  if (!option) return null;

  return (
    <div
      className="mt-glass-strong"
      style={{
        padding: '10px 14px',
        borderTop: '1px solid var(--glass-border)',
        animation: 'mt-slide-up var(--dur-med) var(--ease-out)',
      }}
    >
      <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 8, fontWeight: 500, userSelect: 'none', WebkitUserSelect: 'none' }}>
        {option.question}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {option.options.map((opt, i) => (
          <Button
            key={i}
            size="sm"
            variant={i === 0 ? 'primary' : 'secondary'}
            onClick={() => choose(opt)}
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
