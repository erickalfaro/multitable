import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Paperclip,
  X,
  Clock,
  Square,
  Maximize2,
  File as FileIcon,
  Save,
} from 'lucide-react';

import { ModeBadge } from '../ModeBadge';
import { ExpandedComposer, type ImageAttachment } from './ExpandedComposer';
import { ModelChip } from './ModelChip';
import { useIsMobile } from '../../../lib/useIsMobile';

// Stable empty array so the pending-sends selector doesn't churn on
// unrelated store updates.
const EMPTY_PENDING: string[] = [];
const EMPTY_FILES: string[] = [];
import { toast } from 'react-hot-toast';
import { wsClient } from '../../../lib/ws';
import { api } from '../../../lib/api';
import { modeToneColor, resolveModeTone } from '../../../lib/modeTone';
import type { ProcessState } from '../../../lib/types';
import { useAppStore } from '../../../stores/appStore';
import { BUILTIN_THEMES } from '../../../lib/themes';
import { buildCmTheme } from '../../../lib/cm-theme';
import {
  fileMentionSource,
  slashCommandSource,
  warmProjectIndex,
  warmSlashCommands,
} from '../../../lib/cm-completions';
import { uploadAttachment, quotePath } from '../../../lib/attachments';
import {
  clearDraft,
  firstLineTitle,
  flushDraft,
  loadDraft,
  saveDraft,
} from '../../../lib/composerDrafts';

import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView,
  keymap,
  placeholder,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  rectangularSelection,
  crosshairCursor,
  tooltips,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
  LanguageDescription,
} from '@codemirror/language';
import { languages as lezerLanguages } from '@codemirror/language-data';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

// Languages we want available inside fenced code blocks. We cherry-pick from
// @codemirror/language-data by name — those descriptions are lazy-loaded at
// runtime when a fence of that language actually appears in the doc.
const FENCE_LANGS: LanguageDescription[] = lezerLanguages.filter((d) =>
  [
    'JavaScript', 'TypeScript', 'JSX', 'TSX',
    'Python', 'Rust', 'Go', 'C++', 'C',
    'JSON', 'YAML', 'TOML',
    'CSS', 'HTML', 'Vue', 'Svelte',
    'SQL', 'Shell', 'Bash',
    'Markdown',
  ].includes(d.name)
);

interface Props {
  processId: string;
  projectId: string;
  state: ProcessState;
  attachmentKind: 'session' | 'terminal';
  placeholder?: string;
  /** Whether the agent is currently doing work (turn in flight). */
  active?: boolean;
}

