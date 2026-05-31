import React from 'react';
import { useAppStore } from '../../stores/appStore';
import { PermissionCard } from '../command-console/shared/PermissionCard';
import { AskQuestionCard } from '../command-console/shared/AskQuestionCard';

/**
 * Per-session permission/ask-question bar — anchored above the composer in
 * each agent view. The card UIs themselves now live under
 * `components/command-console/shared/`, so this surface and the global
 * Command Console render the exact same cards. Resolving from either one
 * removes the prompt from the shared `pendingPermissions` store slice, which
 * clears it in both places automatically.
 *
 * Public API (`PermissionBar({ sessionId })`) is unchanged — `TerminalView`,
 * `SessionChat`, and any other callers continue to work without edits.
 */
interface PermissionBarProps {
  sessionId?: string;
}

export function PermissionBar({ sessionId }: PermissionBarProps = {}) {
  const pendingPermissions = useAppStore((s) => s.pendingPermissions);
  const filtered = sessionId
    ? pendingPermissions.filter((p) => p.sessionId === sessionId)
    : pendingPermissions;
  if (filtered.length === 0) return null;
  return (
    <div
      className="mt-scroll"
      style={{
        position: 'absolute',
        left: 6,
        right: 6,
        bottom: 6,
        padding: 6,
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
      {filtered.map((prompt) =>
        prompt.kind === 'ask-question' ? (
          <AskQuestionCard key={prompt.id} prompt={prompt} />
        ) : (
          <PermissionCard key={prompt.id} prompt={prompt} />
        ),
      )}
    </div>
  );
}
