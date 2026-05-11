import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import { api } from './api';

// ─── File mentions (@-triggered) ─────────────────────────────────────────────

interface FileIndexEntry {
  path: string;
  name: string;
  isDir: boolean;
}

interface FileIndex {
  projectId: string;
  loadedAt: number;
  entries: FileIndexEntry[];
}

// In-memory index per project, refreshed at most every 20s. Walks the project
// tree one level at a time because the backend returns flat listings per path
// — we BFS up to a reasonable depth / cap to keep latency low.
const indexCache = new Map<string, FileIndex>();
const INDEX_TTL_MS = 20_000;
const MAX_ENTRIES = 8000;
const MAX_DEPTH = 5;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache', 'coverage']);

async function walkProject(projectId: string): Promise<FileIndexEntry[]> {
  const out: FileIndexEntry[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: '', depth: 0 }];
  while (queue.length && out.length < MAX_ENTRIES) {
    const { path, depth } = queue.shift()!;
    let entries: Array<{ name: string; path: string; type: string }> = [];
    try {
      entries = (await api.projects.files(projectId, path || undefined)) as any;
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const isDir = e.type === 'directory';
      out.push({ path: e.path, name: e.name, isDir });
      if (isDir && depth < MAX_DEPTH) {
        queue.push({ path: e.path, depth: depth + 1 });
      }
    }
  }
  return out;
}

async function getIndex(projectId: string): Promise<FileIndexEntry[]> {
  const cached = indexCache.get(projectId);
  if (cached && Date.now() - cached.loadedAt < INDEX_TTL_MS) {
    return cached.entries;
  }
  const entries = await walkProject(projectId);
  indexCache.set(projectId, { projectId, loadedAt: Date.now(), entries });
  return entries;
}

// Kick the index early (e.g. when the composer mounts) so the first @ is fast.
export function warmProjectIndex(projectId: string): void {
  getIndex(projectId).catch(() => {});
}

// Manual invalidation — call if files are known to have changed.
export function invalidateProjectIndex(projectId: string): void {
  indexCache.delete(projectId);
}

function fuzzyScore(query: string, candidate: string): number {
  // Lightweight subsequence match: returns -1 if q isn't a subsequence of c.
  // Otherwise returns a score — lower is better (tighter / earlier match).
  if (!query) return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  // Fast path: substring match scores highest.
  const idx = c.indexOf(q);
  if (idx >= 0) return idx; // earlier substring = lower score
  // Subsequence fallback.
  let ci = 0;
  let spread = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = c.indexOf(q[qi], ci);
    if (found < 0) return -1;
    spread += found - ci;
    ci = found + 1;
  }
  return 1000 + spread; // always worse than substring but still ranked.
}

export function fileMentionSource(projectIdGetter: () => string | null) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const match = ctx.matchBefore(/@[\w./-]*/);
    if (!match) return null;
    // Require the char before '@' to be whitespace/start — avoids triggering
    // inside emails etc.
    if (match.from > 0) {
      const prev = ctx.state.sliceDoc(match.from - 1, match.from);
      if (!/\s/.test(prev)) return null;
    }
    if (!match.text.startsWith('@')) return null;
    const query = match.text.slice(1);
    const projectId = projectIdGetter();
    if (!projectId) return null;

    const entries = await getIndex(projectId).catch(() => [] as FileIndexEntry[]);
    const scored: Array<{ e: FileIndexEntry; score: number }> = [];
    for (const e of entries) {
      if (e.isDir) continue;
      const s = fuzzyScore(query, e.path);
      if (s < 0) continue;
      scored.push({ e, score: s });
    }
    scored.sort((a, b) => a.score - b.score);

    const options: Completion[] = scored.slice(0, 40).map(({ e }, idx) => {
      const dir = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
      return {
        label: e.name,
        detail: dir || undefined,
        type: 'file',
        apply: `@${e.path} `,
        boost: 100 - idx,
      };
    });

    // `filter: false` tells CM6 not to re-filter our options against the
    // typed text. This is essential here: the user types `@projects` but
    // option labels are `package.json`, `Button.tsx`, etc. — none of them
    // share the `@` prefix, so CM6's default prefix-match filter would
    // discard every option and silently close the popup. We've already
    // filtered via `fuzzyScore` upstream, so trust that result.
    return { from: match.from, options, validFor: /^@[\w./-]*$/, filter: false };
  };
}

