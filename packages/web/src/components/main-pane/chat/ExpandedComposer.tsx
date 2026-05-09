import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Paperclip, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Streamdown } from 'streamdown';
import 'streamdown/styles.css';

import { Modal } from '../../ui/Modal';
import { useAppStore } from '../../../stores/appStore';
import { BUILTIN_THEMES } from '../../../lib/themes';
import { buildCmTheme } from '../../../lib/cm-theme';
import {
  fileMentionSource,
  slashCommandSource,
} from '../../../lib/cm-completions';
import { uploadAttachment, quotePath } from '../../../lib/attachments';
import { MD_COMPONENTS } from '../../../lib/markdown';

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

export interface ImageAttachment {
  path: string;
  filename: string;
  blobUrl: string;
}

interface Props {
  processId: string;
  projectId: string;
  attachmentKind: 'session' | 'terminal';
  initialText: string;
  imageAttachments: ImageAttachment[];
  onAddAttachment: (a: ImageAttachment) => void;
  onRemoveAttachment: (path: string) => void;
  // The expanded composer is a drafting surface only. All exits — Accept
  // button, Esc, click-outside — funnel through onClose with the current
  // editor text; the inline composer remains the only path that actually
  // dispatches a turn to the LLM.
  onClose: (finalText: string) => void;
}

// Rewrite quoted/unquoted attachment paths in the markdown source as
// markdown image references that point at the local blob URL. Streamdown
// renders these inline (the `img` override clamps size) so the Preview tab
// shows Obsidian-style thumbnails without changing what gets sent.
function withThumbnails(text: string, atts: ImageAttachment[]): string {
  let out = text;
  for (const { path, filename, blobUrl } of atts) {
    const label = filename || 'image';
    const single = `'${path}'`;
    const double = `"${path}"`;
    if (out.includes(single)) {
      out = out.split(single).join(`![${label}](${blobUrl})`);
    } else if (out.includes(double)) {
      out = out.split(double).join(`![${label}](${blobUrl})`);
    } else if (out.includes(path)) {
      out = out.split(path).join(`![${label}](${blobUrl})`);
    }
  }
  return out;
}

