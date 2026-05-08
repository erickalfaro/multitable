import React, { useEffect, useMemo, useRef } from 'react';
import type { Message } from '../../../lib/types';
import type { ToolStreamPayload } from '../../../stores/appStore';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ToolCallCard } from './ToolCallCard';
import { ReasoningCard } from './ReasoningCard';
import { TurnRow, TrailingLoader, TURN_GAP_END } from './TurnRow';
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

  // Cross-render swap anchors: when a streaming preview is replaced by its
  // canonical message in `messages`, the canonical's id is mapped here to the
  // synthetic React key the preview was using. The next render uses that
  // synthetic key for the canonical, which lets React reuse the existing
  // component instance instead of unmounting the synthetic and mounting a
  // fresh canonical (a costly remount that re-parses Streamdown markdown,
  // re-mounts every CodeBlock, and kicks shiki on first render of canonical).
  // The mapping is permanent for that canonical id — so the AssistantMessage
  // / ReasoningCard / ToolCallCard instance that was rendering the preview
  // is the same React node that ends up rendering the canonical, with only
  // a `text` / `streaming` prop change between the two.
  const swapAnchorsRef = useRef<Map<string, string>>(new Map());
  // Per-kind monotonic counters. The synthetic preview key embeds the current
  // counter; the counter rotates after a swap is committed so a freshly-
  // promoted canonical (now permanently using the prior synth key) cannot
  // collide with the next turn's streaming preview. Across the whole life of
  // this MessageList instance, every preview-then-canonical pair gets its
  // own unique stable key.
  const swapCounterRef = useRef({ assistant: 0, reasoning: 0, tool: 0 });
  // Snapshot of the previous render's relevant inputs — used to detect the
  // exact transition where streaming X went non-empty → empty AND a new
  // canonical message of the matching kind was appended. That's the swap.
  const prevSnapshotRef = useRef<{
    streamingText: string;
    reasoningStreaming: string;
    hasToolStreaming: boolean;
    messageIds: string[];
  } | null>(null);

  const synthAssistantKey = `__assistant_stream_${swapCounterRef.current.assistant}__`;
  const synthReasoningKey = `__reasoning_stream_${swapCounterRef.current.reasoning}__`;
  const synthToolKey = `__tool_stream_${swapCounterRef.current.tool}__`;

  // Compute the swap anchors for THIS render. This runs before children are
  // rendered, so the canonical that just landed gets the synth key in the
  // very same render that the synthetic preview disappears — keys match
  // across the transition and React preserves component identity.
  const swapAnchors = useMemo(() => {
    const next = new Map(swapAnchorsRef.current);
    const prev = prevSnapshotRef.current;
    if (!prev) return next;
    const prevSet = new Set(prev.messageIds);
    const newMessages = messages.filter((m) => !prevSet.has(m.id));
    if (newMessages.length === 0) return next;
    const findNew = (kind: 'assistant' | 'reasoning' | 'tool_use') => {
      // The canonical that replaces the streaming preview is the LAST new
      // message of that kind in this render's diff (a turn can append more
      // than one of a kind in the same batch — the streaming preview always
      // corresponds to the most recent one).
      for (let i = newMessages.length - 1; i >= 0; i--) {
        const m = newMessages[i];
        if (m.kind === kind) return m;
      }
      return null;
    };
    if (prev.streamingText && !streamingText) {
      const m = findNew('assistant');
      if (m && m.kind === 'assistant' && m.text && !next.has(m.id)) {
        next.set(m.id, synthAssistantKey);
      }
    }
    if (prev.reasoningStreaming && !reasoningStreaming) {
      const m = findNew('reasoning');
      if (m && !next.has(m.id)) next.set(m.id, synthReasoningKey);
    }
    if (prev.hasToolStreaming && !toolStreaming) {
      const m = findNew('tool_use');
      if (m && !next.has(m.id)) next.set(m.id, synthToolKey);
    }
    return next;
  }, [
    streamingText,
    reasoningStreaming,
    toolStreaming,
    messages,
    synthAssistantKey,
    synthReasoningKey,
    synthToolKey,
  ]);

  // Commit the new anchor map to the ref AFTER React commits this render, and
  // rotate the per-kind counter for any stream type that was just promoted.
  // Doing this in an effect (not during render) keeps render pure and means
  // the counter only advances after we are sure the swap render committed.
  useEffect(() => {
    const prevAnchors = swapAnchorsRef.current;
    if (swapAnchors !== prevAnchors) {
      swapAnchorsRef.current = swapAnchors;
      const newValues = new Set<string>();
      for (const v of swapAnchors.values()) {
        if (![...prevAnchors.values()].includes(v)) newValues.add(v);
      }
      if (newValues.has(synthAssistantKey)) swapCounterRef.current.assistant += 1;
      if (newValues.has(synthReasoningKey)) swapCounterRef.current.reasoning += 1;
      if (newValues.has(synthToolKey)) swapCounterRef.current.tool += 1;
    }
    prevSnapshotRef.current = {
      streamingText: streamingText ?? '',
      reasoningStreaming: reasoningStreaming ?? '',
      hasToolStreaming: !!toolStreaming,
      messageIds: messages.map((m) => m.id),
    };
  });

  // Streaming previews are virtual TurnMessages. The synthetic ids embed the
  // current per-kind counter so they remain stable across renders WITHIN a
  // single turn, but rotate after a swap so the next streaming preview gets
  // a fresh key (the previous canonical now permanently owns the prior key
  // via swapAnchors).
  const streamingMessages: TurnMessage[] = useMemo(() => {
    const out: TurnMessage[] = [];
    if (reasoningStreaming) {
      out.push({
        id: synthReasoningKey,
        ts: 0,
        kind: 'reasoning',
        text: reasoningStreaming,
      });
    }
    if (toolStreaming) {
      out.push({
        id: synthToolKey,
        ts: 0,
        kind: 'tool_use',
        parentId: '__tool_stream_parent__',
        toolUseId: synthToolKey,
        toolName: toolStreaming.toolName,
        input: toolStreaming.input,
      });
    }
    if (streamingText) {
      out.push({
        id: synthAssistantKey,
        ts: 0,
        kind: 'assistant',
        text: streamingText,
        model: '',
      });
    }
    return out;
  }, [streamingText, toolStreaming, reasoningStreaming, synthAssistantKey, synthReasoningKey, synthToolKey]);

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
      m.set(synthToolKey, {
        output: toolStreaming.output,
        isError: !!toolStreaming.isError,
      });
    }
    return m;
  }, [resultsByUseId, toolStreaming, synthToolKey]);

  // The loader avatar is always rendered as the rail's terminal node; it just
  // goes pale + static when no turn is in flight.
  const loaderNode = (
    <LoaderNode loaderVariant={loaderVariant} projectId={projectId} active={active} />
  );

  // The IDs of the streaming preview messages — passed to renderTurnCard so
  // it knows which AssistantMessage to mark as `streaming` (drives the
  // blinking caret + the StreamingContext signal that freezes shiki). The
  // synth keys are computed off the per-kind counters above so they stay
  // stable for the duration of a single streaming session.
  const isStreamingMessage = (id: string): boolean =>
    id === synthAssistantKey || id === synthReasoningKey;

  return (
    <>
      {renderableEmpty && !loading && emptyHint}

      {renderBlocks.map((block, bi) => {
        const isLastBlock = bi === renderBlocks.length - 1;
        // The TrailingLoader pulls itself up by -TURN_GAP_END unconditionally
        // so the loader's screen position is invariant when the first delta
        // of a turn lands. Turn blocks already have a matching marginBottom;
        // user / system blocks need an explicit padding-bottom to compensate
        // when they are the last block (i.e., the loader sits directly below
        // them). When they are NOT last, no compensation is needed — the
        // following turn block has its own top spacing.
        if (block.kind === 'user') {
          return (
            <div
              key={block.message.id}
              style={isLastBlock ? { paddingBottom: TURN_GAP_END } : undefined}
            >
              <UserMessage text={block.message.text} />
            </div>
          );
        }
        if (block.kind === 'system') {
          return (
            <div
              key={block.message.id}
              style={isLastBlock ? { paddingBottom: TURN_GAP_END } : undefined}
            >
              <div
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
            </div>
          );
        }
        // Turn block — when this is the last block, extend its rail line
        // down so it visually flows into the TrailingLoader below.
        return (
          <div key={`turn-${block.messages[0].id}`} className="mt-turn-block">
            <TurnRow
              messages={block.messages}
              resultsByUseId={resultsForRender}
              extendLineDown={isLastBlock}
              keyOverrides={swapAnchors}
            >
              {block.messages.map((m) => {
                // If this canonical message is the one that just replaced a
                // streaming preview, render it under the synthetic React key
                // so React reuses the existing component instance rather
                // than tearing down the AssistantMessage / ReasoningCard /
                // ToolCallCard subtree and re-mounting a fresh one. The same
                // key is propagated to TurnRow's inner <div> via
                // `keyOverrides` above so React's actual mount/unmount
                // boundary stays stable across the swap.
                const reactKey = swapAnchors.get(m.id) ?? m.id;
                return (
                  <React.Fragment key={reactKey}>
                    {renderTurnCard(m, resultsForRender, isStreamingMessage(m.id))}
                  </React.Fragment>
                );
              })}
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
