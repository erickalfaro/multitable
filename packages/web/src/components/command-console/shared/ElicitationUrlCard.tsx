import React from 'react';
import { ExternalLink } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { wsClient } from '../../../lib/ws';
import type { ElicitationPrompt } from '../../../lib/types';
import { Button } from '../../ui';
import { SEVERITY_BORDER_VAR, categoryIcon, CATEGORY_COLOR_VAR } from '../../../lib/alertVisuals';

/**
 * Inline URL-mode elicitation row for the Command Console. The full-screen
 * `ElicitationModal` still auto-pops for URL prompts (security-sensitive
 * focus), but the row continues to appear in the Pending Actions list so the
 * user can also act on it from the global inbox if they've dismissed the
 * modal.
 */
export function ElicitationUrlCard({
  prompt,
  compact = false,
}: {
  prompt: ElicitationPrompt;
  compact?: boolean;
}) {
  const removeElicitation = useAppStore((s) => s.removeElicitation);

  const onClose = () => removeElicitation(prompt.id);

  const accept = () => {
    if (prompt.url) {
      try {
        window.open(prompt.url, '_blank', 'noopener');
      } catch {
        /* ignore popup-blocker errors */
      }
    }
    wsClient.respondElicitation(prompt.id, 'accept');
    onClose();
  };

  const cancel = () => {
    wsClient.respondElicitation(prompt.id, 'cancel');
    onClose();
  };

  return (
    <div
      style={{
        position: 'relative',
        backgroundColor: 'var(--bg-elevated)',
        borderLeft: `3px solid ${SEVERITY_BORDER_VAR.attention}`,
        padding: compact ? '10px 10px 8px' : '12px 12px 10px',
        marginBottom: compact ? 6 : 8,
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 9.5,
          color: CATEGORY_COLOR_VAR.auth,
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          fontWeight: 500,
        }}
      >
        {categoryIcon('auth', 11)}
        <span>browser auth · {prompt.serverName}</span>
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: 'var(--text-primary)',
          fontWeight: 500,
          marginTop: 6,
          lineHeight: 1.3,
        }}
      >
        {prompt.title || prompt.message}
      </div>
      {prompt.title && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.4 }}>
          {prompt.message}
        </div>
      )}
      {prompt.url && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            wordBreak: 'break-all',
            marginTop: 6,
          }}
        >
          {prompt.url}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        <Button
          size="sm"
          variant="primary"
          onClick={accept}
          leftIcon={<ExternalLink size={12} />}
          disabled={!prompt.url}
        >
          Open and continue
        </Button>
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="danger" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
