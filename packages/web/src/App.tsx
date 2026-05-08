import React, { useEffect } from 'react';
import { Toaster, toast } from 'react-hot-toast';
import { Menu } from 'lucide-react';
import { Sidebar } from './components/sidebar/Sidebar';
import { MainPane } from './components/main-pane/MainPane';
import { StatusBar } from './components/status-bar/StatusBar';
import { CommandPalette } from './components/command-palette/CommandPalette';
import { OptionSelector } from './components/option/OptionSelector';
import { AddAgentModal } from './components/modals/AddAgentModal';
import { AddProcessModal } from './components/modals/AddProcessModal';
import { GlobalSettingsModal } from './components/modals/GlobalSettingsModal';
import { ProjectSettingsModal } from './components/modals/ProjectSettingsModal';
import { AddProjectModal } from './components/modals/AddProjectModal';
import { TouchToolbar } from './components/mobile/TouchToolbar';
import { IconButton } from './components/ui';
import { useAppStore } from './stores/appStore';
import { wsClient } from './lib/ws';
import { api } from './lib/api';
import { createRafBatch } from './lib/rafBatch';
import type { ToolStreamPayload } from './stores/appStore';
import { playPermissionChime, playAttentionChime, playDoneChime } from './lib/sound';
import { handleSessionAlert } from './lib/notify';
import { updateTabBadge } from './lib/tabBadge';
import { loadPrefs, subscribePrefs } from './lib/notificationPrefs';
import { useTheme } from './hooks/useTheme';
import { useIsMobile } from './lib/useIsMobile';
import { ConnectionOverlay } from './components/ConnectionOverlay';
import { NotificationCenter } from './components/notifications/NotificationCenter';
import { ElicitationModalHost } from './components/elicitation/ElicitationModal';
import { DevLogPanel } from './components/dev-log/DevLogPanel';
import type { Session } from './lib/types';

// Slow safety-net poll for sessions that are mid-turn. The primary path is
// event-driven (turn-complete, ws-reconnected, session:reconciled, focus,
// visibility); this just covers a daemon hang where no events ever arrive.
//
// 60s is well below the daemon's 5-minute no-progress watchdog (NO_PROGRESS_MS)
// and well above the 250ms reconcile delay codex uses. Previous value (15s)
// generated wasteful REST traffic during normal turns AND blocked the event
// loop on slow JSONL parses (observed 4.6s response on a busy daemon).
const RUNNING_SAFETY_POLL_MS = 60_000;

