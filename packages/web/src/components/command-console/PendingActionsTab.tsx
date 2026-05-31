import React from 'react';
import { useAppStore } from '../../stores/appStore';
import { PermissionCard } from './shared/PermissionCard';
import { AskQuestionCard } from './shared/AskQuestionCard';
import { ElicitationFormCard } from './shared/ElicitationFormCard';
import { ElicitationUrlCard } from './shared/ElicitationUrlCard';
import { SessionGroupHeader } from './shared/SessionGroupHeader';
import { usePendingFeed, type PendingItem } from './usePendingFeed';

function renderItem(item: PendingItem): React.ReactNode {
  switch (item.kind) {
    case 'permission':
      return <PermissionCard prompt={item.prompt} compact />;
    case 'ask-question':
      return <AskQuestionCard prompt={item.prompt} compact />;
    case 'elicitation':
      if (item.prompt.mode === 'url') return <ElicitationUrlCard prompt={item.prompt} compact />;
      return <ElicitationFormCard prompt={item.prompt} compact />;
  }
}

/**
 * The Pending Actions tab — a single global inbox of every blocking prompt
 * across every project/session. Renders compact variants of the same shared
 * cards used by the per-session `PermissionBar`, so resolving from either
 * surface clears the prompt everywhere.
 */
export function PendingActionsTab({ onJumpToSession }: { onJumpToSession: (id: string) => void }) {
  const { groups, totalCount } = usePendingFeed();

  if (totalCount === 0) {
    return (
      <div
        style={{
          padding: '32px 16px',
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: 12.5,
        }}
      >
        Nothing waiting.
        <div style={{ fontSize: 11, marginTop: 6, color: 'var(--text-faint)' }}>
          Permission prompts, questions, and MCP elicitations from any session
          will land here.
        </div>
      </div>
    );
  }

  return (
    <div>
      {groups.map((g) => (
        <div key={g.sessionId} style={{ marginBottom: 4 }}>
          <SessionGroupHeader
            sessionId={g.sessionId}
            count={g.items.length}
            onJump={() => onJumpToSession(g.sessionId)}
          />
          <div style={{ padding: '8px 10px' }}>
            {g.items.map((it) => (
              <div key={it.id}>{renderItem(it)}</div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Tiny hook exported so the CommandConsole shell can render badge counts and
 * decide which tab to open by default without re-computing the full feed.
 */
export function usePendingCount(): number {
  const permissions = useAppStore((s) => s.pendingPermissions.length);
  const elicitations = useAppStore((s) => s.pendingElicitations.length);
  return permissions + elicitations;
}
