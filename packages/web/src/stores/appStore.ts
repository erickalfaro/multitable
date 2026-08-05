import { useMemo } from 'react';
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
  AgentProvider,
  DiscoveredModel,
  UsageLimitSnapshot,
  WallLayout,
  ProjectNavEntry,
  ProjectNavPrefs,
} from '../lib/types';
import { setProjectColorOverrides } from '../lib/projectColor';
import { materializeNavEntries, normalizeNavEntries } from '../lib/projectNav';
import {
  WALL_COLS,
  autoPack,
  makeRegionId,
  migrateWallLayout,
  normalizeWallLayout,
  moveTileToRegion,
  splitWithTile,
  addEmptyRegion,
  mergeAtBoundary,
  resizeTile,
} from '../components/main-pane/wall/grid';
import { api } from '../lib/api';
import type { Theme, ThemeColors } from '../lib/themes';
import {
  BUILTIN_THEMES,
  BUILTIN_DARK,
  DEFAULT_THEME_ID,
  loadCustomThemesFromStorage,
  loadActiveThemeIdFromStorage,
  saveCustomThemesToStorage,
  saveActiveThemeIdToStorage,
} from '../lib/themes';
import { loadSnapshot, saveSnapshot } from '../lib/persistedStore';
import { dominantAlertForSessions } from '../lib/alertVisuals';
import { isSessionOnRail, sessionRecencyMs } from '../lib/sessionVisibility';
import type { AlertCategory } from '../lib/types';

// Wall layout persistence — write localStorage synchronously (keeps cold-load
// correct and instant) but debounce the server PATCH, since drag/resize commit
// continuously. The triple-write of the old design is funnelled through here.
let _wallPatchTimer: ReturnType<typeof setTimeout> | null = null;
function persistWallLayout(tree: WallLayout) {
  try {
    localStorage.setItem('mt:wallLayout', JSON.stringify(tree));
  } catch {
    /* ignore */
  }
  if (_wallPatchTimer) clearTimeout(_wallPatchTimer);
  _wallPatchTimer = setTimeout(() => {
    void import('../lib/api').then(({ api }) =>
      api.config.patch({ ui: { wallLayout: tree } }).catch(() => {}),
    );
  }, 400);
}

// Project-nav persistence (order + dividers + hue overrides) — same discipline
// as persistWallLayout: synchronous localStorage for instant cold-load, then a
// debounced server PATCH (drag reorder commits can arrive in bursts).
let _projectNavPatchTimer: ReturnType<typeof setTimeout> | null = null;
function persistProjectNav(nav: ProjectNavPrefs) {
  try {
    localStorage.setItem('mt:projectNav', JSON.stringify(nav));
  } catch {
    /* ignore */
  }
  if (_projectNavPatchTimer) clearTimeout(_projectNavPatchTimer);
  _projectNavPatchTimer = setTimeout(() => {
    api.config.patch({ ui: { projectNav: nav } }).catch(() => {});
  }, 400);
}

// crypto.randomUUID only exists in secure contexts; the daemon serves plain
// HTTP, so non-localhost origins (LAN access) must fall back or the divider
// insert throws mid-set().
const newDividerId = () =>
  'div-' +
  (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));

interface AppState {
  // Projects
  projects: Project[];
  expandedProjectIds: string[];
  focusedProjectId: string | null;
  // The single project whose sections render in the sidebar column (the
  // always-visible ProjectRail drives this). Distinct from `focusedProjectId`
  // — which is mutated as a side effect by process/git/file-viewer selection
  // and modals — so the rail never jumps unexpectedly when something else
  // foregrounds a different project's surface.
  sidebarProjectId: string | null;
  setSidebarProject: (id: string | null) => void;
  // Left-nav preferences: user project order + dividers + manual hue
  // overrides. Persisted to localStorage `mt:projectNav` + GlobalConfig.ui
  // (debounced PATCH); reconciled from the server once at boot.
  projectNav: ProjectNavPrefs;
  setProjectNavEntries: (entries: ProjectNavEntry[]) => void;
  addDividerAfter: (projectId: string) => void;
  removeDivider: (dividerId: string) => void;
  setProjectColorOverride: (projectId: string, hueName: string | null) => void;
  setProjectGlyphOverride: (projectId: string, glyphId: string | null) => void;
  hydrateProjectNav: (nav: ProjectNavPrefs) => void;
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
  // When set, the main pane shows the per-project Source Control view instead
  // of any selected process. Mutually exclusive with `selectedProcessId` and
  // `projectOverviewOpen` — setting any one clears the others.
  selectedGitProjectId: string | null;
  // When set, the main pane shows the per-project File Viewer instead of any
  // selected process. Same mutually-exclusive surface model as
  // `selectedGitProjectId` — setting any surface clears the others.
  selectedFileViewerProjectId: string | null;
  // File Viewer open-file coordination. The tree lives in the left sidebar
  // (per project) while the editor host lives in the center pane, so the
  // currently-open relative path must be shared. Keyed by projectId so each
  // project remembers its open file independently. `fileViewerNewFile` flags a
  // path created from the sidebar so the host opens it in "not yet saved"
  // mode; `fileViewerRefreshKey` is bumped after a save so the sidebar tree
  // re-fetches.
  fileViewerOpenPath: Record<string, string | null>;
  fileViewerNewFile: Record<string, boolean>;
  fileViewerRefreshKey: Record<string, number>;
  // Multi-selected session ids for bulk operations (e.g. group remove). Sidebar
  // toggles entries via Cmd/Ctrl+click and Shift+click range select. Cleared
  // whenever a plain (un-modified) click sets a new primary selection.
  multiSelectedSessionIds: string[];
  sidebarCollapsed: boolean;
  // Vertical center of the rail's docked session row, relative to the
  // sections panel top — the column aligns its left-edge gap to it. Null when
  // no session is docked. The consumer writes --open-top/--open-bot
  // imperatively; only null↔number flips should trigger React renders.
  railSeamY: number | null;
  // Zen Pinned Session Wall (plan §5.3) — ordered list of session ids the
  // user has pinned to the homepage. Mirrored to localStorage for instant
  // cold-load and to `GlobalConfig.pinnedSessionIds` for cross-browser sync.
  pinnedSessionIds: string[];
  // Which Wall tile owns keyboard input. Click a tile to focus; only the
  // focused tile's composer routes the user's typing.
  focusedPaneId: string | null;
  customThemes: Theme[];
  activeThemeId: string;
  commandPaletteOpen: boolean;
  // New-agent composer surface. When set, MainPane renders the inline picker
  // (AgentComposer) for this project in place of the chat/homepage — one of the
  // mutually-exclusive main-pane surfaces alongside git/file-viewer/overview.
  // Selection (selectedProcessId) is left intact so Cancel returns to the prior
  // chat. Replaces the former AddAgentModal overlay.
  newAgentProjectId: string | null;
  addProcessModalOpen: boolean;
  addProjectModalOpen: boolean;
  globalSettingsOpen: boolean;
  projectSettingsOpen: boolean;
  detailPanelOpen: boolean;
  detailPanelTab: DetailPanelTab;
  connectionState: 'connected' | 'reconnecting' | 'disconnected';
  projectOverviewOpen: boolean;
  contextMenu: { type: string; id: string; x: number; y: number } | null;
  mobileDrawerOpen: boolean;
  devLogOpen: boolean;
  setDevLogOpen: (open: boolean) => void;
  setSelectedProcess: (id: string | null) => void;
  setSelectedGitProject: (projectId: string | null) => void;
  setSelectedFileViewer: (projectId: string | null) => void;
  setFileViewerOpenPath: (
    projectId: string,
    path: string | null,
    opts?: { isNew?: boolean },
  ) => void;
  bumpFileViewerRefresh: (projectId: string) => void;
  setMultiSelectedSessions: (ids: string[]) => void;
  toggleMultiSelectedSession: (id: string) => void;
  clearMultiSelectedSessions: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setRailSeamY: (y: number | null) => void;
  togglePinSession: (id: string) => void;
  reorderPinnedSessions: (ids: string[]) => void;
  setFocusedPane: (id: string | null) => void;
  // Region-aware wall layout (v2) — single source of truth; DOM = f(state).
  wallLayout: WallLayout;
  wallLayoutLocked: boolean;
  setWallLayout: (next: WallLayout) => void;
  // Drag a tile into an existing region at a snapped (x,y), or onto a divider
  // to spin off a new region at that boundary.
  moveTileTo: (
    sessionId: string,
    target:
      | { kind: 'region'; regionId: string; x: number; y: number }
      | { kind: 'divider'; boundaryIndex: number },
  ) => void;
  resizeWallTile: (sessionId: string, w: number, h: number) => void;
  addWallRegion: (boundaryIndex: number) => void;
  // Delete the divider above region `belowIndex`, rolling its chats up.
  deleteWallRegion: (belowIndex: number) => void;
  pruneWallLayout: (liveIds: string[]) => void;
  resetWallLayout: () => void;
  setWallLayoutLocked: (locked: boolean) => void;
  setActiveTheme: (id: string) => void;
  addCustomTheme: (theme: Theme) => void;
  updateCustomTheme: (id: string, patch: { name?: string; colors?: Partial<ThemeColors>; isDark?: boolean }) => void;
  deleteCustomTheme: (id: string) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setNewAgentProject: (projectId: string | null) => void;
  setAddProcessModalOpen: (open: boolean) => void;
  setAddProjectModalOpen: (open: boolean) => void;
  setGlobalSettingsOpen: (open: boolean) => void;
  setProjectSettingsOpen: (open: boolean) => void;
  setDetailPanelOpen: (open: boolean) => void;
  setDetailPanelTab: (tab: DetailPanelTab) => void;

