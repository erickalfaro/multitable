import React, { useState } from 'react';
import { useAppStore } from '../../../stores/appStore';
import { wsClient } from '../../../lib/ws';
import type { PermissionPrompt } from '../../../lib/types';
import { Button } from '../../ui';
import { severityEmphasis, categoryIcon, CATEGORY_COLOR_VAR } from '../../../lib/alertVisuals';

const HEX_RE = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;

/** Compact preview renderer (hex-swatch detector + prose fallback). */
function Preview({ text }: { text: string }) {
  const lines = text.split('\n');
  const anyHex = lines.some((l) => HEX_RE.test(l));

  if (!anyHex) {
    return (
      <div
        className="mt-scroll"
        style={{
          fontSize: 10.5,
          lineHeight: 1.4,
          color: 'var(--text-muted)',
          marginTop: 5,
          paddingLeft: 9,
          borderLeft: '2px solid var(--border-strong)',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          overflowY: 'auto',
          maxHeight: 120,
        }}
      >
        {text}
      </div>
    );
  }

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

/**
 * Shared ask-question card — rendered by both the per-session `PermissionBar`
 * and the Command Console. Selections live in local state keyed by `prompt.id`
 * so unmount/remount across surfaces preserves the user's answers; resolution
 * goes through `wsClient.answerQuestion` + the same `removePermission` slice
 * the regular permission flow uses.
 */
export function AskQuestionCard({
  prompt,
  compact = false,
  onSubmit,
  onSkip,
}: {
  prompt: PermissionPrompt;
  compact?: boolean;
  // Override resolution. Detected-option cards (post-turn numbered lists) reply
  // by sending a new turn instead of answering a blocking tool call, so the
  // unified panel injects its own submit/skip. Defaults keep the blocking
  // AskUserQuestion behavior.
  onSubmit?: (selections: string[][]) => void;
  onSkip?: () => void;
}) {
  const removePermission = useAppStore((s) => s.removePermission);
  const questions = prompt.questions ?? [];

  // selections[i] = array of chosen labels for question i
  const [selections, setSelections] = useState<string[][]>(() => questions.map(() => []));

  const toggle = (qIdx: number, label: string, multi: boolean) => {
    setSelections((prev) => {
      const next = prev.map((arr) => arr.slice());
      const cur = next[qIdx] || [];
      if (multi) {
        next[qIdx] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
      } else {
        next[qIdx] = cur.includes(label) ? [] : [label];
      }
      return next;
    });
  };

  const allAnswered = questions.every((_, i) => (selections[i]?.length ?? 0) > 0);

  const submit = () => {
    if (onSubmit) {
      onSubmit(selections);
      return;
    }
    wsClient.answerQuestion(prompt.id, selections);
    removePermission(prompt.id);
  };

  const skip = () => {
    if (onSkip) {
      onSkip();
      return;
    }
    wsClient.answerQuestion(
      prompt.id,
      questions.map(() => []),
    );
    removePermission(prompt.id);
  };

  return (
    <div
      style={{
        // Same severity/category split as PermissionCard — elicitation-style
        // questions are also blocking, so we tint with attention.
        ...severityEmphasis('attention'),
        padding: compact ? '6px 8px 6px 11px' : '6px 8px 6px 11px',
        marginBottom: 6,
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 9,
          color: CATEGORY_COLOR_VAR.elicitation,
          textTransform: 'uppercase',
          letterSpacing: '0.16em',
          fontWeight: 500,
          marginBottom: 4,
        }}
      >
        {categoryIcon('elicitation', 10)}
        <span>question</span>
      </div>

      {questions.map((q, qIdx) => {
        const multi = !!q.multiSelect;
        const picked = selections[qIdx] ?? [];
        return (
          <div key={qIdx} style={{ marginBottom: qIdx < questions.length - 1 ? 10 : 4 }}>
            {q.header && (
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginBottom: 2,
                }}
              >
                {q.header}
              </div>
            )}
            <div
              style={{
                fontSize: 12.5,
                color: 'var(--text-primary)',
                marginBottom: 5,
                fontWeight: 500,
                lineHeight: 1.3,
                overflowWrap: 'anywhere',
              }}
            >
              {q.question}
              {multi && (
                <span
                  style={{
                    marginLeft: 6,
                    fontSize: 11,
                    fontWeight: 400,
                    color: 'var(--text-muted)',
                  }}
                >
                  (select multiple)
                </span>
              )}
            </div>
            {/* Single-column list: can't overflow at any width — minimal and
                fully responsive without column-width math. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {q.options.map((opt, oIdx) => {
                const selected = picked.includes(opt.label);
                return (
                  <label
                    key={oIdx}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 7,
                      padding: '4px 7px',
                      minWidth: 0,
                      border: `1px solid ${selected ? 'var(--accent-amber)' : 'var(--border-strong)'}`,
                      borderRadius: 'var(--radius-snug)',
                      backgroundColor: selected
                        ? 'color-mix(in srgb, var(--accent-amber) 10%, transparent)'
                        : 'transparent',
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
                            marginTop: 1,
                            lineHeight: 1.3,
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

      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
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
