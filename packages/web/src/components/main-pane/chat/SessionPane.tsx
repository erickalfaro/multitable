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
import { WorkspaceTint } from '../../theme/WorkspaceTint';

/**
 * Density tiers — see plan §3 "Density is a prop, not a fork."
 *
 * - `comfortable` — the main pane view. Full chrome, complete history,
 *   reasoning and tool cards visible.
 * - `wall` — desktop Wall tile. Slim chrome (no SessionHeaderBar — the tile
 *   wraps with its own minimal header), tail-only messages, single-line
 *   composer, hide pinned prompt.
 * - `card` — mobile Pinned Feed item. No header, no composer, no permission
 *   bar; last 3 prose-only messages. The tile wrapper makes the whole card
 *   tappable; this component is the read-only inside.
 */
export type SessionPaneDensity = 'comfortable' | 'wall' | 'card';

interface DensityConfig {
  showHeader: boolean;
  showBanner: boolean;
  showPinnedPrompt: boolean;
  showComposer: boolean;
  showPermissionBar: boolean;
  /** Slice the messages array to the last N before rendering. null = all. */
  tailLimit: number | null;
  /** Filter out reasoning + tool messages before rendering. */
  proseOnly: boolean;
}

const DENSITY: Record<SessionPaneDensity, DensityConfig> = {
  comfortable: {
    showHeader: true,
    showBanner: true,
    showPinnedPrompt: true,
    showComposer: true,
    showPermissionBar: true,
    tailLimit: null,
    proseOnly: false,
  },
  wall: {
    showHeader: false,
    showBanner: true,
    showPinnedPrompt: false,
    showComposer: true,
    showPermissionBar: true,
    tailLimit: 12,
    proseOnly: false,
  },
  card: {
    showHeader: false,
    showBanner: false,
    showPinnedPrompt: false,
    showComposer: false,
    showPermissionBar: false,
    tailLimit: 3,
    proseOnly: true,
  },
};

// Stable empty references so selectors don't hand a fresh [] to Zustand on
// every unrelated tick.
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_PENDING: string[] = [];

interface Props {
  sessionId: string;
  session: Session;
  density?: SessionPaneDensity;
}