  // Attention Stream — derived from session:tool-event + session:tool-delta,
  // owned by App.tsx's WS handler block. Each entry is one agent action
  // (read / edit / command / search / MCP call) with optional expandable
  // detail. Keyed by itemId (toolUseId) so deltas can update in place.
  attentionBySession: Record<string, AttentionEvent[]>;
  attentionFilters: Record<string, AttentionKind[]>;
  pushAttention: (event: AttentionEvent) => void;
  updateAttention: (sessionId: string, itemId: string, patch: Partial<AttentionEvent>) => void;
  clearAttention: (sessionId: string) => void;
  toggleAttentionFilter: (sessionId: string, kind: AttentionKind) => void;
  setConnectionState: (state: 'connected' | 'reconnecting' | 'disconnected') => void;
  setProjectOverviewOpen: (open: boolean) => void;
  setContextMenu: (menu: { type: string; id: string; x: number; y: number } | null) => void;
  setMobileDrawerOpen: (open: boolean) => void;

  // Permissions
  pendingPermissions: PermissionPrompt[];
  addPermission: (prompt: PermissionPrompt) => void;
  removePermission: (id: string) => void;

  // Options — per-session numbered-list quick replies detected from the last
  // completed turn. Keyed by sessionId so they survive session switches and so
  // the GET /api/pending-prompts snapshot (which can carry several) restores
  // each session's selector after a refresh.
  optionsBySession: Record<string, OptionPrompt>;
  setSessionOptions: (sessionId: string, option: OptionPrompt) => void;
  clearSessionOptions: (sessionId: string) => void;

  // Session transcript messages (chat view)
  messagesBySession: Record<string, Message[]>;
  /** Per-session transcript metadata. `lastTouchedAt` feeds the LRU snapshot
      persister (lib/persistedStore.ts); `truncated` means the in-memory list
      may be missing older messages (background tail cap or eviction) and a
      full REST fetch is required before treating it as complete. Maintained
      automatically by the message reducers. */
  messagesMeta: Record<string, { lastTouchedAt: number; truncated?: boolean }>;
  setMessages: (sessionId: string, messages: Message[]) => void;
  appendMessages: (sessionId: string, messages: Message[]) => void;
  /** Merge a fetched batch with already-stored messages; dedupes by id, sorts by ts.
      `complete: true` (the default) marks the transcript fully hydrated; pass
      `complete: false` for tail fetches so `truncated` is preserved. */
  mergeMessages: (sessionId: string, messages: Message[], opts?: { complete?: boolean }) => void;
  clearMessages: (sessionId: string) => void;
  /** Trim a non-retained session's in-memory transcript to the background
      tail. No-op for retained (selected/pinned/multi-selected) sessions. */
  evictSessionMessages: (sessionId: string) => void;
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

  // Live git status per worktree-backed session — fed by
  // `git:session-status-changed` WS events (daemon GitWatcher on the
  // session's worktree). No REST seed: empty until the first event.
  gitBySession: Record<string, GitStatusSummary>;
  setSessionGitStatus: (sessionId: string, status: GitStatusSummary) => void;

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

  // Per-session usage-limit snapshot (always-present indicator). Driven by
  // session:usage-limits-changed; hydrated on demand via api.sessions.usageLimits.
  usageLimitsBySession: Record<string, UsageLimitSnapshot | null>;
  setUsageLimits: (sessionId: string, snapshot: UsageLimitSnapshot | null) => void;

  // Per-session client-side send queue. While a turn is running, the user
  // can keep typing and queue more messages; SessionChat drains the queue
  // when the turn completes (one sendTurn per state-transition tick).
  pendingSendsBySession: Record<string, string[]>;
  enqueueSend: (sessionId: string, text: string) => void;
  removePendingSend: (sessionId: string, index: number) => void;
  popPendingSend: (sessionId: string) => string | undefined;
  clearPendingSends: (sessionId: string) => void;

  // Per-session set of file paths the user has pinned from the Files tab as
  // extra context for the next turn. Cleared after a successful send.
  selectedFilesBySession: Record<string, string[]>;
  toggleSelectedFile: (sessionId: string, path: string) => void;
  clearSelectedFiles: (sessionId: string) => void;

  // Per-project nonce bumped whenever a note is mutated outside the Prompt
  // Builder tab (e.g. the composer's Save button). The tab adds it to its load
  // effect deps so a composer-side save refetches; a no-op when the tab is closed.
  notesVersionByProject: Record<string, number>;
  bumpNotesVersion: (projectId: string) => void;

  // Cross-component bridge: the Prompt Builder tab pushes a saved note's content
  // here so the composer (a separate component) can load it for editing. The
  // nonce lets the same text be recalled repeatedly (a bare string wouldn't re-fire).
  // `noteId` is the note the text came from so a later Save overwrites it.
  composerRecallBySession: Record<string, { text: string; nonce: number; noteId: string | null }>;
  // The note id the live composer text was loaded from (if any). While set, the
  // composer's Save updates that note instead of creating a new one. Cleared when
  // the composer empties, sends, or saves.
  composerOriginNoteBySession: Record<string, string>;
  requestComposerRecall: (sessionId: string, text: string, noteId?: string | null) => void;
  consumeComposerRecall: (sessionId: string) => void;
  clearComposerOriginNote: (sessionId: string) => void;

