import type { Highlighter } from 'shiki';

// Lazy singleton highlighter. Shiki bundles WASM and a chunky theme JSON, so
// we hold one instance process-wide and only load the languages we need.
let highlighterPromise: Promise<Highlighter> | null = null;

// Languages covered; extend as needed. The highlighter falls back to plain
// rendering for anything unknown.
const LANGS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'python',
  'rust',
  'go',
  'bash',
  'shell',
  'yaml',
  'sql',
  'html',
  'css',
  'markdown',
  'diff',
  'toml',
] as const;

// Hand-rolled monochrome theme — amber + grays only. Honors the Obsidian
// manifesto's "no blue. anywhere." rule. Strings deliberately use a softer
// gray so prose-like content (paths, messages) recedes behind keywords.
const obsidianDark = {
  name: 'obsidian-dark',
  type: 'dark',
  colors: {
    'editor.background': '#0e0e12',
    'editor.foreground': '#b8b8c4',
  },
  tokenColors: [
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
      settings: { foreground: '#4a4a55', fontStyle: 'italic' },
    },
    {
      scope: [
        'keyword',
        'keyword.control',
        'storage',
        'storage.type',
        'storage.modifier',
        'keyword.operator.expression',
      ],
      settings: { foreground: '#ff8a00' },
    },
    {
      scope: ['string', 'string.quoted', 'string.template'],
      settings: { foreground: '#7a7a87' },
    },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.character'],
      settings: { foreground: '#e6e6ed' },
    },
    {
      scope: ['constant.language.boolean', 'constant.language.null'],
      settings: { foreground: '#e6e6ed' },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'entity.name.namespace',
        'support.type',
        'support.class',
      ],
      settings: { foreground: '#cc6e00' },
    },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'meta.function-call.generic',
        'variable.function',
      ],
      settings: { foreground: '#e6e6ed' },
    },
    {
      scope: [
        'variable',
        'variable.parameter',
        'variable.other',
        'meta.definition.variable',
      ],
      settings: { foreground: '#b8b8c4' },
    },
    {
      scope: ['punctuation', 'meta.brace', 'keyword.operator', 'keyword.operator.assignment'],
      settings: { foreground: '#7a7a87' },
    },
    {
      scope: ['entity.other.attribute-name', 'entity.name.tag'],
      settings: { foreground: '#ff8a00' },
    },
    {
      scope: ['invalid', 'invalid.illegal'],
      settings: { foreground: '#ff4d4f' },
    },
    {
      scope: ['markup.deleted', 'punctuation.definition.deleted'],
      settings: { foreground: '#ff4d4f' },
    },
    {
      scope: ['markup.inserted', 'punctuation.definition.inserted'],
      settings: { foreground: '#2ecc71' },
    },
    {
      scope: ['markup.changed', 'punctuation.definition.changed'],
      settings: { foreground: '#ff8a00' },
    },
    {
      scope: ['markup.bold'],
      settings: { foreground: '#e6e6ed', fontStyle: 'bold' },
    },
    {
      scope: ['markup.italic'],
      settings: { foreground: '#b8b8c4', fontStyle: 'italic' },
    },
    {
      scope: ['markup.heading', 'entity.name.section'],
      settings: { foreground: '#ff8a00', fontStyle: 'bold' },
    },
    {
      scope: ['markup.underline.link', 'string.other.link'],
      settings: { foreground: '#ff8a00' },
    },
  ],
};

const obsidianLight = {
  name: 'obsidian-light',
  type: 'light',
  colors: {
    'editor.background': '#fbf8ef',
    'editor.foreground': '#1a1a14',
  },
  tokenColors: [
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
      settings: { foreground: '#a8a397', fontStyle: 'italic' },
    },
    {
      scope: ['keyword', 'keyword.control', 'storage', 'storage.type', 'storage.modifier'],
      settings: { foreground: '#b35e00' },
    },
    {
      scope: ['string', 'string.quoted', 'string.template'],
      settings: { foreground: '#7a7468' },
    },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.character'],
      settings: { foreground: '#1a1a14' },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'entity.name.namespace',
        'support.type',
        'support.class',
      ],
      settings: { foreground: '#b35e00' },
    },
    {
      scope: [
        'entity.name.function',
        'support.function',
        'meta.function-call.generic',
        'variable.function',
      ],
      settings: { foreground: '#1a1a14' },
    },
    {
      scope: ['variable', 'variable.parameter', 'variable.other'],
      settings: { foreground: '#4a4538' },
    },
    {
      scope: ['punctuation', 'meta.brace', 'keyword.operator'],
      settings: { foreground: '#7a7468' },
    },
    {
      scope: ['entity.other.attribute-name', 'entity.name.tag'],
      settings: { foreground: '#b35e00' },
    },
    {
      scope: ['invalid', 'invalid.illegal'],
      settings: { foreground: '#c92a2a' },
    },
    {
      scope: ['markup.deleted'],
      settings: { foreground: '#c92a2a' },
    },
    {
      scope: ['markup.inserted'],
      settings: { foreground: '#1f9d55' },
    },
    {
      scope: ['markup.heading'],
      settings: { foreground: '#b35e00', fontStyle: 'bold' },
    },
    {
      scope: ['markup.underline.link', 'string.other.link'],
      settings: { foreground: '#b35e00' },
    },
  ],
};

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const shiki = await import('shiki');
      return shiki.createHighlighter({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        themes: [obsidianDark as any, obsidianLight as any],
        langs: [...LANGS],
      });
    })();
  }
  return highlighterPromise;
}

// Known shiki language aliases — normalize common markdown fence names.
const LANG_ALIAS: Record<string, string> = {
  typescript: 'ts',
  javascript: 'js',
  py: 'python',
  rs: 'rust',
  golang: 'go',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
};

export function normalizeLang(lang: string | undefined): string | null {
  if (!lang) return null;
  const lower = lang.toLowerCase();
  const resolved = LANG_ALIAS[lower] ?? lower;
  if ((LANGS as readonly string[]).includes(resolved)) return resolved;
  return null;
}

export function pickShikiTheme(isDark: boolean): string {
  return isDark ? 'obsidian-dark' : 'obsidian-light';
}
