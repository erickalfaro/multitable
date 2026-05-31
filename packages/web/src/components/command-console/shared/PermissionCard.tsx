import React from 'react';
import { useAppStore } from '../../../stores/appStore';
import { wsClient } from '../../../lib/ws';
import type { PermissionPrompt } from '../../../lib/types';
import { Button } from '../../ui';
import { ToolInputPreview } from '../../permission/ToolInputPreview';
import { SEVERITY_BORDER_VAR, categoryIcon, CATEGORY_COLOR_VAR } from '../../../lib/alertVisuals';

/**
 * Shared permission card — rendered by both the per-session `PermissionBar`
 * and the global Command Console's Pending Actions tab. Resolves through
 * `wsClient.respondPermission` + the store mutator, so a click in either
 * surface clears the prompt everywhere (both surfaces read the same
 * `pendingPermissions` slice).
 *
 * `compact` tightens padding for the Console list where vertical density
 * matters; the per-session bar passes `compact={false}` to keep its current
 * visual weight.
 */
export function PermissionCard({
  prompt,
  compact = false,
}: {
  prompt: PermissionPrompt;
  compact?: boolean;
}) {
  const removePermission = useAppStore((s) => s.removePermission);
  const session = useAppStore((s) => s.sessions[prompt.sessionId]);

  const respond = (decision: 'allow' | 'deny' | 'always-allow', mode?: string) => {
    wsClient.respondPermission(prompt.id, decision, mode);
    removePermission(prompt.id);
  };

  // ExitPlanMode gets the Claude-Code-style choice: approving exits plan mode
  // and the chosen target controls how edits proceed. Targets are read from the
  // session's advertised modes so we never send a value the provider rejects
  // (Claude → acceptEdits/default; Grok → auto/default, since it has no
  // acceptEdits). The daemon flips the session mode on receipt; "Keep planning"
  // (deny) leaves the session in plan mode.
  const isExitPlan = prompt.toolName === 'ExitPlanMode';
  const modeValues = session?.capabilities?.modes?.map((m) => m.value) ?? [];
  const autoTarget = modeValues.includes('acceptEdits')
    ? 'acceptEdits'
    : modeValues.includes('auto')
      ? 'auto'
      : 'acceptEdits';
  const manualTarget = 'default';

  return (
    <div
      style={{
        position: 'relative',
        backgroundColor: 'var(--bg-elevated)',
        // Match the alerts-tab visual language: severity-color left rule + a
        // body that lets the per-category icon do the disambiguation.
        // Permission prompts are always "attention" severity — they block the
        // session until acted on.
        borderLeft: `3px solid ${SEVERITY_BORDER_VAR.attention}`,
        padding: compact ? '10px 10px 8px' : '14px 14px 12px',
        marginBottom: compact ? 6 : 8,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: compact ? 6 : 8,
          left: compact ? 10 : 12,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 9.5,
          color: CATEGORY_COLOR_VAR.permission,
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          fontWeight: 500,
        }}
      >
        {categoryIcon('permission', 11)}
        <span>permission · {prompt.toolName}</span>
      </div>
      <span
        style={{
          position: 'absolute',
          top: compact ? 6 : 8,
          right: compact ? 10 : 12,
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
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {isExitPlan ? (
          <>
            <Button size="sm" variant="primary" onClick={() => respond('allow', autoTarget)}>
              Auto-accept edits
            </Button>
            <Button size="sm" variant="secondary" onClick={() => respond('allow', manualTarget)}>
              Manually approve edits
            </Button>
            <div style={{ flex: 1 }} />
            <Button size="sm" variant="danger" onClick={() => respond('deny')}>
              Keep planning
            </Button>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
