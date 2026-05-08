import React, { useMemo } from 'react';
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
  streaming: boolean,
): React.ReactNode {
  if (m.kind === 'reasoning') return <ReasoningCard text={m.text} />;
  if (m.kind === 'assistant') {
    if (!m.text) return null;
    return <AssistantMessage text={m.text} costLabel={null} streaming={streaming} />;
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
  const resultsByUseId = useMemo(() => indexResults(messages), [messages]);
  const blocks = useMemo<ChatBlock[]>(() => groupIntoBlocks(messages), [messages]);

  // Streaming previews are virtual TurnMessages. We give them stable synthetic
  // ids so React's reconciler keeps the same component instances mounted as
  // text accumulates — only the leaf AssistantMessage's `text` prop changes.
  const streamingMessages: TurnMessage[] = useMemo(() => {
    const out: TurnMessage[] = [];
    if (reasoningStreaming) {
      out.push({
        id: '__reasoning_stream__',
        ts: 0,
        kind: 'reasoning',
        text: reasoningStreaming,
      });
    }
    if (toolStreaming) {
      out.push({
        id: '__tool_stream__',
        ts: 0,
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
        ts: 0,
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

  // The IDs of the streaming preview messages — passed to renderTurnCard so
  // it knows which AssistantMessage to mark as `streaming` (drives the
  // blinking caret + the StreamingContext signal that freezes shiki). Stable
  // refs across renders since they are module-level constants.
  const isStreamingMessage = (id: string): boolean =>
    id === '__assistant_stream__' || id === '__reasoning_stream__';

  return (
    <>
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
          <div key={`turn-${block.messages[0].id}`} className="mt-turn-block">
            <TurnRow
              messages={block.messages}
              resultsByUseId={resultsForRender}
              extendLineDown={isLastBlock}
            >
              {block.messages.map((m) => (
                <React.Fragment key={m.id}>
                  {renderTurnCard(m, resultsForRender, isStreamingMessage(m.id))}
                </React.Fragment>
              ))}
            </TurnRow>
          </div>
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
    </>
  );
}
