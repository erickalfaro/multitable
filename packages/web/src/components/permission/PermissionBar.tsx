import React, { useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { wsClient } from '../../lib/ws';
import type { PermissionPrompt } from '../../lib/types';
import { Button } from '../ui';
import { ToolInputPreview } from './ToolInputPreview';

function PermissionCard({ prompt }: { prompt: PermissionPrompt }) {
  const removePermission = useAppStore(s => s.removePermission);

  const respond = (decision: 'allow' | 'deny' | 'always-allow') => {
    wsClient.respondPermission(prompt.id, decision);
    removePermission(prompt.id);
  };

  return (
    <div
      style={{
        position: 'relative',
        backgroundColor: 'var(--bg-elevated)',
        padding: '14px 14px 12px',
        marginBottom: 8,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 8,
          left: 12,
          fontSize: 9.5,
          color: 'var(--accent-amber)',
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          fontWeight: 500,
        }}
      >
        permission · {prompt.toolName}
      </span>
      <span
        style={{
          position: 'absolute',
          top: 8,
          right: 12,
          fontSize: 9.5,
          color: 'var(--text-faint)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {prompt.sessionId.slice(0, 12)}
      </span>
      <div style={{ marginTop: 18, marginBottom: 10 }}>
        <ToolInputPreview toolName={prompt.toolName} input={prompt.toolInput} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <Button size="sm" variant="primary" onClick={() => respond('allow')}>
          Allow
        </Button>
        <Button size="sm" variant="secondary" onClick={() => respond('always-allow')}>
          Always Allow
        </Button>
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="danger" onClick={() => respond('deny')}>
          Deny
        </Button>
      </div>
    </div>
  );
}

const HEX_RE = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;

/**
 * Compact preview renderer. Detects lines that contain a hex color and
 * renders a color swatch; falls back to plain monospace for other text.
 */
function Preview({ text }: { text: string }) {
  const lines = text.split('\n');
  const anyHex = lines.some(l => HEX_RE.test(l));

  if (!anyHex) {
    return (
      <pre
        className="mt-scroll"
        style={{
          fontSize: 10,
          color: 'var(--text-muted)',
          margin: '4px 0 0',
          padding: '4px 6px',
          backgroundColor: 'var(--bg-sidebar)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          // pre-wrap (not pre) so long preview lines wrap instead of forcing
          // the option wider than the screen and clipping it.
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          overflowY: 'auto',
          maxHeight: 72,
        }}
      >
        {text}
      </pre>
    );
  }

  // Palette preview: collect hex colors and render as a swatch strip.
  const swatches: Array<{ hex: string; label: string }> = [];
  for (const line of lines) {
    const m = line.match(HEX_RE);
    if (!m) continue;
    const hex = m[0];
    const label = line.split(':')[0]?.trim() || '';
    swatches.push({ hex, label });
  }

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
        marginTop: 6,
        padding: 6,
        backgroundColor: 'var(--bg-sidebar)',
      }}
    >
      {swatches.map((s, i) => (
        <div
          key={i}
          title={`${s.label}: ${s.hex}`}
          style={{
            width: 18,
            height: 18,
            borderRadius: 'var(--radius-snug)',
            backgroundColor: s.hex,
            border: '1px solid color-mix(in srgb, var(--text-primary) 20%, transparent)',
            flexShrink: 0,
          }}
        />
      ))}
    </div>
  );
}