  // Per-provider model catalog. Lazily fetched the first time a ModelChip
  // mounts for a session whose model is non-default — the daemon endpoint
  // probes the provider CLI on each call so we cache aggressively. Status
  // is tracked separately so concurrent mounts dedupe via a 'loading' guard.
  modelCatalog: Record<AgentProvider, DiscoveredModel[] | null>;
  modelCatalogStatus: Record<AgentProvider, 'idle' | 'loading' | 'ready' | 'error'>;
  loadModelCatalog: (provider: AgentProvider) => void;
  // Replace the cached model list for one provider — called from the
  // `providers:catalog-updated` WS handler after the daemon's background
  // discovery (or a user-triggered refresh) returns.
  setModelCatalog: (provider: AgentProvider, models: DiscoveredModel[]) => void;
}

export type DetailPanelTab = 'activity' | 'cost' | 'notes' | 'info' | 'ask';

export type AttentionKind = 'read' | 'edit' | 'command' | 'search' | 'mcp' | 'reasoning';

export interface AttentionEvent {
  id: string;             // unique row id; equals itemId for tool rows
  sessionId: string;
  provider: AgentProvider;
  kind: AttentionKind;
  label: string;          // e.g. "Edit src/agent/manager.ts" or "$ npm run build"
  detail?: string;        // expandable body (last 50 lines of stdout, diff hunk, MCP response, ...)
  isError?: boolean;
  itemId: string;         // toolUseId — used to update an in-flight row in place
  timestamp: number;
}

// Cap attention history per session so an idle user doesn't grow it
// unbounded. 500 covers very long turns; older entries get FIFO-trimmed.
const MAX_ATTENTION_PER_SESSION = 500;

// Cap per-session task history the same way — a long-lived orchestrator
// session can emit task events indefinitely.
const MAX_TASKS_PER_SESSION = 100;

// In-memory transcript cap for sessions that aren't retained (see
// isSessionRetained). The daemon broadcasts every session's events to every
// client, so without a cap each running session's full transcript accumulates
// in the store whether or not it's ever viewed. Background sessions keep only
// this tail; the full history is refetched on open (SessionPane mount effect).
const BACKGROUND_TAIL_MESSAGES = 50;

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

// WS/REST overlap duplicates only ever land near the tail (a replayed frame,
// a reconnect re-delivery) — scanning the entire transcript per incoming
// message was O(existing × incoming) and ran on every tool-event of a
// retained session. Bound the scan to the recent tail; mergeMessages' full
// dedupById pass remains the self-heal for anything older.
const DEDUP_SCAN_TAIL = 200;

