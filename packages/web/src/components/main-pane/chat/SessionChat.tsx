import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Message, Session } from '../../../lib/types';
import { useAppStore } from '../../../stores/appStore';
import { wsClient } from '../../../lib/ws';
import { api } from '../../../lib/api';
import { useIsMobile } from '../../../lib/useIsMobile';
import { SessionHeaderBar } from '../SessionHeaderBar';
import { ProcessBanner } from '../ProcessBanner';
import { PermissionBar } from '../../permission/PermissionBar';
import { MessageList } from './MessageList';
import { ChatScroller } from './ChatScroller';
import { ChatInputCM } from './ChatInputCM';
import { PinnedUserPrompt } from './PinnedUserPrompt';

// Stable empty-array reference so the selector below doesn't hand a fresh
// [] to Zustand on every unrelated store update — without this, every metrics
// tick re-renders the chat tree.
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_PENDING: string[] = [];

interface Props {
  sessionId: string;
  session: Session;
}

export function SessionChat({ sessionId, session }: Props) {
  const messages = useAppStore((s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES);
  const mergeMessages = useAppStore((s) => s.mergeMessages);
  const clearMessages = useAppStore((s) => s.clearMessages);
  const detailPanelOpen = useAppStore((s) => s.detailPanelOpen);
  const setDetailPanelOpen = useAppStore((s) => s.setDetailPanelOpen);
  const setMobileDrawerOpen = useAppStore((s) => s.setMobileDrawerOpen);
  const projectName = useAppStore(
    (s) => s.projects.find((p) => p.id === session.projectId)?.name,
  );
  const pendingHead = useAppStore(
    (s) => (s.pendingSendsBySession[sessionId] ?? EMPTY_PENDING)[0],
  );
  const popPendingSend = useAppStore((s) => s.popPendingSend);
  const streamingText = useAppStore((s) => s.streamingBySession[sessionId] ?? '');
  const toolStreaming = useAppStore((s) => s.toolStreamingBySession[sessionId] ?? null);
  const reasoningStreaming = useAppStore((s) => s.reasoningStreamingBySession[sessionId] ?? '');

  const [loading, setLoading] = useState(false);
  const isMobile = useIsMobile();
  const agentSessionId = session.agentSessionId ?? session.claudeState?.agentSessionId ?? null;
  const lastLoadedKeyRef = useRef<string | null>(null);
  const subscribedIdRef = useRef<string | null>(null);

  // Load + refresh the transcript whenever the session id or the linked
  // Claude session id changes. Resets scroll state by replacing, not
  // appending — ensures stale messages don't linger after "Start New".
  useEffect(() => {
    const key = `${sessionId}:${agentSessionId ?? ''}`;
    const previousKey = lastLoadedKeyRef.current;
    if (previousKey === key) return;
    lastLoadedKeyRef.current = key;

    if (!agentSessionId) {
      clearMessages(sessionId);
      return;
    }

    // First-turn transition: same session id, agentSessionId just went from
    // empty to its first value. The Claude SDK assigned a session id mid-turn
    // and the daemon broadcast it — but the store ALREADY has the optimistic
    // user message + any streamed assistant content from WS events. Pulling
    // the JSONL now would re-introduce the canonical user message alongside
    // the optimistic copy (different ids → id-based dedup misses) — that's
    // the long-standing user-message-doubling bug.
    //
    // The WS path has us covered for first-turn content; we only need to
    // refetch when the user actually navigates between sessions (different
    // sessionId) or when a Claude resume forks the session id (rare; the
    // legacy claudeSessionIdHistory path), neither of which match this
    // "previous key was sessionId-with-no-agent-id" pattern.
    const isFirstTurnAgentIdAssignment =
      previousKey === `${sessionId}:` && agentSessionId !== '';
    if (isFirstTurnAgentIdAssignment) return;

    setLoading(true);
    api.sessions
      .messages(sessionId)
      .then((res) => {
        // Merge (not replace) so any deltas accumulated via WS broadcast while
        // the user was on a different session aren't clobbered by a slightly
        // stale JSONL fetch.
        mergeMessages(sessionId, res.messages);
      })
      .catch(() => {
        // Empty transcript is valid; errors are silent.
      })
      .finally(() => setLoading(false));
  }, [sessionId, agentSessionId, mergeMessages, clearMessages]);

  // Subscribe the WS client so we receive session events (assistant-message,
  // tool-event, user-message, etc.). Sessions have no PTY, so no dims are
  // sent — the daemon routes session subscriptions to AgentSessionManager.
  useEffect(() => {
    if (subscribedIdRef.current === sessionId) return;
    if (subscribedIdRef.current) {
      wsClient.unsubscribe(subscribedIdRef.current);
    }
    wsClient.subscribe(sessionId);
    subscribedIdRef.current = sessionId;
    return () => {
      if (subscribedIdRef.current === sessionId) {
        wsClient.unsubscribe(sessionId);
        subscribedIdRef.current = null;
      }
    };
  }, [sessionId]);

  // When the WS reconnects, re-fetch messages (server may have missed tails
  // during the outage).
  useEffect(() => {
    const off = wsClient.on('ws:reconnected', () => {
      if (!agentSessionId) return;
      api.sessions
        .messages(sessionId)
        .then((res) => mergeMessages(sessionId, res.messages))
        .catch(() => {});
    });
    return off;
  }, [sessionId, agentSessionId, mergeMessages]);

  // When a new claudeSessionId is assigned mid-session (SessionStart), we
  // may already have some deltas in the store — keep them but also refetch
  // the initial history to be safe. Handled by the key-based effect above.
  // (No extra wiring needed here — claudeSessionId change retriggers load.)

  // Drain queued sends: whenever the session is idle and there's a head
  // message in the queue, pop it and dispatch via wsClient.sendTurn. The
  // daemon flips state back to 'running', which gates the next iteration —
  // so this naturally serializes one queued message per turn. We skip the
  // 'errored' state because that requires explicit recovery.
  useEffect(() => {
    if (session.state !== 'stopped') return;
    if (!pendingHead) return;
    const text = popPendingSend(sessionId);
    if (text) wsClient.sendTurn(sessionId, text);
  }, [session.state, pendingHead, sessionId, popPendingSend]);

  // Sessions sit in 'stopped' until the first turn fires; that's the normal
  // ready state, no banner needed. Only surface the banner on actual error.
  const showBanner = session.state === 'errored';

  // Ordered list of every user prompt in the chat — fed to PinnedUserPrompt
  // so it can render whichever prompt is the closest one above the current
  // viewport, updating live as the user scrolls.
  const userMessages = useMemo(() => {
    const list: Array<{ id: string; text: string }> = [];
    for (const m of messages) {
      if (m.kind === 'user') list.push({ id: m.id, text: m.text });
    }
    return list;
  }, [messages]);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <SessionHeaderBar
        session={session}
        onToggleDetailPanel={() => setDetailPanelOpen(!detailPanelOpen)}
        projectName={isMobile ? projectName : undefined}
        onOpenDrawer={isMobile ? () => setMobileDrawerOpen(true) : undefined}
      />

      {showBanner && <ProcessBanner process={session} />}

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minHeight: 0,
          minWidth: 0,
          position: 'relative',
          backgroundColor: 'var(--bg-primary)',
        }}
      >
        <ChatScroller
          pinnedHeader={
            userMessages.length > 0 ? <PinnedUserPrompt userMessages={userMessages} /> : null
          }
        >
          <MessageList
            messages={messages}
            loading={loading}
            projectId={session.projectId}
            streamingText={streamingText}
            toolStreaming={toolStreaming}
            reasoningStreaming={reasoningStreaming}
            loaderVariant={session.loaderVariant ?? null}
            active={session.state === 'running'}
          />
        </ChatScroller>
        <ChatInputCM
          processId={sessionId}
          projectId={session.projectId}
          state={session.state}
          attachmentKind="session"
          active={session.state === 'running'}
        />
        <PermissionBar sessionId={sessionId} />
      </div>
    </div>
  );
}
