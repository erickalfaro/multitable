import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Save, Loader2, FileWarning } from 'lucide-react';
import { Streamdown } from 'streamdown';
import 'streamdown/styles.css';

import { useAppStore } from '../../../stores/appStore';
import { BUILTIN_THEMES } from '../../../lib/themes';
import { buildCmTheme } from '../../../lib/cm-theme';
import { MD_COMPONENTS } from '../../../lib/markdown';

import { EditorState, Compartment, Prec, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
  LanguageDescription,
} from '@codemirror/language';
import { languages as lezerLanguages } from '@codemirror/language-data';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
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
  ].includes(d.name),
);

export type LoadState = 'idle' | 'loading' | 'ready' | 'missing' | 'error';

interface Props {
  path: string | null;
  value: string;
  isDirty: boolean;
  saving: boolean;
  loadState: LoadState;
  loadError: string | null;
  onChange: (next: string) => void;
  onSave: () => void;
}

const isMarkdownPath = (p: string | null) => !!p && /\.mdx?$/i.test(p);

export function FileEditor({
  path,
  value,
  isDirty,
  saving,
  loadState,
  loadError,
  onChange,
  onSave,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');

  // Refs over props so the once-mount CM closures see fresh callbacks/state.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const activeThemeId = useAppStore((s) => s.activeThemeId);
  const customThemes = useAppStore((s) => s.customThemes);
  const themeCompartment = useRef(new Compartment());
  const langCompartment = useRef(new Compartment());

  const pickTheme = useCallback(() => {
    const all = [...BUILTIN_THEMES, ...customThemes];
    const a = all.find((tt) => tt.id === activeThemeId);
    return buildCmTheme(a?.isDark ?? true);
  }, [activeThemeId, customThemes]);

  const showEditor = loadState === 'ready' || loadState === 'missing';
  const markdownPreviewable = isMarkdownPath(path);

  // Mount CM keyed on `path` — each opened file gets a fresh EditorState with
  // the right language and seeded doc. Only mounts once content is ready, so
  // the seed is always the loaded content (parent sets path + value together).
  useEffect(() => {
    if (!showEditor || !containerRef.current || !path) return;

    const baseLang: Extension = markdownPreviewable
      ? markdown({ base: markdownLanguage, codeLanguages: FENCE_LANGS, addKeymap: false })
      : [];

    const updateListener = EditorView.updateListener.of((vu) => {
      if (vu.docChanged) onChangeRef.current(vu.state.doc.toString());
    });

    const saveKeymap = Prec.highest(
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current();
            return true;
          },
        },
      ]),
    );

    const extensions: Extension[] = [
      saveKeymap,
      history(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      highlightSpecialChars(),
      EditorView.lineWrapping,
      EditorState.allowMultipleSelections.of(true),
      langCompartment.current.of(baseLang),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      highlightSelectionMatches(),
      keymap.of([...closeBracketsKeymap]),
      keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
      updateListener,
      themeCompartment.current.of(pickTheme()),
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: valueRef.current, extensions }),
      parent: containerRef.current,
    });
    viewRef.current = view;
    view.focus();

    // For non-markdown files, lazy-load a language by filename and swap it in.
    let cancelled = false;
    if (!markdownPreviewable) {
      const desc = LanguageDescription.matchFilename(lezerLanguages, path.split('/').pop() || path);
      if (desc) {
        desc
          .load()
          .then((support) => {
            if (cancelled || viewRef.current !== view) return;
            view.dispatch({ effects: langCompartment.current.reconfigure(support) });
          })
          .catch(() => {
            /* unknown language — stay plain text */
          });
      }
    }

    return () => {
      cancelled = true;
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, showEditor]);

  // Reconfigure theme when the active theme changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: themeCompartment.current.reconfigure(pickTheme()) });
  }, [pickTheme]);

  if (loadState === 'idle' || !path) {
    return (
      <Centered>
        Select a file from the tree to view or edit it.
      </Centered>
    );
  }

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div
        style={{
          height: 34,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 10px',
          borderBottom: '1px solid var(--border)',
          backgroundColor: 'var(--bg-sidebar)',
        }}
      >
        <span
          title={path}
          style={{
            fontSize: 12,
            fontFamily:
              "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {path}
        </span>
        {isDirty && (
          <span
            title="Unsaved changes"
            style={{ color: 'var(--accent-amber)', fontSize: 14, lineHeight: 1, flexShrink: 0 }}
          >
            ●
          </span>
        )}
        <div style={{ flex: 1 }} />
        {showEditor && markdownPreviewable && (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <TabButton active={tab === 'edit'} onClick={() => setTab('edit')}>
              Edit
            </TabButton>
            <TabButton active={tab === 'preview'} onClick={() => setTab('preview')}>
              Preview
            </TabButton>
          </div>
        )}
        <button
          type="button"
          onClick={onSave}
          disabled={!isDirty || saving || !showEditor}
          title="Save (⌘/Ctrl+S)"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 12px',
            borderRadius: 'var(--radius-snug)',
            border: 'none',
            background:
              !isDirty || saving || !showEditor ? 'var(--bg-hover)' : 'var(--text-primary)',
            color:
              !isDirty || saving || !showEditor ? 'var(--text-muted)' : 'var(--bg-elevated)',
            cursor: !isDirty || saving || !showEditor ? 'default' : 'pointer',
            fontSize: 12,
            fontWeight: 500,
            fontFamily: 'inherit',
            transition: 'background-color var(--dur-fast) var(--ease-out)',
          }}
        >
          {saving ? <Loader2 size={12} className="mt-spin" /> : <Save size={12} />}
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {loadState === 'loading' && (
          <Centered>
            <Loader2 size={16} className="mt-spin" /> Loading…
          </Centered>
        )}
        {loadState === 'error' && (
          <Centered>
            <FileWarning size={16} style={{ color: 'var(--status-error)' }} />
            {loadError || 'Failed to open file.'}
          </Centered>
        )}
        {showEditor && (
          <>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: tab === 'edit' || !markdownPreviewable ? 'block' : 'none',
                overflow: 'hidden',
              }}
            >
              {loadState === 'missing' && (
                <div
                  style={{
                    padding: '4px 12px',
                    fontSize: 11,
                    color: 'var(--text-muted)',
                    borderBottom: '1px solid var(--border)',
                    background: 'var(--bg-elevated)',
                  }}
                >
                  New file — not yet saved. Press Save (⌘/Ctrl+S) to create it.
                </div>
              )}
              <div
                ref={containerRef}
                className="mt-cm-fileviewer"
                style={{
                  height: loadState === 'missing' ? 'calc(100% - 26px)' : '100%',
                }}
              />
            </div>
            {markdownPreviewable && tab === 'preview' && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  overflow: 'auto',
                  padding: '16px 20px',
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  lineHeight: 1.6,
                }}
              >
                {value.trim() ? (
                  <Streamdown components={MD_COMPONENTS}>{value}</Streamdown>
                ) : (
                  <div
                    style={{ color: 'var(--text-muted)', padding: '40px 0', textAlign: 'center' }}
                  >
                    Nothing to preview.
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        color: 'var(--text-muted)',
        fontSize: 13,
        padding: 24,
        textAlign: 'center',
      }}
    >
      {children}
    </div>
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
        padding: '3px 9px',
        fontSize: 10.5,
        fontFamily: 'inherit',
        textTransform: 'uppercase',
        letterSpacing: '0.14em',
        fontWeight: 500,
        border: 'none',
        background: 'transparent',
        color: active ? 'var(--text-primary)' : hover ? 'var(--text-secondary)' : 'var(--text-muted)',
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