function appendDeduped(existing: Message[], incoming: Message[]): Message[] {
  const out = [...existing];
  for (const msg of incoming) {
    const from = Math.max(0, out.length - DEDUP_SCAN_TAIL);
    let dup = false;
    for (let i = out.length - 1; i >= from; i--) {
      if (isDuplicateMessage(out[i], msg)) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
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

// A retained session is one whose transcript must stay whole in memory: the
// foregrounded chat, wall tiles (pinned), and multi-selected sessions the
// user is actively working with. Everything else is a background session
// subject to the BACKGROUND_TAIL_MESSAGES cap.
function isSessionRetained(
  s: Pick<AppState, 'selectedProcessId' | 'pinnedSessionIds' | 'multiSelectedSessionIds'>,
  id: string,
): boolean {
  return (
    s.selectedProcessId === id ||
    s.pinnedSessionIds.includes(id) ||
    s.multiSelectedSessionIds.includes(id)
  );
}

// State patch that trims a session's in-memory transcript to the background
// tail, or null when there's nothing to trim. Callers are responsible for the
// retained check (against the selection state that will hold AFTER their own
// state change).
function evictionPatch(
  s: Pick<AppState, 'messagesBySession' | 'messagesMeta'>,
  sessionId: string,
): Pick<AppState, 'messagesBySession' | 'messagesMeta'> | null {
  const list = s.messagesBySession[sessionId];
  if (!list || list.length <= BACKGROUND_TAIL_MESSAGES) return null;
  return {
    messagesBySession: {
      ...s.messagesBySession,
      [sessionId]: list.slice(list.length - BACKGROUND_TAIL_MESSAGES),
    },
    messagesMeta: {
      ...s.messagesMeta,
      [sessionId]: {
        lastTouchedAt: s.messagesMeta[sessionId]?.lastTouchedAt ?? Date.now(),
        truncated: true,
      },
    },
  };
}

// Synchronous snapshot read — runs at module init, before React mounts.
// Returns null on first boot / corrupt JSON / schema mismatch, in which case
// every slice falls back to its empty default below. When non-null, persisted
// slices hydrate from the snapshot so the first React commit sees a populated
// store and renders the user's chat/dashboard instantly on cold reload (the
// fallback path when mobile Chrome evicts the bfcache snapshot).
const __snapshot = loadSnapshot();

export const useAppStore = create<AppState>((set, get) => ({
  // Projects
  projects: __snapshot?.projects ?? [],
  expandedProjectIds: __snapshot?.expandedProjectIds ?? [],
  focusedProjectId: null,
  sidebarProjectId: __snapshot?.sidebarProjectId ?? null,
  setSidebarProject: (id) => set({ sidebarProjectId: id }),
  // Cold-load synchronously from localStorage so the rail paints in the
  // user's order (and overridden hues) on first frame; the boot GET
  // /api/config reconciles shortly after if another browser changed it.
  projectNav: (() => {
    try {
      const raw = localStorage.getItem('mt:projectNav');
      const parsed = raw ? (JSON.parse(raw) as ProjectNavPrefs) : null;
      const nav: ProjectNavPrefs =
        parsed && Array.isArray(parsed.entries) ? parsed : { entries: [] };
      setProjectColorOverrides(nav.colors);
      return nav;
    } catch {
      return { entries: [] };
    }
  })(),
  setProjectNavEntries: (entries) =>
    set((s) => {
      const next: ProjectNavPrefs = { ...s.projectNav, entries: normalizeNavEntries(entries) };
      persistProjectNav(next);
      return { projectNav: next };
    }),
  addDividerAfter: (projectId) =>
    set((s) => {
      // Materialize first so projects only implicitly appended (never yet
      // reordered) get explicit positions before the splice.
      const entries = materializeNavEntries(s.projects, s.projectNav);
      const idx = entries.findIndex((e) => e.kind === 'project' && e.id === projectId);
      // No-op guards return `s` (NOT `{}`): an empty partial still produces a
      // new root state object, notifying every subscriber for nothing.
      if (idx === -1) return s;
      entries.splice(idx + 1, 0, { kind: 'divider', id: newDividerId() });
      const next: ProjectNavPrefs = { ...s.projectNav, entries: normalizeNavEntries(entries) };
      persistProjectNav(next);
      return { projectNav: next };
    }),
  removeDivider: (dividerId) =>
    set((s) => {
      const entries = s.projectNav.entries.filter(
        (e) => e.kind !== 'divider' || e.id !== dividerId,
      );
      if (entries.length === s.projectNav.entries.length) return s;
      const next: ProjectNavPrefs = { ...s.projectNav, entries: normalizeNavEntries(entries) };
      persistProjectNav(next);
      return { projectNav: next };
    }),
  setProjectColorOverride: (projectId, hueName) =>
    set((s) => {
      const colors = { ...(s.projectNav.colors ?? {}) };
      if (hueName) colors[projectId] = hueName;
      else delete colors[projectId];
      const next: ProjectNavPrefs = {
        ...s.projectNav,
        colors: Object.keys(colors).length > 0 ? colors : undefined,
      };
      // Sync the module-level map BEFORE the state update so components that
      // call getProjectColor during the triggered re-render read fresh hues.
      setProjectColorOverrides(next.colors);
      persistProjectNav(next);
      return { projectNav: next };
    }),
  setProjectGlyphOverride: (projectId, glyphId) =>
    set((s) => {
      const glyphs = { ...(s.projectNav.glyphs ?? {}) };
      if (glyphId) glyphs[projectId] = glyphId;
      else delete glyphs[projectId];
      const next: ProjectNavPrefs = {
        ...s.projectNav,
        glyphs: Object.keys(glyphs).length > 0 ? glyphs : undefined,
      };
      persistProjectNav(next);
      return { projectNav: next };
    }),
  hydrateProjectNav: (nav) => {
    const next: ProjectNavPrefs = {
      entries: Array.isArray(nav.entries) ? nav.entries : [],
      colors: nav.colors,
      glyphs: nav.glyphs,
    };
    // Came FROM the server — mirror to localStorage only, no PATCH echo.
    try {
      localStorage.setItem('mt:projectNav', JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setProjectColorOverrides(next.colors);
    set({ projectNav: next });
  },
  setProjects: (projects) => set({ projects }),
  addProject: (project) => set((s) => ({ projects: [...s.projects, project] })),
  updateProject: (project) =>
    set((s) => ({
      projects: s.projects.map((p) => (p.id === project.id ? { ...p, ...project } : p)),
    })),
  removeProject: (id) =>
    set((s) => {
      const remaining = s.projects.filter((p) => p.id !== id);
      // Prune the project from the nav prefs (order + color + glyph),
      // collapsing any dividers left adjacent by the removal.
      let projectNav = s.projectNav;
      const hadEntry = s.projectNav.entries.some((e) => e.kind === 'project' && e.id === id);
      const hadColor = !!s.projectNav.colors?.[id];
      const hadGlyph = !!s.projectNav.glyphs?.[id];
      if (hadEntry || hadColor || hadGlyph) {
        const colors = { ...(s.projectNav.colors ?? {}) };
        delete colors[id];
        const glyphs = { ...(s.projectNav.glyphs ?? {}) };
        delete glyphs[id];
        projectNav = {
          entries: normalizeNavEntries(
            s.projectNav.entries.filter((e) => e.kind !== 'project' || e.id !== id),
          ),
          colors: Object.keys(colors).length > 0 ? colors : undefined,
          glyphs: Object.keys(glyphs).length > 0 ? glyphs : undefined,
        };
        setProjectColorOverrides(projectNav.colors);
        persistProjectNav(projectNav);
      }
      return {
        projects: remaining,
        projectNav,
        expandedProjectIds: s.expandedProjectIds.filter((pid) => pid !== id),
        focusedProjectId:
          s.focusedProjectId === id
            ? s.expandedProjectIds.find((pid) => pid !== id) ?? null
            : s.focusedProjectId,
        sidebarProjectId:
          s.sidebarProjectId === id
            ? (remaining.find((p) => p.isActive) ?? remaining[0])?.id ?? null
            : s.sidebarProjectId,
      };
    }),
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
  sessions: __snapshot?.sessions ?? {},
  commands: __snapshot?.commands ?? {},
  terminals: __snapshot?.terminals ?? {},
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
      // Purge EVERY session-keyed slice — leaving residue in any of these
      // maps leaks one entry per deleted session for the tab's lifetime.
      // Maps that don't contain the id keep their reference (no subscriber
      // invalidation).
      const del = <T,>(map: Record<string, T>): Record<string, T> => {
        if (!(id in map)) return map;
        const next = { ...map };
        delete next[id];
        return next;
      };
      return {
        sessions,
        messagesBySession: del(s.messagesBySession),
        messagesMeta: del(s.messagesMeta),
        gitBySession: del(s.gitBySession),
        attentionBySession: del(s.attentionBySession),
        attentionFilters: del(s.attentionFilters),
        tasksBySession: del(s.tasksBySession),
        streamingBySession: del(s.streamingBySession),
        toolStreamingBySession: del(s.toolStreamingBySession),
        reasoningStreamingBySession: del(s.reasoningStreamingBySession),
        idleBySession: del(s.idleBySession),
        statusBySession: del(s.statusBySession),
        toolProgressBySession: del(s.toolProgressBySession),
        usageLimitsBySession: del(s.usageLimitsBySession),
        unreadBySession: del(s.unreadBySession),
        optionsBySession: del(s.optionsBySession),
        pendingSendsBySession: del(s.pendingSendsBySession),
        selectedFilesBySession: del(s.selectedFilesBySession),
        composerRecallBySession: del(s.composerRecallBySession),
        composerOriginNoteBySession: del(s.composerOriginNoteBySession),
        alerts: s.alerts.some((a) => a.sessionId === id)
          ? s.alerts.filter((a) => a.sessionId !== id)
          : s.alerts,
        multiSelectedSessionIds: s.multiSelectedSessionIds.includes(id)
          ? s.multiSelectedSessionIds.filter((x) => x !== id)
          : s.multiSelectedSessionIds,
      };
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
  // Hydrate the last selected process so a cold reload (bfcache eviction)
  // re-opens the user's session immediately. App.tsx's deep-link / restore
  // logic still runs after projects/sessions arrive; it will clear this if
  // the id no longer exists.
  selectedProcessId: __snapshot?.selectedProcessId ?? null,
  selectedGitProjectId: null,
  selectedFileViewerProjectId: null,
  fileViewerOpenPath: {},
  fileViewerNewFile: {},
  fileViewerRefreshKey: {},
  multiSelectedSessionIds: [],
  sidebarCollapsed: false,
  railSeamY: null,
  pinnedSessionIds: (() => {
    // Read localStorage synchronously so the Wall paints on first frame
    // without a hydration flash. The daemon GET /api/config will reconcile
    // shortly after if any other browser updated the list out-of-band.
    try {
      const raw = localStorage.getItem('mt:pinnedSessionIds');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  })(),
  focusedPaneId: null,
  // Wall layout cold-loads from localStorage so the grid paints in the correct
  // positions on first frame. We only migrate here (legacy v1 → v2); the live
  // normalize/ghost-prune against loaded sessions happens in SessionWall once
  // the sessions map is populated (avoids dropping not-yet-loaded sessions).
  wallLayout: (() => {
    try {
      const raw = localStorage.getItem('mt:wallLayout');
      return migrateWallLayout(raw ? JSON.parse(raw) : null);
    } catch {
      return { version: 2, regions: [] };
    }
  })(),
  wallLayoutLocked: (() => {
    try {
      return localStorage.getItem('mt:wallLayoutLocked') === '1';
    } catch {
      return false;
    }
  })(),
  customThemes: loadCustomThemesFromStorage(),
  activeThemeId: (() => {
    const stored = loadActiveThemeIdFromStorage();
    const customs = loadCustomThemesFromStorage();
    const all = [...BUILTIN_THEMES, ...customs];
    if (stored && all.some((t) => t.id === stored)) return stored;
    return DEFAULT_THEME_ID;
  })(),
  commandPaletteOpen: false,
  newAgentProjectId: null,
  addProcessModalOpen: false,
  addProjectModalOpen: false,
  globalSettingsOpen: false,
  projectSettingsOpen: false,
  // In-flow right column, toggled via Cmd+. or SessionHeaderBar's chevron.
  // Open state + active tab survive reloads (same pattern as devLogOpen).
  detailPanelOpen: (() => {
    try {
      return localStorage.getItem('mt:detailPanelOpen') === '1';
    } catch {
      return false;
    }
  })(),
  detailPanelTab: (() => {
    try {
      const t = localStorage.getItem('mt:detailPanelTab');
      return t === 'activity' || t === 'cost' || t === 'notes' || t === 'info' || t === 'ask'
        ? t
        : 'activity';
    } catch {
      return 'activity';
    }
  })(),
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
      // Release the outgoing session's transcript: once it's no longer
      // selected (and isn't pinned/multi-selected), keep only the background
      // tail in memory. The full history is refetched on the next open.
      const prev = s.selectedProcessId;
      const evicted =
        prev && prev !== id && prev in s.sessions && !isSessionRetained({ ...s, selectedProcessId: id }, prev)
          ? evictionPatch(s, prev)
          : null;
      if (id === null) return { ...evicted, selectedProcessId: null, newAgentProjectId: null };
      const proc = s.sessions[id] || s.commands[id] || s.terminals[id];
      if (!proc)
        return { ...evicted, selectedProcessId: id, selectedGitProjectId: null, selectedFileViewerProjectId: null, newAgentProjectId: null };
      return {
        ...evicted,
        selectedProcessId: id,
        focusedProjectId: proc.projectId,
        // Keep the rail/sections on the owning project so notification- or
        // deep-link-driven selections never leave the sidebar showing a
        // different project than the foregrounded surface.
        sidebarProjectId: proc.projectId,
        selectedGitProjectId: null,
        selectedFileViewerProjectId: null,
        // Selecting a session (incl. the one just created by the composer)
        // dismisses the composer.
        newAgentProjectId: null,
      };
    }),
  setSelectedGitProject: (projectId) =>
    set(() => {
      if (projectId === null) return { selectedGitProjectId: null };
      return {
        selectedGitProjectId: projectId,
        selectedProcessId: null,
        selectedFileViewerProjectId: null,
        projectOverviewOpen: false,
        newAgentProjectId: null,
        focusedProjectId: projectId,
        sidebarProjectId: projectId,
      };
    }),
  setSelectedFileViewer: (projectId) =>
    set(() => {
      if (projectId === null) return { selectedFileViewerProjectId: null };
      return {
        selectedFileViewerProjectId: projectId,
        selectedProcessId: null,
        selectedGitProjectId: null,
        projectOverviewOpen: false,
        newAgentProjectId: null,
        focusedProjectId: projectId,
        sidebarProjectId: projectId,
      };
    }),
  setFileViewerOpenPath: (projectId, path, opts) =>
    set((s) => ({
      fileViewerOpenPath: { ...s.fileViewerOpenPath, [projectId]: path },
      fileViewerNewFile: { ...s.fileViewerNewFile, [projectId]: !!opts?.isNew },
    })),
  bumpFileViewerRefresh: (projectId) =>
    set((s) => ({
      fileViewerRefreshKey: {
        ...s.fileViewerRefreshKey,
        [projectId]: (s.fileViewerRefreshKey[projectId] ?? 0) + 1,
      },
    })),
  setMultiSelectedSessions: (ids) => set({ multiSelectedSessionIds: ids }),
  toggleMultiSelectedSession: (id) =>
    set((s) => {
      const exists = s.multiSelectedSessionIds.includes(id);
      return {
        multiSelectedSessionIds: exists
          ? s.multiSelectedSessionIds.filter((x) => x !== id)
          : [...s.multiSelectedSessionIds, id],
      };
    }),
  clearMultiSelectedSessions: () => set({ multiSelectedSessionIds: [] }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setRailSeamY: (y) =>
    set((s) => {
      // Driven by a per-frame scroll rAF in ProjectRail — the no-op guards
      // MUST return `s`, or every scroll frame notifies the whole store.
      const cur = s.railSeamY;
      if (y === cur) return s;
      // Sub-pixel jitter guard — scroll measurements arrive per frame.
      if (y != null && cur != null && Math.abs(y - cur) < 0.5) return s;
      return { railSeamY: y };
    }),
  togglePinSession: (id) =>
    set((s) => {
      const wasPinned = s.pinnedSessionIds.includes(id);
      const next = wasPinned
        ? s.pinnedSessionIds.filter((x) => x !== id)
        : [...s.pinnedSessionIds, id];
      try {
        localStorage.setItem('mt:pinnedSessionIds', JSON.stringify(next));
      } catch {
        /* ignore */
      }
      // Fire-and-forget server sync — we don't await the PATCH because the
      // local mutation is already canonical from the user's POV; any error
      // surfaces in DevLog but doesn't block the UI.
      void import('../lib/api').then(({ api }) =>
        api.config.patch({ pinnedSessionIds: next }).catch(() => {}),
      );
      // Unpinning drops the session out of the retained set — release its
      // transcript down to the background tail unless it's still foregrounded.
      const evicted =
        wasPinned && !isSessionRetained({ ...s, pinnedSessionIds: next }, id)
          ? evictionPatch(s, id)
          : null;
      return { ...evicted, pinnedSessionIds: next };
    }),
  reorderPinnedSessions: (ids) =>
    set(() => {
      try {
        localStorage.setItem('mt:pinnedSessionIds', JSON.stringify(ids));
      } catch {
        /* ignore */
      }
      void import('../lib/api').then(({ api }) =>
        api.config.patch({ pinnedSessionIds: ids }).catch(() => {}),
      );
      return { pinnedSessionIds: ids };
    }),
  setFocusedPane: (id) => set({ focusedPaneId: id }),
  setWallLayout: (next) =>
    set((s) => {
      const norm = normalizeWallLayout(next, s.pinnedSessionIds, null);
      persistWallLayout(norm);
      return { wallLayout: norm };
    }),
  moveTileTo: (sessionId, target) =>
    set((s) => {
      const moved =
        target.kind === 'divider'
          ? splitWithTile(s.wallLayout, target.boundaryIndex, sessionId)
          : moveTileToRegion(s.wallLayout, sessionId, target.regionId, target.x, target.y);
      const norm = normalizeWallLayout(moved, s.pinnedSessionIds, null);
      persistWallLayout(norm);
      return { wallLayout: norm };
    }),
  resizeWallTile: (sessionId, w, h) =>
    set((s) => {
      const region = s.wallLayout.regions.find((r) =>
        r.tiles.some((t) => t.sessionId === sessionId),
      );
      if (!region) return s;
      const tiles = resizeTile(region.tiles, sessionId, w, h, region.cols);
      const next: WallLayout = {
        version: 2,
        regions: s.wallLayout.regions.map((r) => (r.id === region.id ? { ...r, tiles } : r)),
      };
      persistWallLayout(next);
      return { wallLayout: next };
    }),
  addWallRegion: (boundaryIndex) =>
    set((s) => {
      const next = addEmptyRegion(s.wallLayout, boundaryIndex);
      persistWallLayout(next);
      return { wallLayout: next };
    }),
  deleteWallRegion: (belowIndex) =>
    set((s) => {
      const next = mergeAtBoundary(s.wallLayout, belowIndex);
      persistWallLayout(next);
      return { wallLayout: next };
    }),
  pruneWallLayout: (liveIds) =>
    set((s) => {
      const live = new Set(liveIds);
      const norm = normalizeWallLayout(s.wallLayout, s.pinnedSessionIds, live);
      const cleanedPins = s.pinnedSessionIds.filter((id) => live.has(id));
      if (cleanedPins.length !== s.pinnedSessionIds.length) {
        try {
          localStorage.setItem('mt:pinnedSessionIds', JSON.stringify(cleanedPins));
        } catch {
          /* ignore */
        }
        void import('../lib/api').then(({ api }) =>
          api.config.patch({ pinnedSessionIds: cleanedPins }).catch(() => {}),
        );
      }
      persistWallLayout(norm);
      return { wallLayout: norm, pinnedSessionIds: cleanedPins };
    }),
  resetWallLayout: () =>
    set((s) => {
      const ids = s.pinnedSessionIds.filter((id) => s.sessions[id]);
      const next: WallLayout = {
        version: 2,
        regions: ids.length
          ? [{ id: makeRegionId(), cols: WALL_COLS, tiles: autoPack(ids) }]
          : [],
      };
      persistWallLayout(next);
      return { wallLayout: next };
    }),
  setWallLayoutLocked: (locked) =>
    set(() => {
      try {
        localStorage.setItem('mt:wallLayoutLocked', locked ? '1' : '0');
      } catch {
        /* ignore */
      }
      void import('../lib/api').then(({ api }) =>
        api.config.patch({ ui: { wallLayoutLocked: locked } }).catch(() => {}),
      );
      return { wallLayoutLocked: locked };
    }),
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
  setNewAgentProject: (projectId) =>
    set(() => {
      if (projectId === null) return { newAgentProjectId: null };
      // Opening the composer clears the other main-pane surfaces (mirrors
      // setSelectedGitProject/setSelectedFileViewer). selectedProcessId is left
      // as-is so Cancel returns to whatever chat was open; MainPane checks
      // newAgentProjectId ahead of the session branch so the picker still wins.
      return {
        newAgentProjectId: projectId,
        selectedGitProjectId: null,
        selectedFileViewerProjectId: null,
        projectOverviewOpen: false,
        focusedProjectId: projectId,
        sidebarProjectId: projectId,
      };
    }),
  setAddProcessModalOpen: (open) => set({ addProcessModalOpen: open }),
  setAddProjectModalOpen: (open) => set({ addProjectModalOpen: open }),
  setGlobalSettingsOpen: (open) => set({ globalSettingsOpen: open }),
  setProjectSettingsOpen: (open) => set({ projectSettingsOpen: open }),
  setDetailPanelOpen: (open) => {
    try {
      localStorage.setItem('mt:detailPanelOpen', open ? '1' : '0');
    } catch {
      // ignore
    }
    set({ detailPanelOpen: open });
  },
  setDetailPanelTab: (tab) => {
    try {
      localStorage.setItem('mt:detailPanelTab', tab);
    } catch {
      // ignore
    }
    set({ detailPanelTab: tab });
  },

  // Attention Stream slice — live feed of agent actions per session.
  attentionBySession: {},
  attentionFilters: {},
  pushAttention: (event) =>
    set((s) => {
      const existing = s.attentionBySession[event.sessionId] ?? [];
      // Idempotency: if an event with this id already exists, treat it as an
      // update rather than a duplicate insert (handles the rare case where
      // tool-event fires twice for the same toolUseId).
      const idx = existing.findIndex((e) => e.id === event.id);
      let next: AttentionEvent[];
      if (idx >= 0) {
        next = existing.slice();
        next[idx] = { ...next[idx], ...event };
      } else {
        next = [...existing, event];
        if (next.length > MAX_ATTENTION_PER_SESSION) {
          next = next.slice(next.length - MAX_ATTENTION_PER_SESSION);
        }
      }
      return {
        attentionBySession: { ...s.attentionBySession, [event.sessionId]: next },
      };
    }),
  updateAttention: (sessionId, itemId, patch) =>
    set((s) => {
      const existing = s.attentionBySession[sessionId];
      if (!existing) return s;
      const idx = existing.findIndex((e) => e.itemId === itemId);
      if (idx < 0) return s;
      const next = existing.slice();
      next[idx] = { ...next[idx], ...patch };
      return {
        attentionBySession: { ...s.attentionBySession, [sessionId]: next },
      };
    }),
  clearAttention: (sessionId) =>
    set((s) => {
      if (!s.attentionBySession[sessionId]) return s;
      const next = { ...s.attentionBySession };
      delete next[sessionId];
      return { attentionBySession: next };
    }),
  toggleAttentionFilter: (sessionId, kind) =>
    set((s) => {
      const current = s.attentionFilters[sessionId] ?? [];
      const next = current.includes(kind)
        ? current.filter((k) => k !== kind)
        : [...current, kind];
      return {
        attentionFilters: { ...s.attentionFilters, [sessionId]: next },
      };
    }),

  setConnectionState: (state) => set({ connectionState: state }),
  setProjectOverviewOpen: (open) =>
    set(() =>
      open
        ? { projectOverviewOpen: true, selectedGitProjectId: null, selectedFileViewerProjectId: null, newAgentProjectId: null }
        : { projectOverviewOpen: false },
    ),
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
  optionsBySession: {},
  setSessionOptions: (sessionId, option) =>
    set((s) => ({ optionsBySession: { ...s.optionsBySession, [sessionId]: option } })),
  clearSessionOptions: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.optionsBySession)) return s;
      const next = { ...s.optionsBySession };
      delete next[sessionId];
      return { optionsBySession: next };
    }),

  // Messages
  messagesBySession: __snapshot?.messagesBySession ?? {},
  // Snapshot transcripts are LRU-trimmed on write (persistedStore), so
  // anything restored may be missing older messages — mark truncated so the
  // full-fetch-on-open path knows the list isn't complete.
  messagesMeta: Object.fromEntries(
    Object.entries(__snapshot?.messagesMeta ?? {}).map(([id, m]) => [
      id,
      { ...m, truncated: true },
    ]),
  ),
  setMessages: (sessionId, messages) =>
    set((s) => ({
      messagesBySession: { ...s.messagesBySession, [sessionId]: messages },
      messagesMeta: {
        ...s.messagesMeta,
        [sessionId]: { lastTouchedAt: Date.now(), truncated: false },
      },
    })),
  appendMessages: (sessionId, messages) =>
    set((s) => {
      if (messages.length === 0) return s;
      const existing = s.messagesBySession[sessionId] ?? [];
      const merged = appendDeduped(existing, messages);
      const prevMeta = s.messagesMeta[sessionId];
      if (merged.length === existing.length) {
        // No new messages, but still mark the session as recently touched so
        // it doesn't fall out of the LRU window while it's actively in view.
        return {
          messagesMeta: {
            ...s.messagesMeta,
            [sessionId]: { ...prevMeta, lastTouchedAt: Date.now() },
          },
        };
      }
      let final = merged;
      let truncated = prevMeta?.truncated ?? false;
      if (!isSessionRetained(s, sessionId) && merged.length > BACKGROUND_TAIL_MESSAGES) {
        final = merged.slice(merged.length - BACKGROUND_TAIL_MESSAGES);
        truncated = true;
      }
      return {
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: final,
        },
        messagesMeta: { ...s.messagesMeta, [sessionId]: { lastTouchedAt: Date.now(), truncated } },
      };
    }),
  mergeMessages: (sessionId, messages, opts) =>
    set((s) => {
      // A complete merge (full-transcript fetch, the default) clears the
      // truncated flag; a tail merge preserves whatever it was.
      const complete = opts?.complete ?? true;
      const nextMeta = {
        lastTouchedAt: Date.now(),
        truncated: complete ? false : s.messagesMeta[sessionId]?.truncated ?? false,
      };
      const existing = s.messagesBySession[sessionId] ?? [];
      if (existing.length === 0) {
        // Even on a cold merge, dedup by id — defensive against any
        // upstream parser that might emit two records with the same id.
        return {
          messagesBySession: { ...s.messagesBySession, [sessionId]: dedupById(messages) },
          messagesMeta: { ...s.messagesMeta, [sessionId]: nextMeta },
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

      return {
        messagesBySession: { ...s.messagesBySession, [sessionId]: finalList },
        messagesMeta: { ...s.messagesMeta, [sessionId]: nextMeta },
      };
    }),
  clearMessages: (sessionId) =>
    set((s) => {
      const hasMessages = sessionId in s.messagesBySession;
      const hasMeta = sessionId in s.messagesMeta;
      if (!hasMessages && !hasMeta) return s;
      const next = { ...s.messagesBySession };
      delete next[sessionId];
      const nextMeta = { ...s.messagesMeta };
      delete nextMeta[sessionId];
      return { messagesBySession: next, messagesMeta: nextMeta };
    }),
  evictSessionMessages: (sessionId) =>
    set((s) => {
      if (isSessionRetained(s, sessionId)) return s;
      return evictionPatch(s, sessionId) ?? s;
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
  gitBySession: {},
  setSessionGitStatus: (sessionId, status) =>
    set((s) => ({ gitBySession: { ...s.gitBySession, [sessionId]: status } })),

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

      // FIFO-cap the history so long-lived orchestrator sessions don't grow
      // it unbounded (same discipline as MAX_ATTENTION_PER_SESSION).
      if (list.length > MAX_TASKS_PER_SESSION) {
        list.splice(0, list.length - MAX_TASKS_PER_SESSION);
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

  // Usage-limit snapshots (per session)
  usageLimitsBySession: {},
  setUsageLimits: (sessionId, snapshot) =>
    set((s) => ({
      usageLimitsBySession: { ...s.usageLimitsBySession, [sessionId]: snapshot },
    })),

  // Pending send queue (client-side; the daemon serializes turns)
  pendingSendsBySession: {},
  enqueueSend: (sessionId, text) =>
    set((s) => {
      const trimmed = text.trim();
      if (!trimmed) return s;
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
      if (!current || index < 0 || index >= current.length) return s;
      const next = current.slice(0, index).concat(current.slice(index + 1));
      return {
        pendingSendsBySession: { ...s.pendingSendsBySession, [sessionId]: next },
      };
    }),
  popPendingSend: (sessionId) => {
    let head: string | undefined;
    set((s) => {
      const current = s.pendingSendsBySession[sessionId];
      if (!current || current.length === 0) return s;
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

  selectedFilesBySession: {},
  toggleSelectedFile: (sessionId, path) =>
    set((s) => {
      const current = s.selectedFilesBySession[sessionId] ?? [];
      const next = current.includes(path)
        ? current.filter((p) => p !== path)
        : [...current, path];
      return {
        selectedFilesBySession: { ...s.selectedFilesBySession, [sessionId]: next },
      };
    }),
  clearSelectedFiles: (sessionId) =>
    set((s) => ({
      selectedFilesBySession: { ...s.selectedFilesBySession, [sessionId]: [] },
    })),

  notesVersionByProject: {},
  bumpNotesVersion: (projectId) =>
    set((s) => ({
      notesVersionByProject: {
        ...s.notesVersionByProject,
        [projectId]: (s.notesVersionByProject[projectId] ?? 0) + 1,
      },
    })),

  composerRecallBySession: {},
  composerOriginNoteBySession: {},
  requestComposerRecall: (sessionId, text, noteId = null) =>
    set((s) => {
      const origin = { ...s.composerOriginNoteBySession };
      if (noteId) origin[sessionId] = noteId;
      else delete origin[sessionId];
      return {
        composerRecallBySession: {
          ...s.composerRecallBySession,
          [sessionId]: {
            text,
            nonce: (s.composerRecallBySession[sessionId]?.nonce ?? 0) + 1,
            noteId,
          },
        },
        composerOriginNoteBySession: origin,
      };
    }),
  consumeComposerRecall: (sessionId) =>
    set((s) => {
      if (!s.composerRecallBySession[sessionId]) return s;
      const next = { ...s.composerRecallBySession };
      delete next[sessionId];
      return { composerRecallBySession: next };
    }),
  clearComposerOriginNote: (sessionId) =>
    set((s) => {
      if (!s.composerOriginNoteBySession[sessionId]) return s;
      const next = { ...s.composerOriginNoteBySession };
      delete next[sessionId];
      return { composerOriginNoteBySession: next };
    }),

  // Model catalog cache, one slot per provider, fed by the daemon's
  // /api/providers/:provider/models route + `providers:catalog-updated` WS.
  modelCatalog: { claude: null, codex: null, hermes: null, copilot: null, grok: null, cursor: null },
  modelCatalogStatus: {
    claude: 'idle',
    codex: 'idle',
    hermes: 'idle',
    copilot: 'idle',
    grok: 'idle',
    cursor: 'idle',
  },
  loadModelCatalog: (provider) => {
    const status = get().modelCatalogStatus[provider];
    if (status === 'loading' || status === 'ready') return;
    set((s) => ({
      modelCatalogStatus: { ...s.modelCatalogStatus, [provider]: 'loading' },
    }));
    api.providers
      .models(provider as 'claude' | 'codex' | 'hermes' | 'grok' | 'cursor' | 'copilot')
      .then((res) => {
        set((s) => ({
          modelCatalog: { ...s.modelCatalog, [provider]: res.models },
          modelCatalogStatus: { ...s.modelCatalogStatus, [provider]: 'ready' },
        }));
      })
      .catch(() => {
        set((s) => ({
          modelCatalogStatus: { ...s.modelCatalogStatus, [provider]: 'error' },
        }));
      });
  },
  setModelCatalog: (provider, models) => {
    set((s) => ({
      modelCatalog: { ...s.modelCatalog, [provider]: models },
      modelCatalogStatus: { ...s.modelCatalogStatus, [provider]: 'ready' },
    }));
  },
}));

// ----- Snapshot persistence -----------------------------------------------
//
// Debounced writer: any change to a persisted slice schedules a save 500 ms
// later. The shallow reference compare on `persistKeys` means a streaming
// delta (which mutates `streamingBySession`/`reasoningStreamingBySession`/
// `toolStreamingBySession`) doesn't trigger writes — those references never
// change for a no-op tick because the reducers short-circuit on equality.
//
// On `pagehide` we synchronously flush any pending debounce so the
// most-recent state lands before the browser snapshots the page (or before
// the tab is unloaded altogether). This is the critical path for the
// "resume feels seamless" requirement.
//
// Saves never throw — `saveSnapshot` catches QuotaExceeded internally and
// retries with a smaller window. See lib/persistedStore.ts.
if (typeof window !== 'undefined') {
  let saveTimer: number | null = null;
  const persistKeys: Array<keyof AppState> = [
    'projects',
    'sessions',
    'commands',
    'terminals',
    'messagesBySession',
    'messagesMeta',
    'selectedProcessId',
    'expandedProjectIds',
    'sidebarProjectId',
  ];
  const flush = () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveSnapshot(useAppStore.getState());
  };
  useAppStore.subscribe((state, prev) => {
    // Cheap reference equality across the persisted slices — Zustand
    // reducers above return new references only for slices that actually
    // changed, so this short-circuits ~every WS tick that doesn't touch
    // anything we persist.
    let changed = false;
    for (const k of persistKeys) {
      if (state[k] !== prev[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flush, 500);
  });
  window.addEventListener('pagehide', flush);
}

function isTaskState(s: string | undefined): boolean {
  return s === 'pending' || s === 'running' || s === 'completed' || s === 'failed' || s === 'killed';
}

// Roll the per-session amber-Bell badge (pending permissions + unread alerts)
// up to the owning project, for the ProjectRail tiles. Pure against a store
// snapshot so it can be called from a scalar selector — returning the object
// directly from useAppStore would allocate a fresh reference every render and
// loop, so the hooks below select scalars only.
export interface ProjectAttention {
  permissionCount: number;
  unreadAttention: number;
  total: number;
}

export function selectProjectAttention(
  s: Pick<AppState, 'sessions' | 'pendingPermissions' | 'unreadBySession'>,
  projectId: string,
): ProjectAttention {
  const ids = new Set(
    Object.values(s.sessions)
      .filter((x) => x.projectId === projectId)
      .map((x) => x.id),
  );
  let permissionCount = 0;
  for (const p of s.pendingPermissions) {
    if (p.sessionId && ids.has(p.sessionId)) permissionCount++;
  }
  let unreadAttention = 0;
  for (const id of ids) unreadAttention += s.unreadBySession[id] ?? 0;
  return { permissionCount, unreadAttention, total: permissionCount + unreadAttention };
}

export function useProjectAttentionTotal(projectId: string): number {
  return useAppStore((s) => selectProjectAttention(s, projectId).total);
}

export function useProjectPermissionCount(projectId: string): number {
  return useAppStore((s) => selectProjectAttention(s, projectId).permissionCount);
}

export function useProjectUnreadCount(projectId: string): number {
  return useAppStore((s) => selectProjectAttention(s, projectId).unreadAttention);
}

/**
 * Project-level dominant alert category — the highest-priority pending alert
 * across all of a project's sessions. ProjectRail uses this to tint its
 * roll-up badge so a project with auth failures looks visually distinct from
 * a project that's only blowing through its rate limit. Returns null when
 * the project has no unread alerts (permission-only state keeps the amber
 * default in the rail badge).
 *
 * Returns a scalar string so Zustand's default reference equality short-
 * circuits re-renders on unrelated alert mutations.
 */
export function useProjectDominantCategory(projectId: string): AlertCategory | null {
  return useAppStore((s) => {
    const ids = new Set(
      Object.values(s.sessions)
        .filter((x) => x.projectId === projectId)
        .map((x) => x.id),
    );
    if (ids.size === 0) return null;
    return dominantAlertForSessions(s.alerts, ids)?.category ?? null;
  });
}

// ── Rail session previews ────────────────────────────────────────────────────
// Jump-back rows under each project on the left rail (see lib/sessionVisibility):
//   1. live / needs-user (permission, unread, mid-turn)
//   2. quiet activity in the last 24 hours
//   3. never older than 1 week
// Soft safety cap keeps a pathological project from stretching the rail forever.

/** Soft cap — real projects rarely hit this; guards multi-hundred session repos. */
const MAX_RAIL_PREVIEWS = 20;
const EMPTY_IDS: string[] = [];

/**
 * Sessions to surface under a project in the rail. Always computed when
 * `enabled` — collapsed rail shows compact glyphs; expanded sheet shows name.
 */
export function useRailPreviewSessionIds(projectId: string, enabled: boolean): string[] {
  const joined = useAppStore((s) => {
    if (!enabled) return '';
    const now = Date.now();
    const forceIds = new Set<string>();
    if (s.selectedProcessId) forceIds.add(s.selectedProcessId);
    for (const id of s.multiSelectedSessionIds) forceIds.add(id);

    const rows: Array<{ id: string; score: number; recency: number }> = [];
    for (const sess of Object.values(s.sessions)) {
      if (sess.projectId !== projectId) continue;
      const hasPermission = s.pendingPermissions.some((p) => p.sessionId === sess.id);
      const hasUnread = (s.unreadBySession[sess.id] ?? 0) > 0;
      const isLive =
        sess.state === 'running' ||
        !!s.streamingBySession[sess.id] ||
        !!s.toolProgressBySession[sess.id] ||
        (s.statusBySession[sess.id]?.status ?? null) !== null;
      if (
        !isSessionOnRail(
          sess,
          { forceIds, hasPermission, hasUnread, isLive },
          now,
        )
      ) {
        continue;
      }
      const recency = sessionRecencyMs(sess);
      // Attention first, then live work, then quiet recent jump-backs.
      const score = hasPermission ? 3 : hasUnread ? 2 : isLive ? 1 : 0;
      rows.push({ id: sess.id, score, recency });
    }
    rows.sort((a, b) => b.score - a.score || b.recency - a.recency);
    return rows
      .slice(0, MAX_RAIL_PREVIEWS)
      .map((r) => r.id)
      .join('\n');
  });
  return useMemo(() => (joined ? joined.split('\n') : EMPTY_IDS), [joined]);
}

/** One-line live snippet for a rail preview row, most actionable signal first. */
export function useRailSessionSnippet(sessionId: string): string {
  return useAppStore((s) => {
    const perm = s.pendingPermissions.find((p) => p.sessionId === sessionId);
    if (perm) return `Needs permission · ${perm.displayName ?? perm.toolName}`;
    const stream = s.streamingBySession[sessionId];
    if (stream) return stream.slice(-90);
    const tool = s.toolProgressBySession[sessionId];
    if (tool) return `${tool.toolName} · ${tool.elapsedSeconds}s`;
    const st = s.statusBySession[sessionId];
    if (st?.status) return st.status === 'compacting' ? 'Compacting context…' : 'Requesting…';
    if (s.sessions[sessionId]?.state === 'running') return 'Working…';
    const unread = s.unreadBySession[sessionId] ?? 0;
    if (unread > 0) return `${unread} unread alert${unread === 1 ? '' : 's'}`;
    // Quiet recent jump-back — show how long since last activity.
    const sess = s.sessions[sessionId];
    if (sess) {
      const recency = sessionRecencyMs(sess);
      if (recency > 0) {
        const diff = Date.now() - recency;
        const sec = Math.floor(diff / 1000);
        if (sec < 60) return 'just now';
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min}m ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr}h ago`;
        return `${Math.floor(hr / 24)}d ago`;
      }
    }
    return '';
  });
}

/** Attention flavor for a rail preview row's mini badge. */
export function useRailSessionAttention(sessionId: string): 'permission' | 'unread' | null {
  return useAppStore((s) => {
    if (s.pendingPermissions.some((p) => p.sessionId === sessionId)) return 'permission';
    if ((s.unreadBySession[sessionId] ?? 0) > 0) return 'unread';
    return null;
  });
}