function App() {
  const store = useAppStore();
  useTheme();

  const isMobile = useIsMobile();
  const mobileDrawerOpen = store.mobileDrawerOpen;
  const setMobileDrawerOpen = store.setMobileDrawerOpen;

  // Close drawer when a process is selected on mobile
  useEffect(() => {
    if (isMobile) setMobileDrawerOpen(false);
  }, [store.selectedProcessId, isMobile, setMobileDrawerOpen]);

  // Hash-based deep links from external pagers (e.g. Telegram "Open in
  // dashboard" buttons). Supported:
  //   #permission=<promptId>  → navigate to the prompt's session
  //   #session=<sessionId>    → navigate directly to the session
  // For permission links we may arrive before the WS has populated
  // pendingPermissions, so we subscribe and resolve when the prompt shows
  // up (with a 30s timeout to give up cleanly).
  useEffect(() => {
    function parseHash(): { kind: 'permission' | 'session'; id: string } | null {
      const raw = window.location.hash.replace(/^#/, '');
      if (!raw) return null;
      const params = new URLSearchParams(raw);
      const permId = params.get('permission');
      if (permId) return { kind: 'permission', id: permId };
      const sessId = params.get('session');
      if (sessId) return { kind: 'session', id: sessId };
      return null;
    }

    function clearHash(): void {
      // Don't leave the deep-link in the URL after we've consumed it —
      // browser back/forward shouldn't re-trigger.
      try {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch {}
    }

    function tryResolve(target: { kind: 'permission' | 'session'; id: string }): boolean {
      const state = useAppStore.getState();
      if (target.kind === 'session') {
        if (state.sessions[target.id]) {
          state.setSelectedProcess(target.id);
          return true;
        }
        return false;
      }
      const prompt = state.pendingPermissions.find((p) => p.id === target.id);
      if (prompt) {
        state.setSelectedProcess(prompt.sessionId);
        return true;
      }
      return false;
    }

    const target = parseHash();
    if (!target) return;

    if (tryResolve(target)) {
      clearHash();
      return;
    }

    // Subscribe to store changes; resolve as soon as the relevant data lands.
    const unsub = useAppStore.subscribe(() => {
      if (tryResolve(target)) {
        clearHash();
        unsub();
      }
    });
    const timeout = setTimeout(() => {
      unsub();
      clearHash();
    }, 30_000);
    return () => {
      clearTimeout(timeout);
      unsub();
    };
  }, []);

  // Clear per-session unread alert badge when the session becomes selected.
  useEffect(() => {
    if (store.selectedProcessId) {
      useAppStore.getState().markSessionRead(store.selectedProcessId);
    }
  }, [store.selectedProcessId]);

  // Tab title + favicon badge — driven by total unread across all sessions.
  // Cleared automatically when the user gives the tab focus, since the
  // session-select effect above zeroes out the focused session's count.
  useEffect(() => {
    function totalUnread(): number {
      const prefs = loadPrefs();
      if (!prefs.showCenterBadge) return 0;
      const map = useAppStore.getState().unreadBySession;
      let n = 0;
      for (const v of Object.values(map)) n += v;
      return n;
    }
    updateTabBadge(totalUnread());
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.unreadBySession !== prev.unreadBySession) {
        updateTabBadge(totalUnread());
      }
    });
    const unsubPrefs = subscribePrefs(() => updateTabBadge(totalUnread()));
    function onVisible() {
      if (!document.hidden) updateTabBadge(totalUnread());
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsub();
      unsubPrefs();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // The merged SessionHeaderBar takes over as the mobile top bar when a session
  // is the focused process, so the app-level top bar is suppressed there.
  const focusedProject = store.projects.find((p) => p.id === store.focusedProjectId);
  const isSessionFocused = !!(
    store.selectedProcessId && store.sessions[store.selectedProcessId]
  );
  const showAppTopBar = isMobile && !isSessionFocused;

  useEffect(() => {
    // Connect WebSocket
    wsClient.connect();

    // Load projects and processes for ALL projects. Expanded state is a
    // pure frontend concern — backend processes stay alive regardless.
    // Called on mount and again on WS reconnect (e.g. after server restart).
    function loadData() {
      api.projects
        .list()
        .then(async projects => {
          store.setProjects(projects);
          if (projects.length === 0) return;

          // Restore expanded state from localStorage (intersect with known ids)
          let expanded: string[] = [];
          try {
            const raw = localStorage.getItem('mt:expandedProjectIds');
            if (raw) {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                const valid = new Set(projects.map(p => p.id));
                expanded = parsed.filter((x: unknown): x is string =>
                  typeof x === 'string' && valid.has(x)
                );
              }
            }
          } catch {
            // localStorage unavailable or corrupt; fall through to default
          }
          if (expanded.length === 0) {
            const initial = projects.find(p => p.isActive) ?? projects[0];
            expanded = [initial.id];
          }
          useAppStore.setState({
            expandedProjectIds: expanded,
            focusedProjectId: expanded[0] ?? null,
          });

          // Fetch processes for every project in parallel
          const triples = await Promise.all(
            projects.map(p =>
              Promise.all([
                api.sessions.list(p.id).catch(() => []),
                api.commands.list(p.id).catch(() => []),
                api.terminals.list(p.id).catch(() => []),
              ])
            )
          );
          const allSessions = triples.flatMap(([s]) => s);
          const allCommands = triples.flatMap(([, c]) => c);
          const allTerminals = triples.flatMap(([, , t]) => t);
          store.setSessions(allSessions);
          store.setCommands(allCommands);
          store.setTerminals(allTerminals);

          // Restore last-selected process so a refresh (or Chrome
          // backgrounding the tab on mobile) returns to the same screen
          // instead of dumping the user back on the dashboard. Only restore
          // if the id still exists in the loaded data — sessions may have
          // been deleted while the tab was away. Skip if a hash deep-link
          // is present; that path owns selection for this load.
          try {
            const hasDeepLink =
              window.location.hash.includes('session=') ||
              window.location.hash.includes('permission=');
            if (!hasDeepLink && useAppStore.getState().selectedProcessId === null) {
              const savedId = localStorage.getItem('mt:selectedProcessId');
              if (savedId) {
                const exists =
                  allSessions.some((s) => s.id === savedId) ||
                  allCommands.some((c) => c.id === savedId) ||
                  allTerminals.some((t) => t.id === savedId);
                if (exists) store.setSelectedProcess(savedId);
                else localStorage.removeItem('mt:selectedProcessId');
              }
            }
          } catch {
            // localStorage unavailable; stay on dashboard
          }
        })
        .catch(() => {
          // Daemon may not be running yet; WS reconnect will handle it
        });
    }

    loadData();

    // Persist expandedProjectIds to localStorage on every change
    const unsubPersist = useAppStore.subscribe((state, prev) => {
      if (state.expandedProjectIds !== prev.expandedProjectIds) {
        try {
          localStorage.setItem(
            'mt:expandedProjectIds',
            JSON.stringify(state.expandedProjectIds)
          );
        } catch {
          // ignore quota/availability errors
        }
      }
    });

    // Persist selectedProcessId so refresh / mobile-Chrome resume returns
    // to the same screen rather than the dashboard.
    const unsubPersistSelection = useAppStore.subscribe((state, prev) => {
      if (state.selectedProcessId !== prev.selectedProcessId) {
        try {
          if (state.selectedProcessId) {
            localStorage.setItem('mt:selectedProcessId', state.selectedProcessId);
          } else {
            localStorage.removeItem('mt:selectedProcessId');
          }
        } catch {
          // ignore quota/availability errors
        }
      }
    });

    const syncInFlight = new Set<string>();

    const upsertCanonicalSession = (incoming: Session) => {
      const live = useAppStore.getState();
      const existing = live.sessions[incoming.id];
      live.upsertSession(
        existing?.claudeState
          ? { ...incoming, claudeState: existing.claudeState }
          : incoming,
      );
    };

    // Codex SDK contract: runStreamed() is live progress; completed turns and
    // resumed threads are recovered from persisted session state. This keeps
    // WebSocket as a fast path while REST reconciliation remains authoritative.
    const syncSession = (sessionId: string, reason: string) => {
      if (syncInFlight.has(sessionId)) return;
      syncInFlight.add(sessionId);
      Promise.allSettled([
        api.sessions.get(sessionId),
        api.sessions.messages(sessionId),
      ])
        .then(([sessionRes, messagesRes]) => {
          if (sessionRes.status === 'fulfilled') {
            upsertCanonicalSession(sessionRes.value);
          } else {
            console.warn(`[sessions] failed to sync state for ${sessionId} (${reason})`, sessionRes.reason);
          }
          if (messagesRes.status === 'fulfilled') {
            useAppStore.getState().mergeMessages(sessionId, messagesRes.value.messages);
          } else {
            console.warn(`[sessions] failed to sync messages for ${sessionId} (${reason})`, messagesRes.reason);
          }
        })
        .finally(() => {
          syncInFlight.delete(sessionId);
        });
    };

    const activeSessionIds = () => {
      const live = useAppStore.getState();
      const ids = new Set<string>();
      for (const session of Object.values(live.sessions)) {
        const status = live.statusBySession[session.id]?.status ?? null;
        const hasStreaming = Boolean(live.streamingBySession[session.id]);
        const hasToolProgress = Boolean(live.toolProgressBySession[session.id]);
        if (session.state === 'running' || status !== null || hasStreaming || hasToolProgress) {
          ids.add(session.id);
        }
      }
      if (live.selectedProcessId && live.sessions[live.selectedProcessId]) {
        ids.add(live.selectedProcessId);
      }
      return [...ids];
    };

    const runningSessionIds = () => {
      const live = useAppStore.getState();
      const ids: string[] = [];
      for (const session of Object.values(live.sessions)) {
        if (session.state === 'running') ids.push(session.id);
      }
      return ids;
    };

    const syncActiveSessions = (reason: string) => {
      for (const sessionId of activeSessionIds()) {
        syncSession(sessionId, reason);
      }
    };

    const syncRunningSessions = (reason: string) => {
      for (const sessionId of runningSessionIds()) {
        syncSession(sessionId, reason);
      }
    };

    // Frame-batch the streaming WS handlers. Codex emits 4–10 deltas per
    // frame on a fast connection; calling Zustand setters that often busts
    // every selector subscriber and causes a render cycle per delta. The
    // batcher coalesces all deltas that arrive within one animation frame
    // into a single store update per (session, stream-kind), so the chat
    // re-renders at most once per displayed frame regardless of WS rate.
    // Latest-wins is correct here because the daemon emits cumulative text
    // (see manager-side StreamBuffer), so dropping intermediate values is
    // lossless visually.
    const assistantDeltaBatch = createRafBatch<string>((sid, text) =>
      useAppStore.getState().setStreamingText(sid, text),
    );
    const reasoningDeltaBatch = createRafBatch<string>((sid, text) =>
      useAppStore.getState().setReasoningStreaming(sid, text),
    );
    const toolDeltaBatch = createRafBatch<ToolStreamPayload | null>((sid, payload) =>
      useAppStore.getState().setToolStreaming(sid, payload),
    );

    const offs = [
      // Re-fetch all data when WS reconnects (e.g. after server restart)
      wsClient.on('ws:reconnected', () => {
        loadData();
        syncActiveSessions('ws-reconnected');
      }),
      wsClient.on('process-state-changed', (msg: any) => {
        const pid = msg.processId || msg.payload?.processId;
        if (pid) store.updateProcessState(pid, msg.payload.state);
      }),
      wsClient.on('process-metrics', (msg: any) => {
        const pid = msg.processId || msg.payload?.processId;
        if (pid) store.updateProcessMetrics(pid, msg.payload);
      }),
      wsClient.on('session:updated', (msg: any) => {
        // Preserve in-memory claudeState since the backend broadcasts the DB
        // row which doesn't carry transient stats.
        const incoming: Session = msg.payload.session;
        const existing = store.sessions[incoming.id];
        store.upsertSession(
          existing?.claudeState
            ? { ...incoming, claudeState: existing.claudeState }
            : incoming
        );
      }),
      wsClient.on('session:created', (msg: any) => {
        store.upsertSession(msg.payload.session);
      }),
      wsClient.on('session:deleted', (msg: any) => {
        store.removeSession(msg.payload.sessionId);
      }),
      wsClient.on('permission:prompt', (msg: any) => {
        store.addPermission(msg.payload.prompt);
        playPermissionChime();
      }),
      wsClient.on('permission:resolved', (msg: any) => {
        store.removePermission(msg.payload.id);
      }),
      wsClient.on('permission:expired', (msg: any) => {
        store.removePermission(msg.payload.id);
      }),
      wsClient.on('option:prompt', (msg: any) => {
        store.setOption(msg.payload);
      }),
      wsClient.on('session:notification', (msg: any) => {
        const { sessionId, payload } = msg.payload || {};
        const session = sessionId ? store.sessions[sessionId] : null;
        const name = session?.name ?? 'Claude';
        const message = payload?.message || 'Needs your attention';
        toast(`${name}: ${message}`, { duration: 5000 });
        playAttentionChime();
      }),
      wsClient.on('session:turn-complete', (msg: any) => {
        const sessionId = msg.processId;
        const live = useAppStore.getState();
        const session = sessionId ? live.sessions[sessionId] : null;
        const name = session?.name ?? 'Claude';
        if (sessionId) live.updateProcessState(sessionId, 'stopped');
        // Don't syncSession here — `session:reconciled` fires ~250ms later
        // with the daemon's authoritative disk-vs-memory diff and triggers
        // its own sync. Doing it twice just doubles the REST traffic.
        toast.success(`${name} is done`, { duration: 4000 });
        playDoneChime();
        // Pulse the sidebar for sessions the user isn't currently looking at —
        // turn-complete doesn't go through the alert envelope (intentional, to
        // keep the NotificationCenter free of every routine completion), so
        // bump the unread count manually for cross-session visibility.
        if (sessionId && live.selectedProcessId !== sessionId) {
          live.bumpUnread(sessionId);
        }
      }),
      wsClient.on('session:assistant-message', (msg: any) => {
        const pid = msg.processId || msg.payload?.processId;
        const messages = msg.payload?.messages;
        if (!pid || !Array.isArray(messages) || messages.length === 0) return;
        // End-of-stream swap. Subtle ordering bug we previously hit:
        //
        // The daemon emits assistant-message + turn-complete in the same WS
        // burst. WS handlers fire synchronously in arrival order, so in the
        // same JS task we run:
        //   1. assistant-message  (this handler)
        //   2. turn-complete #1   (state → 'stopped' → loader pales)
        //   3. turn-complete #2   (clears tool/reasoning streaming state)
        //
        // If we deferred the canonical-append via requestAnimationFrame,
        // React would commit step 2/3 in the current frame (with the
        // streaming bubble cleared but the canonical not yet added) — the
        // assistant slot vanishes for one frame, the loader pops up, then
        // rAF fires and the canonical lands and the loader pops back down.
        // That's the visible up-and-down jump.
        //
        // Microtask defer fixes it: the canonical-append + streamingText
        // clear runs at the END of the current task (after all sibling WS
        // handlers) but BEFORE React commits the batch. So the single
        // committed render has both `streamingText=''` AND canonical
        // present — clean swap, no gap, no loader shift.
        //
        // flushNow first so the queued rAF delta lands in the same React
        // batch — the streaming bubble's last-visible text matches the
        // canonical text it's about to be replaced by.
        assistantDeltaBatch.flushNow();
        queueMicrotask(() => {
          const s = useAppStore.getState();
          s.appendMessages(pid, messages);
          s.setStreamingText(pid, '');
        });
      }),
      wsClient.on('session:assistant-delta', (msg: any) => {
        const pid = msg.processId || msg.payload?.processId;
        const text = msg.payload?.text;
        if (pid && typeof text === 'string') {
          assistantDeltaBatch.set(pid, text);
        }
      }),
      wsClient.on('session:tool-delta', (msg: any) => {
        const pid = msg.processId || msg.payload?.processId;
        const payload = msg.payload?.payload ?? null;
        if (!pid) return;
        if (payload === null) {
          toolDeltaBatch.set(pid, null);
          return;
        }
        if (
          typeof payload === 'object' &&
          typeof payload.toolName === 'string' &&
          typeof payload.output === 'string'
        ) {
          toolDeltaBatch.set(pid, {
            toolName: payload.toolName,
            input: payload.input,
            output: payload.output,
            isError: !!payload.isError,
          });
        }
      }),
      wsClient.on('session:reasoning-delta', (msg: any) => {
        const pid = msg.processId || msg.payload?.processId;
        const text = msg.payload?.text;
        if (pid && typeof text === 'string') {
          reasoningDeltaBatch.set(pid, text);
        }
      }),
      wsClient.on('git:status-changed', (msg: any) => {
        const projectId = msg.payload?.projectId;
        const status = msg.payload?.status;
        if (typeof projectId === 'string' && status) {
          store.setGitStatus(projectId, status);
        }
      }),
      wsClient.on('session:tool-event', (msg: any) => {
        const pid = msg.processId || msg.payload?.processId;
        const messages = msg.payload?.messages;
        if (pid && Array.isArray(messages) && messages.length > 0) {
          store.appendMessages(pid, messages);
        }
      }),
      wsClient.on('session:user-message', (msg: any) => {
        const pid = msg.processId || msg.payload?.processId;
        const messages = msg.payload?.messages;
        if (pid && Array.isArray(messages) && messages.length > 0) {
          store.appendMessages(pid, messages);
        }
      }),
      wsClient.on('session:turn-error', (msg: any) => {
        const message = msg.payload?.message || 'Turn failed';
        const pid = msg.processId;
        const session = pid ? store.sessions[pid] : null;
        const name = session?.name ?? 'Agent';
        toast.error(`${name}: ${message}`, { duration: 6000, style: { maxWidth: 480 } });
        // The daemon already pushes a canonical "Turn failed: ..." system
        // message and broadcasts it via session:tool-event, so don't append a
        // second copy here — that would put two error bubbles in the chat.
        if (pid) {
          assistantDeltaBatch.remove(pid);
          store.setStreamingText(pid, '');
        }
      }),
      wsClient.on('session:reconciled', (msg: any) => {
        // Daemon just confirmed disk == in-memory after a turn. Pull the
        // canonical messages snapshot so the store mirrors authoritative
        // state — covers any item the live WS stream dropped.
        const sessionId = msg.processId || msg.payload?.sessionId;
        if (typeof sessionId === 'string') syncSession(sessionId, 'reconciled');
      }),
      wsClient.on('session:message-rekeyed', (msg: any) => {
        // Daemon paired an optimistic message with its canonical id (e.g.
        // user prompt's `turn-...` id → `codex:...:user:0`). Update the id
        // in place so subsequent dedup is pure id match.
        const sessionId = msg.processId || msg.payload?.sessionId;
        const oldId = msg.payload?.oldId;
        const newId = msg.payload?.newId;
        if (typeof sessionId === 'string' && typeof oldId === 'string' && typeof newId === 'string') {
          store.rekeyMessage(sessionId, oldId, newId);
        }
      }),
      wsClient.on('session:send-error', (msg: any) => {
        const message = msg.payload?.message || 'Send failed';
        const pid = msg.processId || msg.payload?.processId;
        toast.error(message, { duration: 4000 });
        if (pid) {
          store.appendMessages(pid, [
            {
              id: `send-error-${Date.now()}`,
              ts: Date.now(),
              kind: 'system',
              text: `Send failed: ${message}`,
            },
          ]);
        }
      }),
      wsClient.on('session:alert', (msg: any) => {
        const alert = msg.payload?.alert;
        if (alert && typeof alert === 'object' && alert.alertId) {
          handleSessionAlert(alert);
        }
      }),
      wsClient.on('session:elicitation:prompt', (msg: any) => {
        const prompt = msg.payload?.prompt;
        if (prompt && typeof prompt === 'object' && prompt.id) {
          useAppStore.getState().addElicitation(prompt);
        }
      }),
      wsClient.on('session:elicitation:resolved', (msg: any) => {
        const id = msg.payload?.id;
        if (typeof id === 'string') useAppStore.getState().removeElicitation(id);
      }),
      wsClient.on('session:elicitation:expired', (msg: any) => {
        const id = msg.payload?.id;
        if (typeof id === 'string') useAppStore.getState().removeElicitation(id);
      }),
      wsClient.on('session:task-event', (msg: any) => {
        const sessionId = msg.processId || msg.payload?.sessionId;
        const subtype = msg.payload?.subtype;
        const payload = msg.payload?.payload;
        if (typeof sessionId === 'string' && typeof subtype === 'string' && payload && typeof payload === 'object') {
          useAppStore.getState().applyTaskEvent(sessionId, subtype, payload);
        }
      }),
      wsClient.on('session:tool-progress', (msg: any) => {
        const sessionId = msg.processId || msg.payload?.sessionId;
        const p = msg.payload;
        if (typeof sessionId !== 'string' || !p) return;
        useAppStore.getState().setToolProgress(sessionId, {
          toolUseId: typeof p.toolUseId === 'string' ? p.toolUseId : '',
          toolName: typeof p.toolName === 'string' ? p.toolName : '',
          elapsedSeconds: typeof p.elapsedSeconds === 'number' ? p.elapsedSeconds : 0,
          taskId: typeof p.taskId === 'string' ? p.taskId : null,
          parentToolUseId: typeof p.parentToolUseId === 'string' ? p.parentToolUseId : null,
          receivedAt: Date.now(),
        });
      }),
      wsClient.on('session:status', (msg: any) => {
        const sessionId = msg.processId || msg.payload?.sessionId;
        const p = msg.payload;
        if (typeof sessionId !== 'string' || !p) return;
        const status = p.status === 'compacting' || p.status === 'requesting' ? p.status : null;
        useAppStore.getState().setSessionStatus(sessionId, status === null ? { status: null } : { status, compactResult: p.compactResult ?? null, compactError: p.compactError ?? null });
      }),
      // Clear stale tool-progress when a turn completes — the SDK doesn't send a
      // "tool stopped" event so we infer it from turn boundaries.
      //
      // We deliberately do NOT clear streamingText here. The
      // `session:assistant-message` handler owns that clear via a microtask
      // so the canonical message lands in the same render as the clear —
      // otherwise the streaming bubble vanishes one frame before canonical
      // arrives, and the loader visibly bounces (see assistant-message
      // handler comment). For turns that end without an assistant-message
      // (aborts, errors, tool-only turns) the `session:idle` handler clears
      // streamingText below.
      wsClient.on('session:turn-complete', (msg: any) => {
        const sessionId = msg.processId;
        if (typeof sessionId === 'string') {
          const live = useAppStore.getState();
          live.setToolProgress(sessionId, null);
          live.setSessionStatus(sessionId, { status: null });
          live.setToolStreaming(sessionId, null);
          live.setReasoningStreaming(sessionId, '');
        }
      }),
      // session:idle — universal "agent loop done, ready for next user turn"
      // signal. Distinct from turn-complete in that it carries the outcome
      // (completed / aborted / watchdog / error) so the composer can react
      // appropriately (focus on completed, show retry on watchdog, etc.).
      wsClient.on('session:idle', (msg: any) => {
        const sessionId = msg.processId;
        const outcome = msg.payload?.outcome ?? 'completed';
        if (typeof sessionId !== 'string') return;
        const live = useAppStore.getState();
        live.setSessionIdle(sessionId, outcome);
        // Belt-and-braces: if the turn ended WITHOUT a final assistant
        // message (aborts, errors, tool-only turns), the streaming text
        // wasn't cleared by the assistant-message microtask. Drop any
        // residual partial here so a stale bubble doesn't linger.
        if (outcome !== 'completed') {
          assistantDeltaBatch.remove(sessionId);
          live.setStreamingText(sessionId, '');
        }
      }),
      // session:mode-changed — broadcast when the operating mode flips.
      // Update store so the mode badge re-renders without polling.
      wsClient.on('session:mode-changed', (msg: any) => {
        const { sessionId, mode } = msg.payload || {};
        if (typeof sessionId !== 'string' || typeof mode !== 'string') return;
        const session = useAppStore.getState().sessions[sessionId];
        if (!session) return;
        useAppStore.getState().upsertSession({ ...session, mode } as Session);
      }),
      wsClient.on('session:state-updated', (msg: any) => {
        // The daemon's AgentSessionManager broadcasts a snapshot of cost,
        // tokens, currentTool, etc. on every SDK `result` and on each tool
        // hook. Mirror it onto the session's `claudeState` so SessionHeaderBar
        // and the /cost slash command see live numbers. Use getState() rather
        // than the closure's stale store snapshot.
        const { sessionId, state } = msg.payload || {};
        if (!sessionId || !state) return;
        const session = useAppStore.getState().sessions[sessionId];
        if (!session) return;
        useAppStore.getState().upsertSession({
          ...session,
          claudeState: {
            agentProvider: state.agentProvider ?? state.provider ?? session.agentProvider,
            agentSessionId: state.agentSessionId ?? state.claudeSessionId ?? session.claudeState?.agentSessionId ?? null,
            claudeSessionId: state.claudeSessionId ?? state.agentSessionId ?? session.claudeState?.claudeSessionId ?? null,
            currentTool: state.currentTool ?? null,
            toolCount: state.toolCount ?? 0,
            tokenCount: state.tokenCount ?? 0,
            costUsd: state.costUsd ?? 0,
            lastActivity: state.lastActivity ?? Date.now(),
            activeSubagents: state.activeSubagents ?? 0,
            userMessages: state.userMessages ?? session.claudeState?.userMessages ?? [],
          },
        } as Session);
      }),
    ];

    // Slow safety-net poll: only fires for sessions stuck in `running`. The
    // primary correctness path is event-driven (turn-complete, reconciled,
    // ws-reconnected, focus, visibility); this just guards against a daemon
    // hang where no events ever arrive. At idle this issues zero requests.
    const syncTimer = window.setInterval(() => {
      syncRunningSessions('running-safety-poll');
    }, RUNNING_SAFETY_POLL_MS);

    const syncOnVisible = () => {
      if (!document.hidden) syncActiveSessions('visible');
    };
    const syncOnFocus = () => syncActiveSessions('focus');
    document.addEventListener('visibilitychange', syncOnVisible);
    window.addEventListener('focus', syncOnFocus);

    return () => {
      offs.forEach(off => off());
      assistantDeltaBatch.cancel();
      reasoningDeltaBatch.cancel();
      toolDeltaBatch.cancel();
      window.clearInterval(syncTimer);
      document.removeEventListener('visibilitychange', syncOnVisible);
      window.removeEventListener('focus', syncOnFocus);
      unsubPersist();
      unsubPersistSelection();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global keybinding: Ctrl/Cmd+Shift+L toggles the Dev Log panel.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        const { devLogOpen, setDevLogOpen } = useAppStore.getState();
        setDevLogOpen(!devLogOpen);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      className="mt-app-shell"
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        backgroundColor: 'var(--bg-primary)',
      }}
    >
      {/* Mobile top bar — only when no session is focused; SessionHeaderBar
          takes over as the mobile header on session views. */}
      {showAppTopBar && (
        <div style={{
          height: 52,
          display: 'flex',
          alignItems: 'center',
          padding: '0 10px',
          backgroundColor: 'var(--bg-sidebar)',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          gap: 10,
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}>
          <IconButton
            size="lg"
            onClick={() => setMobileDrawerOpen(!mobileDrawerOpen)}
            label="Open menu"
          >
            <Menu size={20} />
          </IconButton>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {focusedProject?.name || 'MultiTable'}
          </span>
        </div>
      )}

      {/* Mobile drawer overlay */}
      {isMobile && mobileDrawerOpen && (
        <>
          <div
            onClick={() => setMobileDrawerOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              backgroundColor: 'var(--bg-overlay)',
              backdropFilter: 'blur(6px) saturate(1.1)',
              WebkitBackdropFilter: 'blur(6px) saturate(1.1)',
              zIndex: 900,
              animation: 'mt-fade-in var(--dur-fast) var(--ease-out)',
            }}
          />
          <div
            className="mt-scroll"
            style={{
              position: 'fixed', top: 0, left: 0, bottom: 0, width: 300,
              zIndex: 901, backgroundColor: 'var(--bg-sidebar)',
              boxShadow: 'var(--shadow-xl)',
              transform: 'translateX(0)',
              animation: 'mt-slide-up var(--dur-med) var(--ease-out)',
              overflowY: 'auto',
            }}
          >
            <Sidebar />
          </div>
        </>
      )}

      {/* Main content area */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {!isMobile && <Sidebar />}
        <MainPane />
      </div>

      <OptionSelector />
      {!isMobile && <StatusBar />}
      {isMobile && <TouchToolbar />}
      <CommandPalette />
      <NotificationCenter />
      <ElicitationModalHost />
      <ConnectionOverlay />
      <DevLogPanel />
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            fontSize: 13,
            boxShadow: 'var(--shadow-lg)',
          },
          success: {
            iconTheme: {
              primary: 'var(--status-running)',
              secondary: 'var(--bg-elevated)',
            },
          },
          error: {
            iconTheme: {
              primary: 'var(--status-error)',
              secondary: 'var(--bg-elevated)',
            },
          },
        }}
      />
      {store.addAgentModalOpen && store.focusedProjectId && (
        <AddAgentModal
          projectId={store.focusedProjectId}
          onClose={() => store.setAddAgentModalOpen(false)}
        />
      )}
      {store.addProcessModalOpen && store.focusedProjectId && (
        <AddProcessModal
          projectId={store.focusedProjectId}
          onClose={() => store.setAddProcessModalOpen(false)}
        />
      )}
      {store.globalSettingsOpen && (
        <GlobalSettingsModal
          onClose={() => store.setGlobalSettingsOpen(false)}
        />
      )}
      {store.projectSettingsOpen && (() => {
        const project = store.projects.find(p => p.id === store.focusedProjectId);
        return project ? (
          <ProjectSettingsModal
            project={project}
            onClose={() => store.setProjectSettingsOpen(false)}
          />
        ) : null;
      })()}
      {store.addProjectModalOpen && (
        <AddProjectModal
          onClose={() => store.setAddProjectModalOpen(false)}
        />
      )}
    </div>
  );
}

export default App;