export function ExpandedComposer({
  processId,
  projectId,
  attachmentKind,
  initialText,
  imageAttachments,
  onAddAttachment,
  onRemoveAttachment,
  onClose,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [text, setText] = useState(initialText);
  const [acceptHover, setAcceptHover] = useState(false);
  const [attachHover, setAttachHover] = useState(false);

  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const activeThemeId = useAppStore((s) => s.activeThemeId);
  const customThemes = useAppStore((s) => s.customThemes);
  const themeCompartment = useRef(new Compartment());

  const pickTheme = useCallback(() => {
    const all = [...BUILTIN_THEMES, ...customThemes];
    const a = all.find((tt) => tt.id === activeThemeId);
    return buildCmTheme(a?.isDark ?? true);
  }, [activeThemeId, customThemes]);

  // Refs over props so the once-mount CM closures see fresh callbacks without
  // forcing a re-mount (which would lose CM internal state, focus, undo).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const addAttRef = useRef(onAddAttachment);
  addAttRef.current = onAddAttachment;

  const handleClose = useCallback(() => {
    const view = viewRef.current;
    const t = view ? view.state.doc.toString() : text;
    onCloseRef.current(t);
  }, [text]);

  // Mount CM once on modal open. We DO NOT include `tab` in deps — the editor
  // div stays in the tree across tab switches (display: none on the wrapper),
  // so CM's state/focus/undo history are preserved when bouncing between
  // Edit and Preview.
  useEffect(() => {
    if (!containerRef.current) return;

    const uploadFile = async (file: File) => {
      if (!file.type.startsWith('image/')) return false;
      const id = toast.loading(`Uploading ${file.name || 'image'}…`);
      const blobUrl = URL.createObjectURL(file);
      try {
        const res = await uploadAttachment(attachmentKind, processId, file);
        const view = viewRef.current;
        if (view) {
          view.dispatch(view.state.replaceSelection(quotePath(res.path) + ' '));
          view.focus();
        }
        addAttRef.current({ path: res.path, filename: res.filename, blobUrl });
        toast.success(`Attached ${res.filename}`, { id });
      } catch (err: any) {
        URL.revokeObjectURL(blobUrl);
        toast.error(`Upload failed: ${err?.message ?? err}`, { id });
      }
      return true;
    };

    const domHandlers = EditorView.domEventHandlers({
      paste: (event, view) => {
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
        const pasted = event.clipboardData?.getData('text/plain') ?? '';
        if (!pasted.includes('\n')) return false;
        const head = view.state.sliceDoc(
          Math.max(0, view.state.selection.main.from - 3),
          view.state.selection.main.from
        );
        if (head.includes('```')) return false;
        const fence = '```\n' + pasted.replace(/\n$/, '') + '\n```\n';
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
    });

    const updateListener = EditorView.updateListener.of((vu) => {
      if (vu.docChanged) {
        setText(vu.state.doc.toString());
      }
    });

    const extensions = [
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      highlightSpecialChars(),
      EditorView.lineWrapping,
      EditorState.allowMultipleSelections.of(true),
      markdown({ base: markdownLanguage, codeLanguages: FENCE_LANGS, addKeymap: false }),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      highlightSelectionMatches(),
      tooltips({ position: 'fixed', parent: document.body }),
      autocompletion({
        override: [
          fileMentionSource(() => projectIdRef.current || null),
          slashCommandSource(() => projectIdRef.current || null),
        ],
        activateOnTyping: true,
        defaultKeymap: true,
        maxRenderedOptions: 40,
        icons: true,
      }),
      placeholder('Draft your message — Esc or Accept to save back to the composer'),
      keymap.of([...closeBracketsKeymap, ...completionKeymap]),
      keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
      domHandlers,
      updateListener,
      themeCompartment.current.of(pickTheme()),
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: initialText, extensions }),
      parent: containerRef.current,
    });
    viewRef.current = view;
    view.focus();
    view.dispatch({ selection: { anchor: initialText.length } });

    // Remeasure once JetBrains Mono Variable finishes loading — see the
    // matching comment in ChatInputCM. Without this the caret floats at
    // fallback-font positions for the first few seconds of the modal.
    let cancelled = false;
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (cancelled) return;
        if (viewRef.current === view) view.requestMeasure();
      });
    }

    return () => {
      cancelled = true;
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure theme when active theme changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(pickTheme()),
    });
  }, [pickTheme]);

  const previewSource = withThumbnails(text, imageAttachments);

  const title = (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <TabButton active={tab === 'edit'} onClick={() => setTab('edit')}>
        Edit
      </TabButton>
      <TabButton active={tab === 'preview'} onClick={() => setTab('preview')}>
        Preview
      </TabButton>
    </div>
  );

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
          addAttRef.current({ path: res.path, filename: res.filename, blobUrl });
          toast.success(`Attached ${res.filename}`, { id });
        } catch (err: any) {
          URL.revokeObjectURL(blobUrl);
          toast.error(`Upload failed: ${err?.message ?? err}`, { id });
        }
      }
    };
    input.click();
  };

  const footer = (
    <>
      <button
        type="button"
        onClick={onAttachClick}
        title="Attach image"
        aria-label="Attach image"
        onMouseEnter={() => setAttachHover(true)}
        onMouseLeave={() => setAttachHover(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: 'var(--radius-snug)',
          border: 'none',
          background: attachHover ? 'var(--bg-hover)' : 'transparent',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          marginRight: 'auto',
          transition: 'background-color var(--dur-fast) var(--ease-out)',
        }}
      >
        <Paperclip size={14} />
      </button>
      <button
        type="button"
        onClick={handleClose}
        onMouseEnter={() => setAcceptHover(true)}
        onMouseLeave={() => setAcceptHover(false)}
        title="Accept draft (Esc)"
        aria-label="Accept draft"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 14px',
          borderRadius: 'var(--radius-snug)',
          border: 'none',
          background: acceptHover ? 'var(--text-secondary)' : 'var(--text-primary)',
          color: 'var(--bg-elevated)',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 500,
          fontFamily: 'inherit',
          transition:
            'background-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
        }}
      >
        Accept
        <Check size={13} strokeWidth={2.4} />
      </button>
    </>
  );

  return (
    <Modal
      open
      onClose={handleClose}
      title={title}
      footer={footer}
      width="min(960px, 92vw)"
    >
      <div
        style={{
          display: tab === 'edit' ? 'block' : 'none',
        }}
      >
        <div
          ref={containerRef}
          className="mt-cm-composer mt-cm-composer-expanded"
          style={{
            width: '100%',
            minHeight: '60vh',
          }}
        />
      </div>
      {tab === 'preview' && (
        <div
          style={{
            minHeight: '60vh',
            color: 'var(--text-primary)',
            fontSize: 12.5,
            lineHeight: 1.55,
          }}
        >
          {previewSource.trim() ? (
            // The preview renders the user's own draft, not untrusted
            // assistant output, so we drop Streamdown's default rehype
            // sanitize+harden chain. That chain strips `src` from `blob:`
            // URLs (rehype-sanitize doesn't allow blob: by default), which
            // leaves rehype-harden showing `[Image blocked: <alt>]` for
            // every pasted image. Empty rehypePlugins lets the inline
            // thumbnails actually render.
            <Streamdown components={MD_COMPONENTS} rehypePlugins={[]}>
              {previewSource}
            </Streamdown>
          ) : (
            <div
              style={{
                color: 'var(--text-muted)',
                padding: '40px 0',
                textAlign: 'center',
              }}
            >
              Nothing to preview. Switch to Edit and start typing.
            </div>
          )}
          {imageAttachments.length > 0 && (
            <div
              style={{
                marginTop: 16,
                paddingTop: 12,
                borderTop: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div
                style={{
                  fontSize: 9.5,
                  textTransform: 'uppercase',
                  letterSpacing: '0.18em',
                  color: 'var(--text-muted)',
                }}
              >
                Attachments ({imageAttachments.length})
              </div>
              {imageAttachments.map((att) => (
                <div
                  key={att.path}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 11,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={att.path}
                  >
                    {att.filename}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(att.path)}
                    title="Remove attachment"
                    aria-label={`Remove ${att.filename}`}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      padding: 2,
                      display: 'inline-flex',
                    }}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '4px 10px',
        fontSize: 11,
        fontFamily: 'inherit',
        textTransform: 'uppercase',
        letterSpacing: '0.18em',
        fontWeight: 500,
        border: 'none',
        background: 'transparent',
        color: active
          ? 'var(--text-primary)'
          : hover
            ? 'var(--text-secondary)'
            : 'var(--text-muted)',
        borderBottom: `2px solid ${active ? 'var(--accent-amber)' : 'transparent'}`,
        cursor: 'pointer',
        transition:
          'color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
      }}
    >
      {children}
    </button>
  );
}
