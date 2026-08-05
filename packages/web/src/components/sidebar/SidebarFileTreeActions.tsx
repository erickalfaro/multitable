import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Minus, Plus } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { copyToClipboard } from '../../lib/clipboard';
import { api } from '../../lib/api';

interface Props {
  projectId: string;
  filePath: string;
  // Resolved active session for this project. null → "Add to context" is
  // disabled (no session to attach the file to).
  targetSessionId: string | null;
}

// Stable empty array so the zustand selector doesn't return a fresh reference
// each render when nothing is selected.
const EMPTY: string[] = [];

const btnBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid',
  padding: '2px 3px',
  borderRadius: 'var(--radius-sm)',
  flexShrink: 0,
  transition:
    'background-color var(--dur-fast), color var(--dur-fast), border-color var(--dur-fast)',
};

export function SidebarFileTreeActions({ projectId, filePath, targetSessionId }: Props) {
  const selectedFiles = useAppStore((s) =>
    targetSessionId ? (s.selectedFilesBySession[targetSessionId] ?? EMPTY) : EMPTY,
  );
  const toggleSelectedFile = useAppStore((s) => s.toggleSelectedFile);
  const isSelected = !!targetSessionId && selectedFiles.includes(filePath);

  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const copyPath = async (e: React.MouseEvent) => {
    e.stopPropagation();
    // Copy the project-rooted relative path — that's what callers paste into
    // prompts, commits, and @-mentions.
    const ok = await copyToClipboard(filePath);
    if (!ok) return;
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1200);
  };

  const canAdd = !!targetSessionId;

  return (
    <>
      <button
        type="button"
        disabled={!canAdd}
        onClick={
          canAdd
            ? (e) => {
                e.stopPropagation();
                toggleSelectedFile(targetSessionId!, filePath);
              }
            : undefined
        }
        title={
          !canAdd
            ? 'Open a session in this project to add files to context'
            : isSelected
              ? 'Remove from chat context'
              : 'Add to chat context'
        }
        style={{
          ...btnBase,
          background: isSelected
            ? 'color-mix(in srgb, var(--accent-blue) 20%, transparent)'
            : 'transparent',
          borderColor: isSelected ? 'var(--accent-blue)' : 'var(--border)',
          color: isSelected ? 'var(--accent-blue)' : 'var(--text-muted)',
          cursor: canAdd ? 'pointer' : 'not-allowed',
          opacity: canAdd ? 1 : 0.4,
        }}
        onMouseEnter={(e) => {
          if (canAdd && !isSelected) {
            e.currentTarget.style.color = 'var(--text-primary)';
            e.currentTarget.style.borderColor = 'var(--text-muted)';
          }
        }}
        onMouseLeave={(e) => {
          if (canAdd && !isSelected) {
            e.currentTarget.style.color = 'var(--text-muted)';
            e.currentTarget.style.borderColor = 'var(--border)';
          }
        }}
      >
        {isSelected ? <Minus size={11} /> : <Plus size={11} />}
      </button>
      <button
        type="button"
        onClick={copyPath}
        title="Copy path"
        style={{
          ...btnBase,
          background: copied
            ? 'color-mix(in srgb, var(--accent-blue) 20%, transparent)'
            : 'transparent',
          borderColor: copied ? 'var(--accent-blue)' : 'var(--border)',
          color: copied ? 'var(--accent-blue)' : 'var(--text-muted)',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => {
          if (!copied) {
            e.currentTarget.style.color = 'var(--text-primary)';
            e.currentTarget.style.borderColor = 'var(--text-muted)';
          }
        }}
        onMouseLeave={(e) => {
          if (!copied) {
            e.currentTarget.style.color = 'var(--text-muted)';
            e.currentTarget.style.borderColor = 'var(--border)';
          }
        }}
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void api.projects.openInDefaultApp(projectId, filePath);
        }}
        title="Open in default app"
        style={{
          ...btnBase,
          background: 'transparent',
          borderColor: 'var(--border)',
          color: 'var(--text-muted)',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--text-primary)';
          e.currentTarget.style.borderColor = 'var(--text-muted)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--text-muted)';
          e.currentTarget.style.borderColor = 'var(--border)';
        }}
      >
        <ExternalLink size={11} />
      </button>
    </>
  );
}
