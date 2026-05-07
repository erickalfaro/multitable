import { create } from 'zustand';
import type {
  Project,
  Session,
  Command,
  Terminal,
  PermissionPrompt,
  OptionPrompt,
  ProcessState,
  ProcessMetrics,
  Message,
  SessionAlert,
  ElicitationPrompt,
  GitStatusSummary,
} from '../lib/types';
import type { Theme, ThemeColors } from '../lib/themes';
import {
  BUILTIN_THEMES,
  BUILTIN_DARK,
  loadCustomThemesFromStorage,
  loadActiveThemeIdFromStorage,
  saveCustomThemesToStorage,
  saveActiveThemeIdToStorage,
} from '../lib/themes';

interface AppState {
  // Projects
  projects: Project[];
  expandedProjectIds: string[];
  focusedProjectId: string | null;
  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  updateProject: (project: Project) => void;
  removeProject: (id: string) => void;
  expandProject: (id: string) => void;
  collapseProject: (id: string) => void;
  toggleProjectExpanded: (id: string) => void;
  setFocusedProject: (id: string | null) => void;
  setExpandedProjects: (ids: string[]) => void;

  // Processes (sessions, commands, terminals keyed by id)
  sessions: Record<string, Session>;
  commands: Record<string, Command>;
  terminals: Record<string, Terminal>;
  setSessions: (sessions: Session[]) => void;
  setCommands: (commands: Command[]) => void;
  setTerminals: (terminals: Terminal[]) => void;
  mergeSessions: (sessions: Session[]) => void;
  mergeCommands: (commands: Command[]) => void;
  mergeTerminals: (terminals: Terminal[]) => void;
  updateProcessState: (id: string, state: ProcessState) => void;
  updateProcessMetrics: (id: string, metrics: Partial<ProcessMetrics>) => void;
  upsertSession: (session: Session) => void;
  removeSession: (id: string) => void;
  upsertCommand: (command: Command) => void;
  removeCommand: (id: string) => void;

  // Terminals upsert/remove
  upsertTerminal: (terminal: Terminal) => void;
  removeTerminal: (id: string) => void;

  // UI
  selectedProcessId: string | null;
  sidebarCollapsed: boolean;
  customThemes: Theme[];
  activeThemeId: string;
  commandPaletteOpen: boolean;
  addAgentModalOpen: boolean;
  addProcessModalOpen: boolean;
  addProjectModalOpen: boolean;
  globalSettingsOpen: boolean;
  projectSettingsOpen: boolean;
  detailPanelOpen: boolean;
  detailPanelTab: 'files' | 'diff' | 'cost' | 'prompts' | 'brainstorm' | 'tasks';
  connectionState: 'connected' | 'reconnecting' | 'disconnected';
  projectOverviewOpen: boolean;
  contextMenu: { type: string; id: string; x: number; y: number } | null;
  mobileDrawerOpen: boolean;
  devLogOpen: boolean;
  setDevLogOpen: (open: boolean) => void;
  setSelectedProcess: (id: string | null) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setActiveTheme: (id: string) => void;
  addCustomTheme: (theme: Theme) => void;
  updateCustomTheme: (id: string, patch: { name?: string; colors?: Partial<ThemeColors>; isDark?: boolean }) => void;
  deleteCustomTheme: (id: string) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setAddAgentModalOpen: (open: boolean) => void;
  setAddProcessModalOpen: (open: boolean) => void;
  setAddProjectModalOpen: (open: boolean) => void;
  setGlobalSettingsOpen: (open: boolean) => void;
  setProjectSettingsOpen: (open: boolean) => void;
  setDetailPanelOpen: (open: boolean) => void;
  setDetailPanelTab: (tab: 'files' | 'diff' | 'cost' | 'prompts' | 'brainstorm' | 'tasks') => void;
  setConnectionState: (state: 'connected' | 'reconnecting' | 'disconnected') => void;
  setProjectOverviewOpen: (open: boolean) => void;
  setContextMenu: (menu: { type: string; id: string; x: number; y: number } | null) => void;
  setMobileDrawerOpen: (open: boolean) => void;

  // Permissions
  pendingPermissions: PermissionPrompt[];
  addPermission: (prompt: PermissionPrompt) => void;
  removePermission: (id: string) => void;

  // Options
  currentOption: OptionPrompt | null;
  setOption: (option: OptionPrompt | null) => void;

