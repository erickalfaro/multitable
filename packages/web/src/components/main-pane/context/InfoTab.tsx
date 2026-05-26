import React, { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { Session } from '../../../lib/types';
import { useAppStore } from '../../../stores/appStore';
import { cleanModelLabelFromCatalog } from '../../../lib/modelName';
import { copyToClipboard } from '../../../lib/clipboard';
import { buildResumeCommand, sessionIdLabel } from '../../../lib/resumeCommand';

interface Props {
  session: Session;
}

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 8,
  fontWeight: 500,
};

function Row({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div
      title={title}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        padding: '5px 0',
        fontSize: 13,
        borderBottom: '1px solid var(--border)',
      }}
    >
      <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{label}</span>
      <span
        className="mt-mono-tabular"
        style={{
          color: 'var(--text-primary)',
          fontFamily: 'monospace',
          fontSize: 12,
          textAlign: 'right',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Canonical, read-only home for session metadata that used to be scattered
 * across the header chips and the retired ProviderCapabilityStrip footer:
 * the persisted id (+ resume command), provider, model, mode, thinking effort,
 * and the adapter's capability flags. Interactive controls (mode/effort/model
 * switching) still live in the header/composer — this tab only reflects state.
 */
export function InfoTab({ session }: Props) {
  const provider = session.agentProvider;
  const capabilities = session.capabilities ?? null;
  const agentSessionId = session.agentSessionId ?? session.claudeState?.agentSessionId ?? null;

  const catalog = useAppStore((s) => s.modelCatalog[provider]);
  const status = useAppStore((s) => s.modelCatalogStatus[provider]);
  const loadModelCatalog = useAppStore((s) => s.loadModelCatalog);
  useEffect(() => {
    if (session.model && status === 'idle') loadModelCatalog(provider);
  }, [provider, session.model, status, loadModelCatalog]);

  const [copied, setCopied] = useState(false);
  const resumeCommand = agentSessionId ? buildResumeCommand(provider, agentSessionId) : null;
  const handleCopyId = async () => {
    if (!agentSessionId) return;
    await copyToClipboard(agentSessionId);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const modelLabel = session.model
    ? cleanModelLabelFromCatalog(session.model, catalog) ?? session.model
    : 'Provider default';

  const modeLabel =
    capabilities?.modes.find((m) => m.value === session.mode)?.label ?? session.mode ?? 'default';

  const effortLabel =
    capabilities?.thinkingEffort === 'unsupported'
      ? 'Not supported'
      : session.thinkingEffort ?? 'Provider default';

  const yesNo = (b: boolean) => (b ? 'Yes' : 'No');

  return (
    <div className="mt-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
      {/* Session */}
      <div style={sectionHeaderStyle}>Session</div>
      <Row label="Provider" value={provider} />
      <Row label="Model" value={modelLabel} title={session.model ?? undefined} />
      <Row label="Mode" value={modeLabel} />
      <Row label="Thinking effort" value={effortLabel} />
      {agentSessionId ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            padding: '5px 0',
            fontSize: 13,
            borderBottom: '1px solid var(--border)',
          }}
        >
          <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{sessionIdLabel(provider)}</span>
          <button
            onClick={handleCopyId}
            title={resumeCommand ? `Click to copy id — resume with: ${resumeCommand}` : 'Click to copy'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              maxWidth: '100%',
              padding: 0,
              background: 'transparent',
              border: 'none',
              color: 'var(--text-primary)',
              fontFamily: 'monospace',
              fontSize: 12,
              cursor: 'pointer',
              overflow: 'hidden',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {agentSessionId}
            </span>
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      ) : (
        <Row label={sessionIdLabel(provider)} value="—" />
      )}

      {/* Capabilities */}
      <div style={{ ...sectionHeaderStyle, marginTop: 16 }}>Capabilities</div>
      {capabilities ? (
        <>
          <Row label="Plan mode" value={capabilities.planMode} />
          <Row label="Subagents" value={capabilities.subagents} />
          <Row label="Elicitation" value={yesNo(capabilities.elicitation)} />
          <Row label="Per-call approval" value={capabilities.perCallApproval} />
          <Row label="Mid-turn input" value={yesNo(capabilities.midTurnInput)} />
          <Row label="User questions" value={capabilities.userQuestion} />
          <Row label="Cost tracking" value={yesNo(capabilities.costUsd)} />
          <Row label="BYOK" value={yesNo(capabilities.byok)} />
          <Row label="Hard sandbox" value={yesNo(capabilities.hardSandbox)} />
          <Row label="Hooks" value={capabilities.hooks} />
          <Row label="Model switch scope" value={capabilities.modelSwitchScope} />
        </>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '5px 0' }}>
          Capabilities not yet reported.
        </div>
      )}
    </div>
  );
}
