import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { Message } from '../../../lib/types';
import type { ToolStreamPayload } from '../../../stores/appStore';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ToolCallCard } from './ToolCallCard';
import { ReasoningCard } from './ReasoningCard';
import { TurnRow, TrailingLoader } from './TurnRow';
import { LoaderNode } from './LoaderNode';
import { groupIntoBlocks, type ChatBlock, type TurnMessage } from './turnGrouping';

interface Props {
  messages: Message[];
  loading?: boolean;
  emptyHint?: React.ReactNode;
  projectId: string;
  streamingText?: string;
  toolStreaming?: ToolStreamPayload | null;
  reasoningStreaming?: string;
  /** Per-session dot-matrix loader variant; rendered at the active turn's
      rail tail while a turn is in-flight (replacing the old composer-side
      AgentAvatar placement). */
  loaderVariant?: string | null;
  /** True when a turn is in flight. Drives the rail-tail loader. */
  active?: boolean;
}

function indexResults(messages: Message[]) {
  const byUseId = new Map<string, { output: string; isError: boolean }>();
  for (const m of messages) {
    if (m.kind === 'tool_result') {
      byUseId.set(m.toolUseId, { output: m.output, isError: !!m.isError });
    }
  }
  return byUseId;
}

function renderTurnCard(
  m: TurnMessage,
  resultsByUseId: Map<string, { output: string; isError: boolean }>,
): React.ReactNode {
  if (m.kind === 'reasoning') return <ReasoningCard text={m.text} />;
  if (m.kind === 'assistant') {
    if (!m.text) return null;
    return <AssistantMessage text={m.text} costLabel={null} />;
  }
  if (m.kind === 'tool_use') {
    const r = resultsByUseId.get(m.toolUseId);
    return (
      <ToolCallCard
        toolName={m.toolName}
        input={m.input}
        output={r?.output ?? null}
        isError={!!r?.isError}
        pending={!r}
      />
    );
  }
  return null;
}

export function MessageList({
  messages,
  loading,
  emptyHint,
  projectId,
  streamingText,
  toolStreaming,
  reasoningStreaming,
  loaderVariant,
  active = false,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const resultsByUseId = useMemo(() => indexResults(messages), [messages]);
  const blocks = useMemo<ChatBlock[]>(() => groupIntoBlocks(messages), [messages]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atBottom) el.scrollTop = el.scrollHeight;
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

  // Streaming previews are virtual TurnMessages. We give them stable synthetic
  // ids so React doesn't churn while text accumulates.
  const streamingMessages: TurnMessage[] = useMemo(() => {
    const out: TurnMessage[] = [];
    if (reasoningStreaming) {
      out.push({
        id: '__reasoning_stream__',
        ts: Date.now(),
        kind: 'reasoning',
        text: reasoningStreaming,
      });
    }
    if (toolStreaming) {
      out.push({
        id: '__tool_stream__',
        ts: Date.now(),
        kind: 'tool_use',
        parentId: '__tool_stream_parent__',
        toolUseId: '__tool_stream__',
        toolName: toolStreaming.toolName,
        input: toolStreaming.input,
      });
    }
    if (streamingText) {
      out.push({
        id: '__assistant_stream__',
        ts: Date.now(),
        kind: 'assistant',
        text: streamingText,
        model: '',
      });
    }
    return out;
  }, [streamingText, toolStreaming, reasoningStreaming]);

  // The "active" rail = the one we attach the trailing loader to. It is the
  // last turn block IF nothing has chain-broken since it started; otherwise we
  // render a fresh trailing TurnRow with just the loader.
  const lastBlock = blocks[blocks.length - 1];
  const lastIsTurn = lastBlock?.kind === 'turn';

  // Fold streaming previews into the final turn block when possible (the rail
  // continuously extends as the agent streams). Otherwise create a synthetic
  // trailing turn.
  const renderBlocks: ChatBlock[] = useMemo(() => {
    if (streamingMessages.length === 0) return blocks;
    if (lastIsTurn) {
      const merged = blocks.slice();
      const last = merged[merged.length - 1];
      if (last.kind === 'turn') {
        merged[merged.length - 1] = {
          kind: 'turn',
          messages: [...last.messages, ...streamingMessages],
        };
      }
      return merged;
    }
    return [...blocks, { kind: 'turn', messages: streamingMessages }];
  }, [blocks, streamingMessages, lastIsTurn]);

  const renderableEmpty = renderBlocks.length === 0;

  // Build a streaming-aware results map so the synthetic tool_use renders as
  // pending / shows live output.
  const resultsForRender = useMemo(() => {
    if (!toolStreaming) return resultsByUseId;
    const m = new Map(resultsByUseId);
    if (toolStreaming.output) {
      m.set('__tool_stream__', {
        output: toolStreaming.output,
        isError: !!toolStreaming.isError,
      });
    }
    return m;
  }, [resultsByUseId, toolStreaming]);

  // The loader avatar is always rendered as the rail's terminal node; it just
  // goes pale + static when no turn is in flight.
  const loaderNode = (
    <LoaderNode loaderVariant={loaderVariant} projectId={projectId} active={active} />
  );

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
        {renderableEmpty && !loading && emptyHint}

        {renderBlocks.map((block, bi) => {
          if (block.kind === 'user') {
            return (
              <UserMessage
                key={block.message.id}
                text={block.message.text}
              />
            );
          }
          if (block.kind === 'system') {
            return (
              <div
                key={block.message.id}
                style={{
                  margin: '8px 0',
                  fontSize: 11.5,
                  color: 'var(--text-muted)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  whiteSpace: 'pre-wrap',
                  opacity: 0.75,
                }}
              >
                {block.message.text}
              </div>
            );
          }
          // Turn block — when this is the last block, extend its rail line
          // down so it visually flows into the TrailingLoader below.
          const isLastBlock = bi === renderBlocks.length - 1;
          return (
            <TurnRow
              key={`turn-${block.messages[0].id}`}
              messages={block.messages}
              resultsByUseId={resultsForRender}
              extendLineDown={isLastBlock}
            >
              {block.messages.map((m) => (
                <React.Fragment key={m.id}>
                  {renderTurnCard(m, resultsForRender)}
                </React.Fragment>
              ))}
            </TurnRow>
          );
        })}

        {/* The loader avatar is rendered exactly ONCE here, in a stable
            position. Keeping it mounted across block transitions prevents
            the dot-matrix animation from resetting every time the active
            turn moves between blocks (standalone → synthetic → real). */}
        <TrailingLoader connected={!renderableEmpty && renderBlocks[renderBlocks.length - 1]?.kind === 'turn'}>
          {loaderNode}
        </TrailingLoader>

        {loading && renderableEmpty && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: 20, textAlign: 'center' }}>
            Loading conversation…
          </div>
        )}
      </div>

      {!atBottom && !renderableEmpty && (
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