// Detect a language hint from an arbitrary clipboard blob. Cheap heuristics
// keyed on obvious shebangs / top-of-file syntax. Returns '' if we're not
// confident — callers fall back to an unadorned fence.
function detectLang(text: string): string {
  const s = text.trimStart();
  if (/^#!.*\b(bash|sh|zsh)\b/.test(s)) return 'bash';
  if (/^#!.*\bpython/.test(s)) return 'python';
  if (/^#!.*\bnode/.test(s)) return 'javascript';
  if (/^(import\s+.*\bfrom\b|export\s+(default\s+)?(function|class|const|let))/m.test(s)) return 'typescript';
  if (/^\s*(def\s+\w+\s*\(|class\s+\w+\s*:|from\s+\w|import\s+\w)/m.test(s)) return 'python';
  if (/^\s*(package\s+main|func\s+\w+\()/m.test(s)) return 'go';
  if (/^\s*(fn\s+\w+\s*\(|use\s+\w|impl\s+\w)/m.test(s)) return 'rust';
  if (/^\s*{[\s\S]*}\s*$/m.test(s) && /"\s*:/.test(s)) return 'json';
  if (/<\/?[a-z][\s\S]*>/i.test(s)) return 'html';
  if (/^\s*SELECT\s+.*FROM\s+/im.test(s)) return 'sql';
  return '';
}

function detectLangFromFilename(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rs: 'rust', go: 'go', c: 'c', cc: 'cpp', cpp: 'cpp', h: 'c',
    json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
    css: 'css', html: 'html', vue: 'vue', svelte: 'svelte',
    sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
    md: 'markdown',
  };
  return (ext && map[ext]) || '';
}

export const ChatInputCM = memo(function ChatInputCM({
  processId,
  projectId,
  state,
  attachmentKind,
  placeholder: placeholderText,
  active = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSendRef = useRef<() => boolean>(() => false);
  const onSaveRef = useRef<() => void>(() => {});
  const disabledRef = useRef(false);

  const [hasText, setHasText] = useState(false);
  // Inline hover bg for the borderless paperclip / send buttons. The file uses
  // inline styles throughout; Tailwind hover utilities aren't wired here.
  const [attachHover, setAttachHover] = useState(false);
  const [sendHover, setSendHover] = useState(false);
  const [expandHover, setExpandHover] = useState(false);
  const [focused, setFocused] = useState(false);

  // Image attachments registry — populated alongside the existing
  // upload+quoted-path injection. The Preview tab in ExpandedComposer reads
  // this to render Obsidian-style inline thumbnails for paths it finds in the
  // markdown source. Sent text is unchanged (still the quoted path).
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([]);
  const attachmentsRef = useRef<ImageAttachment[]>(imageAttachments);
  attachmentsRef.current = imageAttachments;

  // Expand-to-modal state. While true, ExpandedComposer renders its own CM
  // editor; the inline editor stays mounted (and visible behind the modal
  // backdrop) so its DOM/state are preserved. Sync direction is one-way on
  // close: modal → inline.
  const [expanded, setExpanded] = useState(false);

  const addImageAttachment = useCallback((att: ImageAttachment) => {
    setImageAttachments((prev) => [...prev, att]);
  }, []);

  const removeImageAttachment = useCallback((path: string) => {
    setImageAttachments((prev) => {
      const target = prev.find((a) => a.path === path);
      if (target) URL.revokeObjectURL(target.blobUrl);
      return prev.filter((a) => a.path !== path);
    });
  }, []);

  const clearImageAttachments = useCallback(() => {
    setImageAttachments((prev) => {
      prev.forEach((a) => URL.revokeObjectURL(a.blobUrl));
      return [];
    });
  }, []);

  // Revoke any leftover blob URLs on unmount so we don't leak when the user
  // navigates away mid-draft.
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.blobUrl));
    };
  }, []);
  // Sessions are SDK-driven: 'stopped'/'idle' means "ready to start a new turn",
  // 'running' means a turn is in flight (we client-side queue more sends),
  // 'errored' means the last turn failed. Keep the editor usable so the user
  // can retry; wsClient.sendTurn flips the session back to running
  // optimistically while the daemon attempts the next turn.
  const disabled = false;
  const queueing = state === 'running';
  disabledRef.current = disabled;

  const pendingSends = useAppStore(
    (s) => s.pendingSendsBySession[processId] ?? EMPTY_PENDING,
  );
  const enqueueSend = useAppStore((s) => s.enqueueSend);
  const removePendingSend = useAppStore((s) => s.removePendingSend);
  const selectedFiles = useAppStore(
    (s) => s.selectedFilesBySession[processId] ?? EMPTY_FILES,
  );
  const toggleSelectedFile = useAppStore((s) => s.toggleSelectedFile);
  const selectedFilesRef = useRef(selectedFiles);
  selectedFilesRef.current = selectedFiles;
  // Recall bridge: the Prompt Builder tab pushes a saved note's content here so
  // it can be loaded into this composer for editing.
  const recall = useAppStore((s) => s.composerRecallBySession[processId]);
  const consumeComposerRecall = useAppStore((s) => s.consumeComposerRecall);
  // Live session for the mode dropdown. ModeBadge self-hides when the
  // adapter only supports one mode, so it's safe to render unconditionally.
  const session = useAppStore((s) => s.sessions[processId]);

  // Send button reflects the active behavior's risk tier so the current posture
  // is obvious at a glance (green = safe, amber = ask-first, orange = elevated,
  // red = danger). Falls back to amber when no tone is declared.
  const sendAccent = modeToneColor(resolveModeTone(session));

  // On mobile, the model chip + mode/effort controls move up to the
  // SessionHeaderBar (below the title) to free vertical space in the composer.
  const isMobile = useIsMobile();

  // Keep project id reachable by the file-mention completion source — it
  // reads it lazily so we don't have to re-create extensions when the user
  // switches projects.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const activeThemeId = useAppStore((s) => s.activeThemeId);
  const customThemes = useAppStore((s) => s.customThemes);

  const themeCompartment = useRef(new Compartment());
  const editableCompartment = useRef(new Compartment());

  const pickTheme = useCallback(() => {
    const all = [...BUILTIN_THEMES, ...customThemes];
    const active = all.find((tt) => tt.id === activeThemeId);
    return buildCmTheme(active?.isDark ?? true);
  }, [activeThemeId, customThemes]);

  // Warm the project file index AND the slash-command list in the background
  // so the first '@' or '/' keystroke doesn't stall on a fresh walk / fetch.
  useEffect(() => {
    if (!projectId) return;
    warmProjectIndex(projectId);
    warmSlashCommands(projectId);
  }, [projectId]);

  // Mount CodeMirror once. Extensions that need to react to React state go
  // through Compartments (theme, editable) so we never recreate the view.
  useEffect(() => {
    if (!containerRef.current) return;

    // Built-in slash commands MultiTable handles natively. Each one renders
    // its result as a `system` message in the chat so the user sees inline
    // feedback like a real chat command (matching Slack/Discord-style
    // command UX). Custom commands defined in `.claude/commands/*.md` flow
    // straight to the SDK because the SDK reads those files itself.
    const pushSystemMessage = (text: string): void => {
      const id = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      useAppStore.getState().appendMessages(processId, [
        { id, ts: Date.now(), kind: 'system', text },
      ]);
    };

    const echoUserMessage = (text: string): void => {
      const id = `cmd-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      useAppStore.getState().appendMessages(processId, [
        { id, ts: Date.now(), kind: 'user', text },
      ]);
    };

    const handleNativeSlash = (text: string): boolean => {
      const m = text.match(/^\/([a-z][\w-]*)\b\s*(.*)$/i);
      if (!m) return false;
      const cmd = m[1].toLowerCase();
      switch (cmd) {
        case 'clear': {
          api.sessions
            .reset(processId)
            .then(() => {
              useAppStore.getState().clearMessages(processId);
              useAppStore.getState().clearPendingSends(processId);
              const session = useAppStore.getState().sessions[processId];
              if (session) {
                useAppStore.getState().upsertSession({
                  ...session,
                  agentSessionId: null,
                  claudeSessionId: null,
                  claudeState: undefined,
                });
              }
              pushSystemMessage('Conversation cleared. The next message will start a fresh session.');
            })
            .catch((err: any) => {
              pushSystemMessage(`/clear failed: ${err?.message ?? err}`);
            });
          return true;
        }
        case 'cost': {
          echoUserMessage(text);
          // Prefer the API endpoint — it falls back to a JSONL re-parse when
          // in-memory totals are zero (e.g., immediately after a daemon
          // restart, before any new turn has fired). The in-memory state is
          // 0 until a SDK `result` event lands.
          api.sessions
            .cost(processId)
            .then((res) => {
              const cost = res.costUsd ?? 0;
              const tokens = (res.tokensIn ?? 0) + (res.tokensOut ?? 0)
                + (res.cacheCreationTokens ?? 0) + (res.cacheReadTokens ?? 0);
              const fmtCost = cost >= 1 ? `$${cost.toFixed(2)}` : cost > 0 ? `$${cost.toFixed(4)}` : '$0.00';
              const fmtTokens = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
              const session = useAppStore.getState().sessions[processId];
              const tools = session?.claudeState?.toolCount ?? 0;
              const messages = res.messageCount ?? 0;
              pushSystemMessage(
                `Session cost\n  Cost:           ${fmtCost}\n  Tokens (total): ${fmtTokens}\n  Messages:       ${messages}\n  Tools used:     ${tools}`
              );
            })
            .catch(() => {
              // Fall back to in-memory snapshot if the API errors.
              const session = useAppStore.getState().sessions[processId];
              const cs = session?.claudeState;
              const cost = cs?.costUsd ?? 0;
              const tokens = cs?.tokenCount ?? 0;
              const tools = cs?.toolCount ?? 0;
              const fmtCost = cost >= 1 ? `$${cost.toFixed(2)}` : cost > 0 ? `$${cost.toFixed(4)}` : '$0.00';
              const fmtTokens = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
              pushSystemMessage(
                `Session cost\n  Cost:        ${fmtCost}\n  Tokens:      ${fmtTokens}\n  Tools used:  ${tools}`
              );
            });
          return true;
        }
        default:
          return false;
      }
    };

    const doSend = (): boolean => {
      if (disabledRef.current) return false;
      const view = viewRef.current;
      if (!view) return false;
      const text = view.state.doc.toString().trim();
      if (!text) return false;

      // Try a native slash-command handler first. If consumed, clear the
      // editor and don't forward to the SDK. Otherwise fall through (custom
      // slash commands and regular prompts both go through wsClient.sendTurn).
      // Native slash commands run untouched — selected files do not apply.
      if (handleNativeSlash(text)) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: '' },
        });
        clearImageAttachments();
        clearDraft(processId);
        return true;
      }

      // Prepend file mentions picked from the Files tab. Matches the `@path`
      // syntax produced by the file-mention completion source so the SDK
      // resolves them identically.
      const pinned = selectedFilesRef.current;
      const finalText = pinned.length
        ? `${pinned.map((p) => `@${p}`).join(' ')}\n\n${text}`
        : text;

      // If a turn is in flight, queue the message client-side. SessionChat
      // drains the queue when the daemon flips state out of 'running'.
      //
      // Race-safety: `session.state === 'running'` lags the actual send by
      // ~70ms (the daemon must round-trip a `process-state-changed` event
      // before the store updates). If the user clicks Send twice in quick
      // succession, the second send sees state still terminal and goes
      // through directly — the daemon then errors with "turn already in
      // flight" 10s later. Also queue if the queue ALREADY has a head OR
      // a turn is in flight — that catches the in-flight gap.
      //
      // 'errored' is a terminal, NOT-in-flight state: a failed turn (e.g.
      // Hermes went silent and the watchdog aborted) leaves currentTurn
      // null on the daemon, so a fresh prompt starts a new turn and clears
      // the error. Treat it like 'stopped' here, otherwise every follow-up
      // after a failure gets queued forever (the queue only drains out of a
      // non-running state) and the user can never recover the session.
      const live = useAppStore.getState();
      const session = live.sessions[processId];
      const queueHasHead = !!live.pendingSendsBySession?.[processId]?.length;
      const st = session?.state;
      const isIdle = (st === 'stopped' || st === 'errored') && !queueHasHead;
      if (!isIdle) {
        live.enqueueSend(processId, finalText);
      } else {
        // Optimistically flip the local state to 'running' so a follow-up
        // doSend in the same render frame sees in-flight and queues. The
        // daemon's process-state-changed event will overwrite this shortly
        // (idempotent — same value).
        live.updateProcessState(processId, 'running');
        wsClient.sendTurn(processId, finalText);
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: '' },
      });
      // The text was sent (or queued); the registry references that text and
      // is no longer useful. Revoke blob URLs to free memory.
      clearImageAttachments();
      live.clearSelectedFiles(processId);
      clearDraft(processId);
      return true;
    };
    onSendRef.current = doSend;

    // Save the current composer text as a project-scoped note (a "parked"
    // prompt the user can recall later from the Prompt Builder tab), then clear
    // the composer like the Send path does. Reuses the existing notes API — no
    // new persistence. Clears optimistically; the toast reports the real result.
    //
    // If the text was loaded from an existing note (origin tracked in the store),
    // Save overwrites that note instead of creating a duplicate.
    const doSave = (): void => {
      const view = viewRef.current;
      if (!view) return;
      const text = view.state.doc.toString().trim();
      if (!text) return;
      const live = useAppStore.getState();
      const pid = projectIdRef.current;
      const originId = live.composerOriginNoteBySession[processId];
      const payload = { title: firstLineTitle(text), content: text };
      const request = originId
        ? api.notes.update(originId, payload)
        : api.notes.create({ projectId: pid, scope: 'project', ...payload });
      request
        .then(() => {
          live.bumpNotesVersion(pid);
          toast.success(originId ? 'Prompt updated' : 'Prompt saved');
        })
        .catch((err) => {
          toast.error(`Save failed: ${err?.message ?? err}`);
        });
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: '' },
      });
      clearImageAttachments();
      clearDraft(processId);
      live.clearComposerOriginNote(processId);
    };
    onSaveRef.current = doSave;

    const uploadFile = async (file: File) => {
      if (!file.type.startsWith('image/')) return false;
      const id = toast.loading(`Uploading ${file.name || 'image'}…`);
      // Capture a blob URL immediately so the Preview tab can show a thumbnail
      // even while the upload is in flight. We register it after the upload
      // succeeds so the path → blobUrl mapping is always valid.
      const blobUrl = URL.createObjectURL(file);
      try {
        const res = await uploadAttachment(attachmentKind, processId, file);
        const injected = quotePath(res.path) + ' ';
        const view = viewRef.current;
        if (view) {
          view.dispatch(view.state.replaceSelection(injected));
          view.focus();
        }
        addImageAttachment({ path: res.path, filename: res.filename, blobUrl });
        toast.success(`Attached ${res.filename}`, { id });
      } catch (err: any) {
        URL.revokeObjectURL(blobUrl);
        toast.error(`Upload failed: ${err?.message ?? err}`, { id });
      }
      return true;
    };

    const composerKeymap = keymap.of([
      {
        key: 'Enter',
        run: () => doSend(),
      },
      {
        key: 'Mod-Enter',
        run: () => doSend(),
      },
      {
        key: 'Shift-Enter',
        run: (v) => {
          v.dispatch(v.state.replaceSelection('\n'));
          return true;
        },
      },
    ]);

    const domHandlers = EditorView.domEventHandlers({
      paste: (event, view) => {
        // 1) Image paste → upload as attachment, inject quoted path.
        const items = event.clipboardData?.items ?? [];
        for (const it of Array.from(items)) {
          if (it.kind === 'file') {
            const f = it.getAsFile();
            if (f && f.type.startsWith('image/')) {
              event.preventDefault();
              void uploadFile(f);
              return true;
            }
          }
        }
        // 2) Multi-line text paste → wrap in a fenced code block with a
        //    detected language hint. Single-line pastes fall through so the
        //    user can still paste short snippets inline.
        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (!text.includes('\n')) return false;

        // Respect the user's explicit choice if they already have a fence
        // marker on the current line — don't double-wrap.
        const head = view.state.sliceDoc(
          Math.max(0, view.state.selection.main.from - 3),
          view.state.selection.main.from
        );
        if (head.includes('```')) return false;

        const lang = detectLang(text);
        const fence = '```' + lang + '\n' + text.replace(/\n$/, '') + '\n```\n';
        event.preventDefault();
        view.dispatch(view.state.replaceSelection(fence));
        return true;
      },
      drop: (event, view) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
        if (images.length === 0) return false;
        event.preventDefault();
        view.focus();
        void Promise.all(images.map((f) => uploadFile(f)));
        return true;
      },
      dragover: (event) => {
        if (event.dataTransfer?.types.includes('Files')) {
          event.preventDefault();
        }
        return false;
      },
      // Mobile: when the user re-engages with the composer, collapse the
      // detail panel so the keyboard + chat take the full viewport. Desktop
      // is unaffected — the panel is stable enough alongside a wide composer.
      focus: () => {
        setFocused(true);
        if (typeof window !== 'undefined' && window.innerWidth < 768) {
          if (useAppStore.getState().detailPanelOpen) {
            useAppStore.getState().setDetailPanelOpen(false);
          }
        }
        return false;
      },
      blur: () => {
        setFocused(false);
        return false;
      },
    });

    const updateListener = EditorView.updateListener.of((vu) => {
      if (vu.docChanged) {
        const doc = vu.state.doc.toString();
        setHasText(doc.length > 0);
        saveDraft(processId, doc);
        // Once the composer is emptied, the text no longer represents the note
        // it was loaded from — drop the origin so the next Save creates fresh.
        if (doc.length === 0) {
          useAppStore.getState().clearComposerOriginNote(processId);
        }
      }
    });

    const extensions = [
      // History & selection
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      highlightSpecialChars(),
      EditorView.lineWrapping,
      EditorState.allowMultipleSelections.of(true),
      // Language
      markdown({
        base: markdownLanguage,
        codeLanguages: FENCE_LANGS,
        addKeymap: false,
      }),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      highlightSelectionMatches(),
      // The composer's wrapper div uses `overflow: hidden` so CM6's default
      // absolute-positioned tooltip would get clipped by it. Force fixed
      // positioning AND mount on document.body so the autocomplete popup
      // unambiguously escapes the overflow box.
      tooltips({ position: 'fixed', parent: document.body }),
      // Autocomplete — file mentions (@) and slash commands (/)
      autocompletion({
        // Two completion sources:
        //  - fileMentionSource: '@' triggers a fuzzy file picker scoped to
        //    the current project; the chosen path is inserted as `@<path> `
        //    so the SDK can read it as a literal reference.
        //  - slashCommandSource: '/' at the start of a line triggers a
        //    picker over the user's `.claude/commands/*.md` definitions
        //    (project-scoped first, then `~/.claude/commands/*.md`). The SDK
        //    expands the chosen template when the message is submitted.
        //    Built-in TUI slash commands (/clear, /model, /compact) are
        //    intentionally NOT surfaced — they need MultiTable-native
        //    handling to behave correctly.
        override: [
          fileMentionSource(() => projectIdRef.current || null),
          slashCommandSource(() => projectIdRef.current || null),
        ],
        activateOnTyping: true,
        defaultKeymap: true,
        maxRenderedOptions: 40,
        icons: false,
      }),
      // Placeholder — empty by default; callers can still override.
      placeholder(placeholderText ?? ''),
      // Keymap ordering matters — CM6 tries bindings in registration order
      // and the first one that returns true wins. We put completion's Enter
      // FIRST so it can accept a suggestion when the popup is open; only
      // when no completion is active does the composer's Enter fall through
      // to send the message.
      keymap.of([
        ...closeBracketsKeymap,
        ...completionKeymap,
      ]),
      composerKeymap,
      keymap.of([
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      // Event handlers
      domHandlers,
      updateListener,
      // Compartments for live-reconfigurable extensions
      themeCompartment.current.of(pickTheme()),
      editableCompartment.current.of(EditorView.editable.of(!disabled)),
    ];

    const initialDraft = loadDraft(processId);
    const view = new EditorView({
      state: EditorState.create({ doc: initialDraft, extensions }),
      parent: containerRef.current,
    });
    viewRef.current = view;
    if (initialDraft.length > 0) {
      setHasText(true);
      view.dispatch({ selection: { anchor: initialDraft.length } });
    }
    // Focus on mount so the composer feels immediately actionable.
    view.focus();

    // CM measures glyph widths at mount with whatever font is currently
    // resolved. JetBrains Mono Variable (self-hosted via @fontsource) loads
    // asynchronously, so the first paint uses a fallback font and the cursor
    // lands at fallback-metric positions. Once the real font arrives glyphs
    // shift but CM doesn't recompute — leaving a visibly misaligned caret
    // for the first few seconds of a session. Force a remeasure when fonts
    // are ready; guard against unmount.
    // Flush any pending debounced draft save before the tab/app goes away —
    // pagehide fires reliably on close, navigation, and mobile background.
    const flushOnHide = () => {
      const v = viewRef.current;
      if (v) flushDraft(processId, v.state.doc.toString());
    };
    window.addEventListener('pagehide', flushOnHide);

    if (typeof document !== 'undefined' && document.fonts?.ready) {
      let cancelled = false;
      document.fonts.ready.then(() => {
        if (cancelled) return;
        if (viewRef.current === view) view.requestMeasure();
      });
      return () => {
        cancelled = true;
        window.removeEventListener('pagehide', flushOnHide);
        flushDraft(processId, view.state.doc.toString());
        view.destroy();
        viewRef.current = null;
      };
    }

    return () => {
      window.removeEventListener('pagehide', flushOnHide);
      flushDraft(processId, view.state.doc.toString());
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processId, attachmentKind]); // intentionally omit pickTheme/disabled/placeholderText — handled via compartments

  // Reconfigure theme when the active theme changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(pickTheme()),
    });
  }, [pickTheme]);

  // Reconfigure editable flag on state transitions.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.current.reconfigure(
        EditorView.editable.of(!disabled)
      ),
    });
  }, [disabled]);

  // Recall bridge: when the Prompt Builder tab requests a recall, replace the
  // editor doc with the note's content, move the cursor to the end, focus, and
  // consume the request so it doesn't re-apply on unrelated re-renders. The
  // `recall` object identity changes on every request (nonce), so repeated
  // recalls of the same text still fire.
  useEffect(() => {
    if (!recall) return;
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: recall.text },
      selection: { anchor: recall.text.length },
    });
    setHasText(recall.text.length > 0);
    saveDraft(processId, recall.text);
    view.focus();
    consumeComposerRecall(processId);
  }, [recall, processId, consumeComposerRecall]);

  // Global Cmd/Ctrl+K → focus the composer.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        // Don't hijack if user is typing in another input/textarea.
        const el = document.activeElement as HTMLElement | null;
        const inField =
          el &&
          (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
        if (inField && el !== containerRef.current && !containerRef.current?.contains(el)) return;
        e.preventDefault();
        viewRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const onAttachClick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      for (const f of files) {
        if (!f.type.startsWith('image/')) continue;
        const id = toast.loading(`Uploading ${f.name}…`);
        const blobUrl = URL.createObjectURL(f);
        try {
          const res = await uploadAttachment(attachmentKind, processId, f);
          const view = viewRef.current;
          if (view) {
            view.dispatch(view.state.replaceSelection(quotePath(res.path) + ' '));
            view.focus();
          }
          addImageAttachment({ path: res.path, filename: res.filename, blobUrl });
          toast.success(`Attached ${res.filename}`, { id });
        } catch (err: any) {
          URL.revokeObjectURL(blobUrl);
          toast.error(`Upload failed: ${err?.message ?? err}`, { id });
        }
      }
    };
    input.click();
  };

  // Also handle a handy hint for paste language when user pastes a file — not
  // wired by default because pasting a file reference from the filesystem is
  // not common. Exposed here for future extension.
  void detectLangFromFilename;

  const canSend = hasText && !disabled;
  // Save gates on having text only — it's independent of send/queue state, so
  // it stays enabled even while a turn is in flight.
  const canSave = hasText && !disabled;
  const [saveHover, setSaveHover] = useState(false);

  return (
    <div
      style={{
        padding: '8px 12px 12px',
        backgroundColor: 'var(--bg-sidebar)',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        // Clicking anywhere on the composer card's padding / border / inert
        // surface should focus the editor. CodeMirror handles its own clicks
        // inside `.cm-editor`; buttons and inputs handle their own. For every
        // other pixel (card padding, gap between editor + toolbar, the
        // toolbar's empty middle), forward focus to the editor so the user
        // can type immediately. preventDefault keeps the click from
        // collapsing the editor's existing selection.
        onMouseDown={(e) => {
          const target = e.target as HTMLElement;
          if (
            target.closest('button, input, textarea, select, a, .cm-editor, [role="button"]')
          ) {
            return;
          }
          const view = viewRef.current;
          if (!view) return;
          e.preventDefault();
          view.focus();
        }}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '8px 10px',
          backgroundColor: 'var(--bg-elevated)',
          border: `1px solid ${focused ? 'var(--border-strong)' : 'var(--border)'}`,
          borderRadius: 'var(--radius-composer)',
          boxShadow: 'var(--shadow-composer)',
          cursor: 'text',
          transition:
            'border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)',
        }}
      >
        {pendingSends.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            {pendingSends.map((text, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 8px',
                  fontSize: 11.5,
                  color: 'var(--text-secondary)',
                  backgroundColor: 'var(--bg-sidebar)',
                  border: '1px dashed var(--border-strong)',
                  borderRadius: 'var(--radius-snug)',
                }}
              >
                <Clock size={11} style={{ color: 'var(--accent-amber)', flexShrink: 0 }} />
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: 'inherit',
                  }}
                  title={text}
                >
                  {text}
                </span>
                <button
                  onClick={() => removePendingSend(processId, i)}
                  title="Remove from queue"
                  aria-label="Remove queued message"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 18,
                    height: 18,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        {selectedFiles.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 4,
            }}
          >
            {selectedFiles.map((path) => {
              const slash = path.lastIndexOf('/');
              const label = slash >= 0 ? path.slice(slash + 1) : path;
              return (
                <div
                  key={path}
                  title={path}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '2px 6px',
                    fontSize: 11.5,
                    color: 'var(--accent-blue)',
                    backgroundColor: 'color-mix(in srgb, var(--accent-blue) 12%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--accent-blue) 40%, transparent)',
                    borderRadius: 'var(--radius-snug)',
                    maxWidth: 220,
                  }}
                >
                  <FileIcon size={11} style={{ flexShrink: 0 }} />
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontFamily: 'inherit',
                    }}
                  >
                    {label}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleSelectedFile(processId, path)}
                    title="Remove from chat context"
                    aria-label={`Remove ${label} from chat context`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 16,
                      height: 16,
                      border: 'none',
                      background: 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      flexShrink: 0,
                      padding: 0,
                    }}
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Editor block — full-width, takes the top of the card. The
            CodeMirror view mounts into this div via the [processId,
            attachmentKind] effect; do not change the ref or remount it
            during the restructure. */}
        <div
          ref={containerRef}
          className="mt-cm-composer"
          style={{
            width: '100%',
            minHeight: 84,
            maxHeight: '50vh',
            overflow: 'hidden',
            opacity: disabled ? 0.55 : 1,
          }}
        />

        {/* Toolbar — bottom strip integrated within the same card. Left
            cluster holds attach / expand / mode / model; right cluster is
            send (or stop while a turn is in flight). */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              flexWrap: 'wrap',
            }}
          >
            <button
              onClick={() => setExpanded(true)}
              disabled={disabled}
              title="Expand composer"
              aria-label="Expand composer"
              onMouseEnter={() => setExpandHover(true)}
              onMouseLeave={() => setExpandHover(false)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 26,
                height: 26,
                borderRadius: 'var(--radius-snug)',
                border: 'none',
                background: expandHover && !disabled ? 'var(--bg-hover)' : 'transparent',
                color: 'var(--text-muted)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                flexShrink: 0,
                transition: 'background-color var(--dur-fast) var(--ease-out)',
              }}
            >
              <Maximize2 size={12} />
            </button>

            {session && !isMobile && <ModelChip session={session} />}

            <button
              onClick={onAttachClick}
              disabled={disabled}
              title="Attach image"
              onMouseEnter={() => setAttachHover(true)}
              onMouseLeave={() => setAttachHover(false)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 26,
                height: 26,
                borderRadius: 'var(--radius-snug)',
                border: 'none',
                background: attachHover && !disabled ? 'var(--bg-hover)' : 'transparent',
                color: 'var(--text-muted)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                flexShrink: 0,
                transition: 'background-color var(--dur-fast) var(--ease-out)',
              }}
            >
              <Paperclip size={13} />
            </button>

            {session && !isMobile && <ModeBadge session={session} />}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              onClick={() => onSaveRef.current()}
              disabled={!canSave}
              onMouseEnter={() => setSaveHover(true)}
              onMouseLeave={() => setSaveHover(false)}
              title={canSave ? 'Save as prompt note' : 'Type a message to save'}
              aria-label="Save as prompt note"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 'var(--radius-snug)',
                border: 'none',
                backgroundColor: canSave && saveHover ? 'var(--bg-hover)' : 'transparent',
                color: canSave ? 'var(--text-muted)' : 'var(--text-faint)',
                cursor: canSave ? 'pointer' : 'not-allowed',
                flexShrink: 0,
                transition:
                  'background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
              }}
            >
              <Save size={14} />
            </button>
            {active ? (
            // Agent is mid-turn → the button at the send slot becomes Stop.
            // Click aborts the in-flight turn via /api/sessions/:id/stop, which
            // calls agentManager.abortTurn → ctrl.abort() → the SDK iterator
            // unwinds, finally clears streaming state, daemon emits session:idle
            // with outcome='aborted'. The chat shows a small "Turn cancelled."
            // system note (NOT an error) and the session goes back to stopped.
            <button
              type="button"
              onClick={() => {
                api.sessions.stop(processId).catch((err) => {
                  console.error('[chat-input] stop failed:', err);
                  toast.error('Failed to stop turn');
                });
              }}
              onMouseEnter={() => setSendHover(true)}
              onMouseLeave={() => setSendHover(false)}
              title="Stop (interrupt the agent)"
              aria-label="Stop turn"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 'var(--radius-snug)',
                border: 'none',
                backgroundColor: sendHover ? 'var(--bg-hover)' : 'transparent',
                color: 'var(--status-error, #ef4444)',
                cursor: 'pointer',
                flexShrink: 0,
                transition:
                  'background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
              }}
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onSendRef.current()}
              disabled={!canSend}
              onMouseEnter={() => setSendHover(true)}
              onMouseLeave={() => setSendHover(false)}
              title={
                !canSend
                  ? 'Type a message'
                  : queueing
                    ? 'Queue message (Enter)'
                    : 'Send (Enter)'
              }
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 'var(--radius-snug)',
                border: 'none',
                // Filled affordance, always tinted by the active behavior's risk
                // tier (see sendAccent). Hover darkens the accent slightly. When
                // there's nothing to send the same colored pill is dimmed via
                // opacity to read as disabled rather than dropping the color.
                backgroundColor: canSend && sendHover
                  ? `color-mix(in srgb, ${sendAccent} 86%, black)`
                  : sendAccent,
                color: 'var(--bg-elevated)',
                opacity: canSend ? 1 : 0.4,
                cursor: canSend ? 'pointer' : 'not-allowed',
                flexShrink: 0,
                transition:
                  'background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out)',
              }}
            >
              <ArrowUp size={15} strokeWidth={2.4} />
            </button>
          )}
          </div>
        </div>
      </div>

      {state === 'errored' && (
        <div
          style={{
            marginTop: 6,
            fontSize: 10.5,
            color: 'var(--text-muted)',
            fontFamily: 'inherit',
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
          }}
        >
          Last turn failed. Send a new message to retry.
        </div>
      )}

      {expanded && (
        <ExpandedComposer
          processId={processId}
          projectId={projectId}
          attachmentKind={attachmentKind}
          initialText={viewRef.current?.state.doc.toString() ?? ''}
          imageAttachments={imageAttachments}
          onAddAttachment={addImageAttachment}
          onRemoveAttachment={removeImageAttachment}
          onClose={(finalText) => {
            // Sync the modal's text back into the inline editor on close
            // (Accept button, Esc, or click-outside all land here). The
            // expanded composer is a drafting surface only — the user must
            // come back to the inline composer to actually send the turn.
            const view = viewRef.current;
            if (view) {
              view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: finalText },
              });
              view.focus();
            }
            setExpanded(false);
          }}
        />
      )}
    </div>
  );
});