function AskQuestionCard({ prompt }: { prompt: PermissionPrompt }) {
  const removePermission = useAppStore(s => s.removePermission);
  const questions = prompt.questions ?? [];

  // selections[i] = array of chosen labels for question i
  const [selections, setSelections] = useState<string[][]>(() =>
    questions.map(() => [])
  );

  const toggle = (qIdx: number, label: string, multi: boolean) => {
    setSelections(prev => {
      const next = prev.map(arr => arr.slice());
      const cur = next[qIdx] || [];
      if (multi) {
        next[qIdx] = cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label];
      } else {
        next[qIdx] = cur.includes(label) ? [] : [label];
      }
      return next;
    });
  };

  const allAnswered = questions.every((_, i) => (selections[i]?.length ?? 0) > 0);

  const submit = () => {
    wsClient.answerQuestion(prompt.id, selections);
    removePermission(prompt.id);
  };

  const skip = () => {
    wsClient.answerQuestion(prompt.id, questions.map(() => []));
    removePermission(prompt.id);
  };

  return (
    <div
      style={{
        backgroundColor: 'var(--bg-elevated)',
        padding: '8px 10px',
        marginBottom: 8,
      }}
    >
      <div
        style={{
          fontSize: 9.5,
          color: 'var(--accent-amber)',
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          fontWeight: 500,
          marginBottom: 8,
        }}
      >
        question
      </div>

      {questions.map((q, qIdx) => {
        const multi = !!q.multiSelect;
        const picked = selections[qIdx] ?? [];
        return (
          <div key={qIdx} style={{ marginBottom: qIdx < questions.length - 1 ? 12 : 6 }}>
            {q.header && (
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 }}>
                {q.header}
              </div>
            )}
            <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 6, fontWeight: 500, overflowWrap: 'anywhere' }}>
              {q.question}
              {multi && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>(select multiple)</span>}
            </div>
            {/* Single-column list: can't overflow at any width — minimal and
                fully responsive without column-width math. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {q.options.map((opt, oIdx) => {
                const selected = picked.includes(opt.label);
                return (
                  <label
                    key={oIdx}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      padding: '6px 8px',
                      minWidth: 0,
                      border: `1px solid ${selected ? 'var(--accent-amber)' : 'var(--border-strong)'}`,
                      borderRadius: 'var(--radius-snug)',
                      backgroundColor: selected ? 'color-mix(in srgb, var(--accent-amber) 10%, transparent)' : 'transparent',
                      cursor: 'pointer',
                      transition: 'background-color 0.12s, border-color 0.12s',
                    }}
                  >
                    <input
                      type={multi ? 'checkbox' : 'radio'}
                      name={`q-${prompt.id}-${qIdx}`}
                      checked={selected}
                      onChange={() => toggle(qIdx, opt.label, multi)}
                      style={{ marginTop: 2, flexShrink: 0 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: 'var(--text-primary)',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {opt.label}
                      </div>
                      {opt.description && (
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--text-secondary)',
                            marginTop: 2,
                            lineHeight: 1.35,
                            overflowWrap: 'anywhere',
                          }}
                        >
                          {opt.description}
                        </div>
                      )}
                      {opt.preview && <Preview text={opt.preview} />}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <Button size="sm" variant="primary" onClick={submit} disabled={!allAnswered}>
          Submit
        </Button>
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="secondary" onClick={skip}>
          Skip
        </Button>
      </div>
    </div>
  );
}

interface PermissionBarProps {
  sessionId?: string;
}

export function PermissionBar({ sessionId }: PermissionBarProps = {}) {
  const pendingPermissions = useAppStore(s => s.pendingPermissions);
  const filtered = sessionId
    ? pendingPermissions.filter(p => p.sessionId === sessionId)
    : pendingPermissions;
  if (filtered.length === 0) return null;
  return (
    <div
      className="mt-scroll"
      style={{
        position: 'absolute',
        left: 8,
        right: 8,
        bottom: 8,
        padding: 8,
        borderRadius: 'var(--radius-soft)',
        border: '1px solid var(--border-strong)',
        backgroundColor: 'var(--bg-sidebar)',
        boxShadow: 'none',
        zIndex: 10,
        maxHeight: '70%',
        overflowY: 'auto',
        animation: 'mt-slide-up var(--dur-med) var(--ease-out)',
      }}
    >
      {filtered.map(prompt =>
        prompt.kind === 'ask-question' ? (
          <AskQuestionCard key={prompt.id} prompt={prompt} />
        ) : (
          <PermissionCard key={prompt.id} prompt={prompt} />
        )
      )}
    </div>
  );
}