export function SessionPane({ sessionId, session, density = 'comfortable' }: Props) {
  const cfg = DENSITY[density];
  // In the wall, only the focused tile gets a full composer; everyone else
  // shows a thin clickable strip (saves vertical space when watching 12+
  // sessions at once). Clicking the strip focuses the tile, expanding it.
  const focusedPaneId = useAppStore((s) => s.focusedPaneId);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  const composerCollapsed = density === 'wall' && focusedPaneId !== sessionId;
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
  // agent session id changes. See SessionChat history for the long
  // explanation of the first-turn double-message hazard.
  useEffect(() => {
    const key = `${sessionId}:${agentSessionId ?? ''}`;
    const previousKey = lastLoadedKeyRef.current;
    if (previousKey === key) return;
    lastLoadedKeyRef.current = key;

    if (!agentSessionId) {
      clearMessages(sessionId);
      return;
    }

    const isFirstTurnAgentIdAssignment =
      previousKey === `${sessionId}:` && agentSessionId !== '';
    if (isFirstTurnAgentIdAssignment) return;

    const hasCached =
      (useAppStore.getState().messagesBySession[sessionId]?.length ?? 0) > 0;
    if (!hasCached) setLoading(true);
    api.sessions
      .messages(sessionId)
      .then((res) => {
        mergeMessages(sessionId, res.messages);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [sessionId, agentSessionId, mergeMessages, clearMessages]);

  // Subscribe the WS client so we receive session events. Sessions have no
  // PTY, so no dims are sent.
  //
  // IMPORTANT: WsClientState.subscribedProcess is a SINGLE-slot — when the
  // Wall mounts 10 tiles, each `subscribe(sessionId)` overwrites the slot.
  // Sessions don't actually use that slot for routing (the daemon routes
  // session events to every connected client), so multi-tile subscription
  // works in practice today. If that ever changes we'll need to make
  // session subscriptions multiplexed at the WS layer.
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

  useEffect(() => {
    if (session.state === 'running') return;
    if (!pendingHead) return;
    const text = popPendingSend(sessionId);
    if (text) wsClient.sendTurn(sessionId, text);
  }, [session.state, pendingHead, sessionId, popPendingSend]);

  const showBanner = cfg.showBanner && session.state === 'errored';

  // Apply density transforms (prose-only filter, tail limit).
  const displayMessages = useMemo<Message[]>(() => {
    let out = messages;
    if (cfg.proseOnly) {
      out = out.filter((m) => m.kind === 'user' || m.kind === 'assistant');
    }
    if (cfg.tailLimit !== null && out.length > cfg.tailLimit) {
      out = out.slice(-cfg.tailLimit);
    }
    return out;
  }, [messages, cfg.proseOnly, cfg.tailLimit]);

  const userMessages = useMemo(() => {
    if (!cfg.showPinnedPrompt) return [];
    const list: Array<{ id: string; text: string }> = [];
    for (const m of messages) {
      if (m.kind === 'user') list.push({ id: m.id, text: m.text });
    }
    return list;
  }, [messages, cfg.showPinnedPrompt]);

  // Wall / card streams: for compactness, suppress the in-flight reasoning
  // text from showing inside a tile — reasoning is usually long and floods
  // the small canvas. The assistant prose stream still shows.
  const passthroughReasoning = density === 'comfortable' ? reasoningStreaming : '';
  const passthroughTool = density === 'card' ? null : toolStreaming;

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
      {cfg.showHeader && (
        <SessionHeaderBar
          session={session}
          onToggleDetailPanel={() => setDetailPanelOpen(!detailPanelOpen)}
          projectName={isMobile ? projectName : undefined}
          onOpenDrawer={isMobile ? () => setMobileDrawerOpen(true) : undefined}
        />
      )}

      {showBanner && <ProcessBanner process={session} />}

      {/* Comfortable density wears a barely-there wash of the owning
          project's hue (fingerprint); wall/card tiles already self-tint via
          their wrappers, so they keep the flat canvas. */}
      <WorkspaceTint
        projectId={density === 'comfortable' ? session.projectId : null}
        variant="washed"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minHeight: 0,
          minWidth: 0,
          position: 'relative',
          ...(density === 'comfortable' ? null : { backgroundColor: 'var(--bg-primary)' }),
        }}
      >
        <ChatScroller
          persistKey={density === 'comfortable' ? sessionId : `${sessionId}:${density}`}
          pinnedHeader={
            userMessages.length > 0 ? <PinnedUserPrompt userMessages={userMessages} /> : null
          }
        >
          <MessageList
            messages={displayMessages}
            loading={loading}
            projectId={session.projectId}
            streamingText={streamingText}
            toolStreaming={passthroughTool}
            reasoningStreaming={passthroughReasoning}
            loaderVariant={session.loaderVariant ?? null}
            active={session.state === 'running'}
          />
        </ChatScroller>
        {cfg.showComposer &&
          (composerCollapsed ? (
            <button
              type="button"
              className="mt-composer-collapsed"
              onClick={(e) => {
                e.stopPropagation();
                setFocusedPane(sessionId);
              }}
              title="Click to compose"
            >
              <span className="mt-composer-collapsed-label">Click to type…</span>
              <span className="mt-composer-collapsed-hint">⏎</span>
            </button>
          ) : (
            <ChatInputCM
              processId={sessionId}
              projectId={session.projectId}
              state={session.state}
              attachmentKind="session"
              active={session.state === 'running'}
            />
          ))}
        {cfg.showPermissionBar && <PermissionBar sessionId={sessionId} />}
      </WorkspaceTint>
    </div>
  );
}
