import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

// Read live CSS variable values so the editor stays in sync with the active
// MultiTable theme. `getComputedStyle` sees whatever variables are currently
// applied on :root, so calling this after a theme swap returns fresh colors.
function readVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Build the CM6 theme + syntax-highlight pair for the current CSS variables.
// Called on mount and again whenever the active theme changes (via a
// Compartment.reconfigure). No hardcoded hex values — everything threads
// through to the theme system.
export function buildCmTheme(isDark: boolean): Extension {
  const bg = readVar('--bg-elevated') || (isDark ? '#16181d' : '#ffffff');
  const text = readVar('--text-primary') || (isDark ? '#e6e6e6' : '#111111');
  const textMuted = readVar('--text-muted') || '#888888';
  const accent = readVar('--accent-blue') || '#3b82f6';
  const border = readVar('--border') || '#333333';
  const statusRunning = readVar('--status-running') || '#22c55e';
  const statusWarning = readVar('--status-warning') || '#f59e0b';
  const statusError = readVar('--status-error') || '#ef4444';

  const baseTheme = EditorView.theme(
    {
      '&': {
        backgroundColor: 'transparent',
        color: text,
        fontSize: '13.5px',
      },
      '&.cm-editor.cm-focused': {
        outline: 'none',
      },
      '.cm-scroller': {
        fontFamily: 'inherit',
        lineHeight: '1.5',
        overflow: 'auto',
      },
      '.cm-content': {
        padding: '8px 2px',
        lineHeight: '1.5',
      },
      '.cm-line': {
        padding: '0',
        lineHeight: '1.5',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: accent,
        borderLeftWidth: '2px',
      },
      '&.cm-focused .cm-selectionBackground, ::selection': {
        backgroundColor: `color-mix(in srgb, ${accent} 28%, transparent)`,
      },
      '.cm-selectionBackground': {
        backgroundColor: `color-mix(in srgb, ${accent} 18%, transparent)`,
      },
      '.cm-activeLine': {
        backgroundColor: 'transparent',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
      },
      '.cm-placeholder': {
        color: textMuted,
        fontStyle: 'normal',
      },
      '.cm-matchingBracket, .cm-nonmatchingBracket': {
        backgroundColor: 'transparent',
        color: accent,
        outline: `1px solid color-mix(in srgb, ${accent} 40%, transparent)`,
        borderRadius: 'var(--radius-snug)',
      },
      // Search panel
      '.cm-panels': {
        backgroundColor: bg,
        color: text,
        borderTop: `1px solid ${border}`,
      },
      '.cm-panels.cm-panels-top': {
        borderBottom: `1px solid ${border}`,
      },
      '.cm-panels input, .cm-panels button': {
        fontSize: '12px',
      },
      '.cm-searchMatch': {
        backgroundColor: `color-mix(in srgb, ${statusWarning} 35%, transparent)`,
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: `color-mix(in srgb, ${accent} 45%, transparent)`,
      },
      // NOTE: autocomplete tooltip styles live in globals.css (NOT here).
      // EditorView.theme rules are scoped to the editor's generated class, so
      // they don't reach body-mounted fixed-position tooltips. Anything here
      // would be dead code that can confuse readers later.
      // Rectangular selection marker
      '.cm-rectangularSelection': {
        backgroundColor: `color-mix(in srgb, ${accent} 16%, transparent)`,
      },
    },
    { dark: isDark }
  );

  // Syntax highlighting for markdown + embedded fences. Keeps the palette
  // narrow — prose dominates, we just differentiate code/keyword tokens so
  // fenced blocks don't look dead.
  const highlight = HighlightStyle.define([
    { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: text, fontWeight: 'bold' },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.link, color: accent, textDecoration: 'underline' },
    { tag: t.url, color: accent },
    { tag: [t.monospace, t.processingInstruction, t.meta], color: accent },
    { tag: t.quote, color: textMuted, fontStyle: 'italic' },
    { tag: t.list, color: text },
    // Code-token tags (apply inside fenced code blocks via lang-markdown's codeLanguages)
    { tag: t.keyword, color: accent },
    { tag: t.controlKeyword, color: accent },
    { tag: t.operatorKeyword, color: accent },
    { tag: [t.definition(t.variableName), t.function(t.variableName)], color: text },
    { tag: t.variableName, color: text },
    { tag: t.string, color: statusRunning },
    { tag: t.number, color: statusWarning },
    { tag: t.bool, color: statusWarning },
    { tag: t.null, color: statusWarning },
    { tag: t.comment, color: textMuted, fontStyle: 'italic' },
    { tag: t.typeName, color: statusWarning },
    { tag: t.className, color: statusWarning },
    { tag: t.propertyName, color: text },
    { tag: t.punctuation, color: textMuted },
    { tag: t.bracket, color: textMuted },
    { tag: t.tagName, color: accent },
    { tag: t.attributeName, color: statusWarning },
    { tag: t.attributeValue, color: statusRunning },
    { tag: t.invalid, color: statusError },
  ]);

  return [baseTheme, syntaxHighlighting(highlight)];
}