// ─── Slash commands (/-triggered) ────────────────────────────────────────────
//
// With the SDK driving sessions (no TUI), slash commands sent through the
// composer flow through query() as user prompts. The SDK reads `.claude/commands/*.md`
// (project) and `~/.claude/commands/*.md` (user-global) and substitutes
// arguments into those templates. Built-in TUI slash commands (`/clear`,
// `/model`, `/compact`) are NOT handled by the SDK and would simply land as
// literal text — those need MultiTable-native equivalents to behave correctly.
// We surface custom commands the user defined; we don't surface the
// problematic built-ins.
//
// The slash-command list is fetched once per project (5-min TTL) so the
// dropdown isn't paying an HTTP round-trip per keystroke.

interface SlashCmdSpec {
  name: string;        // includes leading slash, e.g. '/init'
  description: string;
  scope: 'project' | 'user' | 'builtin';
}

interface SlashIndex {
  loadedAt: number;
  commands: SlashCmdSpec[];
}

const slashCache = new Map<string, SlashIndex>();
const SLASH_TTL_MS = 5 * 60 * 1000;

// Built-in slash commands MultiTable handles natively. We deliberately ONLY
// surface the ones we actually intercept in ChatInputCM's `handleNativeSlash`
// — surfacing others (e.g. /model, /init, /compact) would mislead users
// because the SDK doesn't intercept them and they'd land as plain-text
// prompts. Custom commands from `.claude/commands/*.md` flow through the SDK
// natively and are added to this list at fetch time.
const BUILTIN_SLASH_COMMANDS: SlashCmdSpec[] = [
  { name: '/clear',    description: 'clear conversation',  scope: 'builtin' },
  { name: '/cost',     description: 'show session cost',   scope: 'builtin' },
];

async function getSlashCommands(projectId: string): Promise<SlashCmdSpec[]> {
  const cached = slashCache.get(projectId);
  if (cached && Date.now() - cached.loadedAt < SLASH_TTL_MS) return cached.commands;
  let custom: SlashCmdSpec[] = [];
  try {
    const res = await api.projects.slashCommands(projectId);
    custom = res.commands;
  } catch {}
  // Merge: project > user > builtin. Project / user shadow same-named builtins.
  const seen = new Set(custom.map((c) => c.name));
  const merged = [
    ...custom,
    ...BUILTIN_SLASH_COMMANDS.filter((c) => !seen.has(c.name)),
  ];
  slashCache.set(projectId, { loadedAt: Date.now(), commands: merged });
  return merged;
}

export function warmSlashCommands(projectId: string): void {
  void getSlashCommands(projectId);
}

export function invalidateSlashCommands(projectId: string): void {
  slashCache.delete(projectId);
}

export function slashCommandSource(projectIdGetter: () => string | null) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const match = ctx.matchBefore(/\/[\w-]*/);
    if (!match) return null;
    const line = ctx.state.doc.lineAt(match.from);
    if (match.from !== line.from) return null;

    const projectId = projectIdGetter();
    if (!projectId) return null;

    const commands = await getSlashCommands(projectId);
    if (commands.length === 0) return null;

    const query = match.text.slice(1).toLowerCase();
    const filtered = commands.filter((c) => c.name.slice(1).toLowerCase().startsWith(query));
    if (filtered.length === 0) return null;

    const options: Completion[] = filtered.map((c) => ({
      label: c.name,
      detail: c.description || c.scope,
      type: 'command',
      apply: c.name + ' ',
      // Rank: project (2) > user (1) > builtin (0).
      boost: c.scope === 'project' ? 2 : c.scope === 'user' ? 1 : 0,
    }));

    return { from: match.from, options, validFor: /^\/[\w-]*$/ };
  };
}