  // Session transcript messages (chat view)
  messagesBySession: Record<string, Message[]>;
  setMessages: (sessionId: string, messages: Message[]) => void;
  appendMessages: (sessionId: string, messages: Message[]) => void;
  /** Merge a fetched batch with already-stored messages; dedupes by id, sorts by ts. */
  mergeMessages: (sessionId: string, messages: Message[]) => void;
  clearMessages: (sessionId: string) => void;
  /**
   * Rename a message id in place. Fired by the daemon's `session:message-rekeyed`
   * event when an optimistic message is reconciled to its canonical id —
   * keeps id-based dedup working without text-matching heuristics.
   */
  rekeyMessage: (sessionId: string, oldId: string, newId: string) => void;

  /**
   * In-flight streaming text for the current assistant turn (one per session,
   * non-empty only while the SDK is emitting `text_delta` events). The chat
   * view renders this as an extra "live" assistant bubble at the end of the
   * messages list; cleared the moment the canonical `assistant-message` lands
   * or the turn ends.
   */
  streamingBySession: Record<string, string>;
  setStreamingText: (sessionId: string, text: string) => void;

  /**
   * Live in-progress tool execution snapshot from Codex item.updated events.
   * Rendered as a transient "running" tool card; cleared the moment the
   * canonical tool_use/tool_result messages arrive at item.completed.
   */
  toolStreamingBySession: Record<string, ToolStreamPayload | null>;
  setToolStreaming: (sessionId: string, payload: ToolStreamPayload | null) => void;

  /**
   * Live model-reasoning text (chain-of-thought). Italic preview that gets
   * replaced by the canonical `Reasoning: …` system message when complete.
   */
  reasoningStreamingBySession: Record<string, string>;
  setReasoningStreaming: (sessionId: string, text: string) => void;

  /**
   * Last "agent loop done" outcome per session, keyed by sessionId. Mirrors
   * the daemon's `session:idle` WS event. Components like the chat composer
   * read this to decide whether to focus the input (clean completion), show a
   * retry hint (watchdog timeout), or stay quiet (user-initiated abort).
   * `null` means no idle event has been observed yet (or session is mid-turn).
   */
  idleBySession: Record<string, 'completed' | 'aborted' | 'watchdog' | 'error' | null>;
  setSessionIdle: (
    sessionId: string,
    outcome: 'completed' | 'aborted' | 'watchdog' | 'error',
  ) => void;

  // Live git status per project — populated by REST fetch on panel mount and
  // refreshed by `git:status-changed` WS events from the daemon's GitWatcher.
  gitByProject: Record<string, GitStatusSummary>;
  setGitStatus: (projectId: string, status: GitStatusSummary) => void;

  // Alerts (notification history + per-session unread counts)
  alerts: SessionAlert[];
  unreadBySession: Record<string, number>;
  notificationCenterOpen: boolean;
  addAlert: (alert: SessionAlert) => void;
  dismissAlert: (alertId: string) => void;
  markSessionRead: (sessionId: string) => void;
  /** Increment unread count for a session without going through the alert envelope. */
  bumpUnread: (sessionId: string) => void;
  clearAllAlerts: () => void;
  setNotificationCenterOpen: (open: boolean) => void;

  // Elicitations (MCP form/url prompts)
  pendingElicitations: ElicitationPrompt[];
  addElicitation: (prompt: ElicitationPrompt) => void;
  removeElicitation: (id: string) => void;

  // Per-session live task list (driven by session:task-event)
  tasksBySession: Record<string, TaskEntry[]>;
  applyTaskEvent: (sessionId: string, subtype: string, payload: Record<string, unknown>) => void;

  // Per-session tool progress (most-recent only) and status spinner
  toolProgressBySession: Record<string, ToolProgress | null>;
  setToolProgress: (sessionId: string, progress: ToolProgress | null) => void;
  statusBySession: Record<string, SessionStatus>;
  setSessionStatus: (sessionId: string, status: SessionStatus) => void;

  // Per-session client-side send queue. While a turn is running, the user
  // can keep typing and queue more messages; SessionChat drains the queue
  // when the turn completes (one sendTurn per state-transition tick).
  pendingSendsBySession: Record<string, string[]>;
  enqueueSend: (sessionId: string, text: string) => void;
  removePendingSend: (sessionId: string, index: number) => void;
  popPendingSend: (sessionId: string) => string | undefined;
  clearPendingSends: (sessionId: string) => void;
}

