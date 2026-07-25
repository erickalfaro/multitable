import React, { useEffect, useState } from 'react';
import { GripHorizontal, Maximize2 } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { wsClient } from '../../lib/ws';
import type { PermissionPrompt } from '../../lib/types';
import { Modal } from '../ui/Modal';
import { PermissionCard } from '../command-console/shared/PermissionCard';
import { AskQuestionCard } from '../command-console/shared/AskQuestionCard';

/**
 * The single per-session option/permission panel — the unified surface for
 * BOTH kinds of "pick an option" prompt:
 *
 *  - Blocking `AskUserQuestion` / permission prompts (store slice
 *    `pendingPermissions`), resolved via the shared cards' default handlers.
 *  - Post-turn detected numbered-list options (store slice `optionsBySession`),
 *    normalized into the same `AskQuestionCard` look but resolved by sending a
 *    new turn (`sendTurn` + `dismissOption`) — injected here as overrides.
 *
 * The panel floats above the composer, can be dragged out of the way to read
 * the chat, and expands into a full-screen `Modal` when a long option set would
 * otherwise be cut off. The old App-root `OptionSelector` is gone — this is the
 * only surface.
 *
 * Public API (`PermissionBar({ sessionId })`) is unchanged.
 */
interface PermissionBarProps {
  sessionId?: string;
}

// True when a keystroke is being typed into an editable surface — the numeric /
// Escape shortcuts below must not hijack the composer. (Ported from the old
// OptionSelector.)
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

export function PermissionBar({ sessionId }: PermissionBarProps = {}) {
  const pendingPermissions = useAppStore((s) => s.pendingPermissions);
  const optionsBySession = useAppStore((s) => s.optionsBySession);
  const clearSessionOptions = useAppStore((s) => s.clearSessionOptions);

  const filtered = sessionId
    ? pendingPermissions.filter((p) => p.sessionId === sessionId)
    : pendingPermissions;
  const detected = sessionId ? optionsBySession[sessionId] ?? null : null;

  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [expanded, setExpanded] = useState(false);

  const chooseDetected = (text: string | undefined) => {
    if (!sessionId) return;
    if (text) wsClient.sendTurn(sessionId, text);
    clearSessionOptions(sessionId);
    wsClient.dismissOption(sessionId); // also drop it server-side so it doesn't re-hydrate
  };
  const skipDetected = () => {
    if (!sessionId) return;
    clearSessionOptions(sessionId);
    wsClient.dismissOption(sessionId);
  };

  // Keyboard fast-path for detected options only (ported from OptionSelector):
  // 1–N pick, Esc dismiss. Gated to when detected options are the sole card so
  // number keys are never ambiguous against a blocking question. The expanded
  // modal owns its own Esc (close), so skip when expanded.
  useEffect(() => {
    if (!detected || filtered.length > 0 || expanded) return;
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === 'Escape') {
        skipDetected();
        return;
      }
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= detected.options.length) {
        chooseDetected(detected.options[n - 1]);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detected, filtered.length, expanded, sessionId]);

  if (filtered.length === 0 && !detected) return null;

  // Adapt the flat detected OptionPrompt into the shared card's shape: one
  // single-select question, options as bare labels.
  const detectedPrompt: PermissionPrompt | null =
    detected && sessionId
      ? {
          id: `detected:${sessionId}`,
          sessionId,
          claudeSessionId: '',
          toolName: 'DetectedOptions',
          toolInput: {},
          createdAt: 0,
          kind: 'ask-question',
          questions: [
            {
              question: detected.question,
              multiSelect: false,
              options: detected.options.map((o) => ({ label: o })),
            },
          ],
        }
      : null;

  const cards = (
    <>
      {filtered.map((prompt) =>
        prompt.kind === 'ask-question' ? (
          <AskQuestionCard key={prompt.id} prompt={prompt} />
        ) : (
          <PermissionCard key={prompt.id} prompt={prompt} />
        ),
      )}
      {detectedPrompt && (
        <AskQuestionCard
          key={detectedPrompt.id}
          prompt={detectedPrompt}
          onSubmit={(sel) => chooseDetected(sel[0]?.[0])}
          onSkip={skipDetected}
        />
      )}
    </>
  );

  if (expanded) {
    return (
      <Modal
        open
        onClose={() => setExpanded(false)}
        title="Options"
        width="min(720px, 92vw)"
      >
        {cards}
      </Modal>
    );
  }

  // Drag by the header handle. Tracks a viewport-pixel offset applied on top of
  // the base bottom-center anchor. ponytail: no off-screen clamp — add a bounds
  // check if it turns out easy to lose the panel behind the viewport edge.
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
    const move = (ev: PointerEvent) =>
      setOffset({ x: start.ox + (ev.clientX - start.px), y: start.oy + (ev.clientY - start.py) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className="mt-scroll mt-glass-strong"
      // Blocking action — high opacity, never auto-hides. An accent ring lifts
      // it above the chat so it reads as "you must act". Draggable by the
      // header; expandable to a full-screen modal.
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 6,
        width: 'min(460px, calc(100% - 12px))',
        transform: `translate(calc(-50% + ${offset.x}px), ${offset.y}px)`,
        padding: 6,
        borderRadius: 'var(--radius-comfortable)',
        boxShadow:
          'var(--glass-shadow), 0 0 0 1px color-mix(in oklch, var(--accent) 35%, transparent)',
        zIndex: 10,
        maxHeight: '70%',
        overflowY: 'auto',
        animation: 'mt-slide-up var(--dur-med) var(--ease-out)',
      }}
    >
      <div
        onPointerDown={startDrag}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 4px 6px',
          cursor: 'grab',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          touchAction: 'none',
        }}
      >
        <GripHorizontal size={13} style={{ color: 'var(--text-muted)' }} />
        <span
          style={{
            flex: 1,
            fontSize: 9,
            fontWeight: 500,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.16em',
          }}
        >
          Options
        </span>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          onPointerDown={(e) => e.stopPropagation()}
          title="Expand"
          aria-label="Expand options"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            border: 'none',
            borderRadius: 'var(--radius-snug)',
            background: 'transparent',
            color: 'var(--text-muted)',
            cursor: 'pointer',
          }}
        >
          <Maximize2 size={13} />
        </button>
      </div>
      {cards}
    </div>
  );
}
