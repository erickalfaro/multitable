import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Message } from '../../../lib/types';
import type { ToolStreamPayload } from '../../../stores/appStore';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ToolCallCard } from './ToolCallCard';

interface Props {
  messages: Message[];
  loading?: boolean;
  emptyHint?: React.ReactNode;
  projectId: string;
  /**
   * In-flight assistant text being streamed from the SDK. Rendered as a
   * trailing live bubble; replaced by the canonical assistant message the
   * moment the SDK's `assistant` event lands.
   */
  streamingText?: string;
  /**
   * Live in-progress Codex tool execution snapshot (stdout for a running
   * shell command, in-progress patch, etc.). Rendered as a transient
   * "running" tool card that gets replaced by the canonical tool_use card
   * when item.completed lands.
   */
  toolStreaming?: ToolStreamPayload | null;
  /** Live model-reasoning text — italic preview while the agent thinks. */
  reasoningStreaming?: string;
}

// Builds a map from tool_use id → its matching tool_result (if seen). The
// tool_result messages themselves are then hidden from the rendered list.
function indexResults(messages: Message[]) {
  const byUseId = new Map<string, { output: string; isError: boolean }>();
  for (const m of messages) {
    if (m.kind === 'tool_result') {
      byUseId.set(m.toolUseId, { output: m.output, isError: !!m.isError });
    }
  }
  return byUseId;
}

export function MessageList({
  messages,
  loading,
  emptyHint,
  projectId,
  streamingText,
  toolStreaming,
  reasoningStreaming,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const resultsByUseId = useMemo(() => indexResults(messages), [messages]);

  // Auto-scroll: only follow if the user is already near the bottom, so we
  // don't yank them away while they're reading history. We also follow
  // tool/reasoning streaming so live output stays visible.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamingText, toolStreaming, reasoningStreaming, atBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const threshold = 80;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setAtBottom(distance < threshold);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  };

  const renderable = messages.filter((m) => m.kind !== 'tool_result');

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <div
        ref={scrollRef}
        className="mt-scroll"
        style={{
          position: 'absolute',
          inset: 0,
          overflowY: 'auto',
          padding: '12px 14px 16px',
        }}
      >
        {renderable.length === 0 && !loading && emptyHint}
        {renderable.map((m) => {
          if (m.kind === 'user') return <UserMessage key={m.id} text={m.text} projectId={projectId} />;
          if (m.kind === 'assistant') {
            if (!m.text) return null;
            // Per-message usage is unreliable when includePartialMessages is on
            // (the SDK splits a turn into chunks each carrying partial tokens).
            // Accurate totals live in SessionDetailPanel.
            return <AssistantMessage key={m.id} text={m.text} costLabel={null} />;
          }
          if (m.kind === 'tool_use') {
            const result = resultsByUseId.get(m.toolUseId);
            return (
              <ToolCallCard
                key={m.id}
                toolName={m.toolName}
                input={m.input}
                output={result?.output ?? null}
                isError={!!result?.isError}
                pending={!result}
              />
            );
          }
          if (m.kind === 'system') {
            return (
              <div
                key={m.id}
                style={{
                  margin: '8px 0',
                  fontSize: 11.5,
                  color: 'var(--text-muted)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  whiteSpace: 'pre-wrap',
                  opacity: 0.75,
                }}
              >
                {m.text}
              </div>
            );
          }
          return null;
        })}
        {reasoningStreaming && (
          <div
            key="__reasoning__"
            style={{
              margin: '6px 0',
              padding: '4px 8px',
              fontSize: 11.5,
              fontStyle: 'italic',
              color: 'var(--text-muted)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              whiteSpace: 'pre-wrap',
              opacity: 0.85,
              borderLeft: '2px solid var(--border)',
            }}
          >
            <span
              style={{
                fontSize: 9.5,
                textTransform: 'uppercase',
                letterSpacing: '0.18em',
                color: 'var(--text-muted)',
                marginRight: 6,
              }}
            >
              Thinking
            </span>
            {reasoningStreaming}
          </div>
        )}
        {toolStreaming && (
          <ToolCallCard
            key="__tool_streaming__"
            toolName={toolStreaming.toolName}
            input={toolStreaming.input}
            output={toolStreaming.output}
            isError={toolStreaming.isError}
            pending
            defaultOpen
          />
        )}
        {streamingText && (
          <AssistantMessage
            key="__streaming__"
            text={streamingText}
            costLabel={null}
            streaming
          />
        )}
        {loading && renderable.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 20, textAlign: 'center' }}>
            Loading conversation…
          </div>
        )}
      </div>

      {!atBottom && renderable.length > 0 && (
        <button
          onClick={scrollToBottom}
          style={{
            position: 'absolute',
            bottom: 14,
            right: 16,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '3px 10px',
            fontSize: 10.5,
            borderRadius: 'var(--radius-snug)',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--accent-amber)',
            color: 'var(--accent-amber)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          <ChevronDown size={11} /> Jump to latest
        </button>
      )}
    </div>
  );
}