export type TaskState = 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'stopped' | 'unknown';

export interface TaskEntry {
  taskId: string;
  description: string;
  state: TaskState;
  taskType?: string;
  workflowName?: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  lastToolName?: string;
  summary?: string;
  outputFile?: string;
  startedAt: number;
  endedAt?: number;
  isBackgrounded?: boolean;
  skipTranscript?: boolean;
}

export interface ToolProgress {
  toolUseId: string;
  toolName: string;
  elapsedSeconds: number;
  taskId: string | null;
  parentToolUseId: string | null;
  receivedAt: number;
}

export type SessionStatus =
  | { status: null }
  | { status: 'compacting' | 'requesting'; compactResult?: 'success' | 'failed' | null; compactError?: string | null };

export interface ToolStreamPayload {
  toolName: string;
  input: unknown;
  output: string;
  isError: boolean;
}

// Cap alert history so an unattended user doesn't grow it indefinitely.
const MAX_ALERT_HISTORY = 200;

// Dedup is strictly id-based for real content. The daemon emits canonical ids
// on both the live WS path and the REST refresh path, so id equality is the
// right check. The narrow fingerprint fallback below ONLY applies to system
// messages whose ids are client- or daemon-synthesized stopgaps that can
// legitimately collide on reconnect (`turn-error-…`, `send-error-…`,
// `codex-event-error-…`, `codex:…:turn-error:…`). User/assistant/tool content
// is never text-deduped — re-typing the same prompt or re-running the same
// tool is a legitimate action that must not be silently dropped.
//
// Optimistic user pushes (id starts with `turn-`) get a different treatment:
// the daemon emits a `session:message-rekeyed` event when reconcile assigns
// the canonical id, and the frontend updates the existing message's id in
// place. That way two real "yo"s sent in different turns never get falsely
// collapsed by content matching.
function isTransientErrorId(id: string): boolean {
  if (!id) return false;
  return (
    id.startsWith('turn-error') ||
    id.startsWith('send-error') ||
    id.startsWith('codex-event-error') ||
    id.includes(':turn-error:')
  );
}

function normalizedText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function transientErrorFingerprint(m: Message): string | null {
  if (!isTransientErrorId(m.id)) return null;
  if (m.kind === 'system') return `system:${normalizedText(m.text)}`;
  return null;
}

function isDuplicateMessage(a: Message, b: Message): boolean {
  if (a.id === b.id) return true;
  // Narrow fallback for transient error/notice system messages only.
  const fa = transientErrorFingerprint(a);
  if (!fa) return false;
  const fb = transientErrorFingerprint(b);
  if (!fb) return false;
  return fa === fb;
}

function appendDeduped(existing: Message[], incoming: Message[]): Message[] {
  const out = [...existing];
  for (const msg of incoming) {
    if (out.some((seen) => isDuplicateMessage(seen, msg))) continue;
    out.push(msg);
  }
  return out;
}

// Strict id-based dedup. Used as a final safety pass in mergeMessages so any
// historical corruption (a previous buggy merge that left two entries with
// the same id) self-heals on the next sync rather than producing React
// "duplicate key" warnings indefinitely. Keeps the FIRST occurrence.
function dedupById(messages: Message[]): Message[] {
  const seen = new Set<string>();
  const out: Message[] = [];
  for (const m of messages) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

export const useAppStore = create<AppState>((set, get) => ({
  // Projects
  projects: [],
  expandedProjectIds: [],
  focusedProjectId: null,
  setProjects: (projects) => set({ projects }),
  addProject: (project) => set((s) => ({ projects: [...s.projects, project] })),
  updateProject: (project) =>
    set((s) => ({
      projects: s.projects.map((p) => (p.id === project.id ? { ...p, ...project } : p)),
    })),
  removeProject: (id) =>
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      expandedProjectIds: s.expandedProjectIds.filter((pid) => pid !== id),
      focusedProjectId:
        s.focusedProjectId === id
          ? s.expandedProjectIds.find((pid) => pid !== id) ?? null
          : s.focusedProjectId,
    })),
  expandProject: (id) =>
    set((s) => ({
      expandedProjectIds: s.expandedProjectIds.includes(id)
        ? s.expandedProjectIds
        : [...s.expandedProjectIds, id],
      focusedProjectId: id,
    })),
  collapseProject: (id) =>
    set((s) => {
      const next = s.expandedProjectIds.filter((pid) => pid !== id);
      return {
        expandedProjectIds: next,
        focusedProjectId:
          s.focusedProjectId === id ? next[0] ?? null : s.focusedProjectId,
      };
    }),
  toggleProjectExpanded: (id) => {
    const { expandedProjectIds, expandProject, collapseProject } = get();
    if (expandedProjectIds.includes(id)) collapseProject(id);
    else expandProject(id);
  },
  setFocusedProject: (id) => set({ focusedProjectId: id }),
  setExpandedProjects: (ids) => set({ expandedProjectIds: ids }),

  // Processes
  sessions: {},
  commands: {},
  terminals: {},
  setSessions: (sessions) =>
    set({ sessions: Object.fromEntries(sessions.map(s => [s.id, s])) }),
  setCommands: (commands) =>
    set({ commands: Object.fromEntries(commands.map(c => [c.id, c])) }),
  setTerminals: (terminals) =>
    set({ terminals: Object.fromEntries(terminals.map(t => [t.id, t])) }),
  mergeSessions: (sessions) =>
    set((s) => ({
      sessions: { ...s.sessions, ...Object.fromEntries(sessions.map(x => [x.id, x])) },
    })),
  mergeCommands: (commands) =>
    set((s) => ({
      commands: { ...s.commands, ...Object.fromEntries(commands.map(x => [x.id, x])) },
    })),
  mergeTerminals: (terminals) =>
    set((s) => ({
      terminals: { ...s.terminals, ...Object.fromEntries(terminals.map(x => [x.id, x])) },
    })),
  updateProcessState: (id, state) =>
    set((s) => {
      const sessions = { ...s.sessions };
      const commands = { ...s.commands };
      const terminals = { ...s.terminals };
      if (id in sessions) sessions[id] = { ...sessions[id], state };
      if (id in commands) commands[id] = { ...commands[id], state };
      if (id in terminals) terminals[id] = { ...terminals[id], state };
      return { sessions, commands, terminals };
    }),
  updateProcessMetrics: (id, metrics) =>
    set((s) => {
      const sessions = { ...s.sessions };
      const commands = { ...s.commands };
      if (id in sessions)
        sessions[id] = { ...sessions[id], metrics: { ...sessions[id].metrics, ...metrics } };
      if (id in commands)
        commands[id] = { ...commands[id], metrics: { ...commands[id].metrics, ...metrics } };
      return { sessions, commands };
    }),
  upsertSession: (session) =>
    set((s) => ({ sessions: { ...s.sessions, [session.id]: session } })),
  removeSession: (id) =>
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      return { sessions };
    }),
  upsertCommand: (command) =>
    set((s) => ({ commands: { ...s.commands, [command.id]: command } })),
  removeCommand: (id) =>
    set((s) => {
      const commands = { ...s.commands };
      delete commands[id];
      return { commands };
    }),
  upsertTerminal: (terminal) =>
    set((s) => ({ terminals: { ...s.terminals, [terminal.id]: terminal } })),
  removeTerminal: (id) =>
    set((s) => {
      const terminals = { ...s.terminals };
      delete terminals[id];
      return { terminals };
    }),

  // UI
  selectedProcessId: null,
  sidebarCollapsed: false,
  customThemes: loadCustomThemesFromStorage(),
  activeThemeId: (() => {
    const stored = loadActiveThemeIdFromStorage();
    const customs = loadCustomThemesFromStorage();
    const all = [...BUILTIN_THEMES, ...customs];
    if (stored && all.some((t) => t.id === stored)) return stored;
    return BUILTIN_DARK.id;
  })(),
  commandPaletteOpen: false,
  addAgentModalOpen: false,
  addProcessModalOpen: false,
  addProjectModalOpen: false,
  globalSettingsOpen: false,
  projectSettingsOpen: false,
  detailPanelOpen: false,
  detailPanelTab: 'brainstorm',
  // Start optimistic. The fullscreen "Cannot connect to daemon" overlay is
  // intrusive — only show it after a real connect attempt has failed, never
  // during the initial mount window. ws.connect() flips this to 'reconnecting'
  // and then 'connected' as the handshake progresses.
  connectionState: 'connected',
  projectOverviewOpen: false,
  contextMenu: null,
  mobileDrawerOpen: false,
  devLogOpen: (() => {
    try {
      return localStorage.getItem('mt:devLogOpen') === '1';
    } catch {
      return false;
    }
  })(),
  setDevLogOpen: (open) => {
    try {
      localStorage.setItem('mt:devLogOpen', open ? '1' : '0');
    } catch {
      // ignore
    }
    set({ devLogOpen: open });
  },
  setSelectedProcess: (id) =>
    set((s) => {
      if (id === null) return { selectedProcessId: null };
      const proc = s.sessions[id] || s.commands[id] || s.terminals[id];
      if (!proc) return { selectedProcessId: id };
      return {
        selectedProcessId: id,
        focusedProjectId: proc.projectId,
      };
    }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setActiveTheme: (id) =>
    set(() => {
      saveActiveThemeIdToStorage(id);
      return { activeThemeId: id };
    }),
  addCustomTheme: (theme) =>
    set((s) => {
      const next = [...s.customThemes, theme];
      saveCustomThemesToStorage(next);
      return { customThemes: next };
    }),
  updateCustomTheme: (id, patch) =>
    set((s) => {
      const next = s.customThemes.map((t) =>
        t.id === id
          ? {
              ...t,
              name: patch.name ?? t.name,
              isDark: patch.isDark ?? t.isDark,
              colors: patch.colors ? { ...t.colors, ...patch.colors } : t.colors,
            }
          : t
      );
      saveCustomThemesToStorage(next);
      return { customThemes: next };
    }),
  deleteCustomTheme: (id) =>
    set((s) => {
      const next = s.customThemes.filter((t) => t.id !== id);
      saveCustomThemesToStorage(next);
      const activeId = s.activeThemeId === id ? BUILTIN_DARK.id : s.activeThemeId;
      if (activeId !== s.activeThemeId) saveActiveThemeIdToStorage(activeId);
      return { customThemes: next, activeThemeId: activeId };
    }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setAddAgentModalOpen: (open) => set({ addAgentModalOpen: open }),
  setAddProcessModalOpen: (open) => set({ addProcessModalOpen: open }),
  setAddProjectModalOpen: (open) => set({ addProjectModalOpen: open }),
  setGlobalSettingsOpen: (open) => set({ globalSettingsOpen: open }),
  setProjectSettingsOpen: (open) => set({ projectSettingsOpen: open }),
  setDetailPanelOpen: (open) => set({ detailPanelOpen: open }),
  setDetailPanelTab: (tab) => set({ detailPanelTab: tab }),
  setConnectionState: (state) => set({ connectionState: state }),
  setProjectOverviewOpen: (open) => set({ projectOverviewOpen: open }),
  setContextMenu: (menu) => set({ contextMenu: menu }),
  setMobileDrawerOpen: (open) => set({ mobileDrawerOpen: open }),

  // Permissions
  pendingPermissions: [],
  addPermission: (prompt) =>
    set((s) =>
      s.pendingPermissions.some(p => p.id === prompt.id)
        ? s
        : { pendingPermissions: [...s.pendingPermissions, prompt] }
    ),
  removePermission: (id) =>
    set((s) => ({ pendingPermissions: s.pendingPermissions.filter(p => p.id !== id) })),

  // Options
  currentOption: null,
  setOption: (option) => set({ currentOption: option }),

  // Messages
  messagesBySession: {},
  setMessages: (sessionId, messages) =>
    set((s) => ({ messagesBySession: { ...s.messagesBySession, [sessionId]: messages } })),
  appendMessages: (sessionId, messages) =>
    set((s) => {
      if (messages.length === 0) return s;
      const existing = s.messagesBySession[sessionId] ?? [];
      const merged = appendDeduped(existing, messages);
      if (merged.length === existing.length) return s;
      return {
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: merged,
        },
      };
    }),
  mergeMessages: (sessionId, messages) =>
    set((s) => {
      const existing = s.messagesBySession[sessionId] ?? [];
      if (existing.length === 0) {
        // Even on a cold merge, dedup by id — defensive against any
        // upstream parser that might emit two records with the same id.
        return {
          messagesBySession: { ...s.messagesBySession, [sessionId]: dedupById(messages) },
        };
      }

      // === Optimistic → canonical reconciliation =================
      //
      // The daemon pushes user messages with optimistic ids `turn-<ts>-<rand>`
      // for instant render. The on-disk JSONL/rollout has canonical uuids for
      // the same logical messages. When a REST sync later returns the JSONL,
      // id-based dedup misses and the chat shows two copies.
      //
      // The matching MUST be order-preserving: if you sent "hey" as turn 1
      // AND as turn 4, the FIRST canonical "hey" must pair with the FIRST
      // optimistic "hey" (chronological). A naive `Map<text, index>` (which
      // we tried first) lets later same-text optimistics overwrite earlier
      // ones, causing cross-pairing and duplicate-key React warnings.
      //
      // Strategy:
      //   1. Build a FIFO queue of optimistic indices per normalized text.
      //   2. Walk incoming; for each canonical user message, shift one index
      //      off its text queue and mark that optimistic for removal.
      //   3. Filter the existing array to drop paired optimistics. Their
      //      canonical replacements ride in on `incoming` and get added by
      //      appendDeduped naturally.
      //   4. Final safety pass: dedup by id one more time so any historical
      //      corruption in `existing` (from prior buggy merges) self-heals.
      const norm = (t: string) => t.trim().replace(/\s+/g, ' ');
      const existingIdsSet = new Set(existing.map((m) => m.id));
      const optByText = new Map<string, number[]>();
      for (let i = 0; i < existing.length; i++) {
        const m = existing[i];
        if (m.kind === 'user' && m.id.startsWith('turn-')) {
          const key = norm(m.text);
          let q = optByText.get(key);
          if (!q) {
            q = [];
            optByText.set(key, q);
          }
          q.push(i);
        }
      }

      const optimisticToRemove = new Set<number>();
      if (optByText.size > 0) {
        for (const incoming of messages) {
          if (incoming.kind !== 'user') continue;
          if (incoming.id.startsWith('turn-')) continue;
          // Canonical already in store (WS path beat REST) — id-dedup will
          // suppress incoming; don't disturb any optimistic.
          if (existingIdsSet.has(incoming.id)) continue;
          const queue = optByText.get(norm(incoming.text));
          if (!queue || queue.length === 0) continue;
          const idx = queue.shift()!; // chronological pairing
          optimisticToRemove.add(idx);
        }
      }

      const filteredExisting =
        optimisticToRemove.size > 0
          ? existing.filter((_, i) => !optimisticToRemove.has(i))
          : existing;

      const appended = appendDeduped(filteredExisting, messages).sort((a, b) => a.ts - b.ts);
      const finalList = dedupById(appended);

      return { messagesBySession: { ...s.messagesBySession, [sessionId]: finalList } };
    }),
  clearMessages: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.messagesBySession)) return s;
      const next = { ...s.messagesBySession };
      delete next[sessionId];
      return { messagesBySession: next };
    }),
  rekeyMessage: (sessionId, oldId, newId) =>
    set((s) => {
      if (oldId === newId) return s;
      const list = s.messagesBySession[sessionId];
      if (!list) return s;
      const idx = list.findIndex((m) => m.id === oldId);
      if (idx === -1) return s;
      // If the canonical id is already in the list (e.g. REST sync raced
      // ahead of the rekey event), drop the optimistic copy instead of
      // collapsing two messages with the same id.
      const canonicalIdx = list.findIndex((m) => m.id === newId);
      let next: Message[];
      if (canonicalIdx !== -1 && canonicalIdx !== idx) {
        next = list.filter((_, i) => i !== idx);
      } else {
        next = [...list];
        next[idx] = { ...next[idx], id: newId } as Message;
      }
      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: next },
      };
    }),

  streamingBySession: {},
  setStreamingText: (sessionId, text) =>
    set((s) => {
      const prev = s.streamingBySession[sessionId] ?? '';
      if (prev === text) return s;
      const next = { ...s.streamingBySession };
      if (text === '') {
        if (!(sessionId in next)) return s;
        delete next[sessionId];
      } else {
        next[sessionId] = text;
      }
      return { streamingBySession: next };
    }),

  toolStreamingBySession: {},
  setToolStreaming: (sessionId, payload) =>
    set((s) => {
      const prev = s.toolStreamingBySession[sessionId] ?? null;
      // Cheap structural equality — the daemon may emit identical snapshots
      // (e.g. when item.updated fires for a non-output field change).
      if (
        prev?.toolName === payload?.toolName &&
        prev?.output === payload?.output &&
        prev?.isError === payload?.isError
      ) {
        return s;
      }
      const next = { ...s.toolStreamingBySession };
      if (payload === null) {
        if (!(sessionId in next)) return s;
        delete next[sessionId];
      } else {
        next[sessionId] = payload;
      }
      return { toolStreamingBySession: next };
    }),

  reasoningStreamingBySession: {},
  setReasoningStreaming: (sessionId, text) =>
    set((s) => {
      const prev = s.reasoningStreamingBySession[sessionId] ?? '';
      if (prev === text) return s;
      const next = { ...s.reasoningStreamingBySession };
      if (text === '') {
        if (!(sessionId in next)) return s;
        delete next[sessionId];
      } else {
        next[sessionId] = text;
      }
      return { reasoningStreamingBySession: next };
    }),

  idleBySession: {},
  setSessionIdle: (sessionId, outcome) =>
    set((s) => ({ idleBySession: { ...s.idleBySession, [sessionId]: outcome } })),

  gitByProject: {},
  setGitStatus: (projectId, status) =>
    set((s) => ({ gitByProject: { ...s.gitByProject, [projectId]: status } })),

  // Alerts
  alerts: [],
  unreadBySession: {},
  notificationCenterOpen: false,
  addAlert: (alert) =>
    set((s) => {
      // Dedup by alertId in case a reconnect re-delivers the same envelope.
      if (s.alerts.some((a) => a.alertId === alert.alertId)) return s;
      const persistent = alert.persistent
        ? [alert, ...s.alerts].slice(0, MAX_ALERT_HISTORY)
        : s.alerts;
      const unread = { ...s.unreadBySession };
      if (alert.needsAttention) {
        unread[alert.sessionId] = (unread[alert.sessionId] ?? 0) + 1;
      }
      return { alerts: persistent, unreadBySession: unread };
    }),
  dismissAlert: (alertId) =>
    set((s) => ({ alerts: s.alerts.filter((a) => a.alertId !== alertId) })),
  markSessionRead: (sessionId) =>
    set((s) => {
      if (!s.unreadBySession[sessionId]) return s;
      const next = { ...s.unreadBySession };
      delete next[sessionId];
      return { unreadBySession: next };
    }),
  bumpUnread: (sessionId) =>
    set((s) => ({
      unreadBySession: {
        ...s.unreadBySession,
        [sessionId]: (s.unreadBySession[sessionId] ?? 0) + 1,
      },
    })),
  clearAllAlerts: () => set({ alerts: [], unreadBySession: {} }),
  setNotificationCenterOpen: (open) => set({ notificationCenterOpen: open }),

  // Elicitations
  pendingElicitations: [],
  addElicitation: (prompt) =>
    set((s) =>
      s.pendingElicitations.some((p) => p.id === prompt.id)
        ? s
        : { pendingElicitations: [...s.pendingElicitations, prompt] }
    ),
  removeElicitation: (id) =>
    set((s) => ({ pendingElicitations: s.pendingElicitations.filter((p) => p.id !== id) })),

  // Tasks
  tasksBySession: {},
  applyTaskEvent: (sessionId, subtype, payload) =>
    set((s) => {
      const list = [...(s.tasksBySession[sessionId] ?? [])];
      const taskId = typeof payload.task_id === 'string' ? payload.task_id : '';
      if (!taskId) return s;
      const idx = list.findIndex((t) => t.taskId === taskId);

      function patch(into: TaskEntry, with_: Partial<TaskEntry>): TaskEntry {
        return { ...into, ...with_ };
      }

      const now = Date.now();

      if (subtype === 'task_started') {
        const desc = typeof payload.description === 'string' ? payload.description : 'Task';
        const taskType = typeof payload.task_type === 'string' ? payload.task_type : undefined;
        const workflowName = typeof payload.workflow_name === 'string' ? payload.workflow_name : undefined;
        const skipTranscript = payload.skip_transcript === true;
        const entry: TaskEntry = {
          taskId,
          description: desc,
          state: 'running',
          taskType,
          workflowName,
          startedAt: now,
          skipTranscript,
        };
        if (idx >= 0) list[idx] = patch(list[idx], entry);
        else list.push(entry);
      } else if (subtype === 'task_progress') {
        const usage = (payload.usage ?? {}) as Record<string, unknown>;
        const upd: Partial<TaskEntry> = {
          description: typeof payload.description === 'string' ? payload.description : undefined,
          totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
          toolUses: typeof usage.tool_uses === 'number' ? usage.tool_uses : undefined,
          durationMs: typeof usage.duration_ms === 'number' ? usage.duration_ms : undefined,
          lastToolName: typeof payload.last_tool_name === 'string' ? payload.last_tool_name : undefined,
          summary: typeof payload.summary === 'string' ? payload.summary : undefined,
        };
        if (idx >= 0) list[idx] = patch(list[idx], upd);
        else list.push({ taskId, description: upd.description ?? '…', state: 'running', startedAt: now, ...upd });
      } else if (subtype === 'task_updated') {
        const p = (payload.patch ?? {}) as Record<string, unknown>;
        const stateRaw = typeof p.status === 'string' ? p.status : undefined;
        const state: TaskState = isTaskState(stateRaw) ? (stateRaw as TaskState) : 'unknown';
        const upd: Partial<TaskEntry> = {
          description: typeof p.description === 'string' ? p.description : undefined,
          state: stateRaw ? state : undefined,
          endedAt: typeof p.end_time === 'number' ? p.end_time : undefined,
          isBackgrounded: typeof p.is_backgrounded === 'boolean' ? p.is_backgrounded : undefined,
        };
        if (idx >= 0) list[idx] = patch(list[idx], upd);
        else list.push({ taskId, description: upd.description ?? '…', state: state, startedAt: now, ...upd });
      } else if (subtype === 'task_notification') {
        const status = typeof payload.status === 'string' ? payload.status : 'completed';
        const finalState: TaskState =
          status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'stopped' ? 'stopped' : 'unknown';
        const usage = (payload.usage ?? {}) as Record<string, unknown>;
        const upd: Partial<TaskEntry> = {
          state: finalState,
          summary: typeof payload.summary === 'string' ? payload.summary : undefined,
          outputFile: typeof payload.output_file === 'string' ? payload.output_file : undefined,
          totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
          toolUses: typeof usage.tool_uses === 'number' ? usage.tool_uses : undefined,
          durationMs: typeof usage.duration_ms === 'number' ? usage.duration_ms : undefined,
          endedAt: now,
        };
        if (idx >= 0) list[idx] = patch(list[idx], upd);
        else list.push({ taskId, description: upd.summary ?? 'Task', state: finalState, startedAt: now, ...upd });
      }

      return { tasksBySession: { ...s.tasksBySession, [sessionId]: list } };
    }),

  // Tool progress
  toolProgressBySession: {},
  setToolProgress: (sessionId, progress) =>
    set((s) => ({
      toolProgressBySession: { ...s.toolProgressBySession, [sessionId]: progress },
    })),

  // Status spinner
  statusBySession: {},
  setSessionStatus: (sessionId, status) =>
    set((s) => ({
      statusBySession: { ...s.statusBySession, [sessionId]: status },
    })),

  // Pending send queue (client-side; the daemon serializes turns)
  pendingSendsBySession: {},
  enqueueSend: (sessionId, text) =>
    set((s) => {
      const trimmed = text.trim();
      if (!trimmed) return {};
      const current = s.pendingSendsBySession[sessionId] ?? [];
      return {
        pendingSendsBySession: {
          ...s.pendingSendsBySession,
          [sessionId]: [...current, trimmed],
        },
      };
    }),
  removePendingSend: (sessionId, index) =>
    set((s) => {
      const current = s.pendingSendsBySession[sessionId];
      if (!current || index < 0 || index >= current.length) return {};
      const next = current.slice(0, index).concat(current.slice(index + 1));
      return {
        pendingSendsBySession: { ...s.pendingSendsBySession, [sessionId]: next },
      };
    }),
  popPendingSend: (sessionId) => {
    let head: string | undefined;
    set((s) => {
      const current = s.pendingSendsBySession[sessionId];
      if (!current || current.length === 0) return {};
      head = current[0];
      return {
        pendingSendsBySession: {
          ...s.pendingSendsBySession,
          [sessionId]: current.slice(1),
        },
      };
    });
    return head;
  },
  clearPendingSends: (sessionId) =>
    set((s) => ({
      pendingSendsBySession: { ...s.pendingSendsBySession, [sessionId]: [] },
    })),
}));

function isTaskState(s: string | undefined): boolean {
  return s === 'pending' || s === 'running' || s === 'completed' || s === 'failed' || s === 'killed';
}
