/**
 * Offline multi-set Iconify catalog for project glyphs.
 *
 * Assets live in `public/iconify/` (synced from ericks_design_store):
 *   names.json          — compact search index (~900 KB, all set names)
 *   {prefix}.json       — full Iconify collection (lazy-loaded per set)
 *
 * Glyph ids are stored as `prefix:name` (e.g. `tabler:robot`, `ph:cat-fill`).
 * Legacy bare Lucide ids (`folder`, `rocket`) still resolve.
 */

import { addCollection, iconLoaded } from '@iconify/react';

export type IconSetMeta = {
  prefix: string;
  name: string;
  style: string;
  count: number;
};

export type IconRef = {
  /** Fully-qualified id: `prefix:name` */
  id: string;
  prefix: string;
  name: string;
  label: string;
};

type NamesIndex = {
  totalIcons: number;
  sets: IconSetMeta[];
  icons: Record<string, string[]>;
};

let namesIndex: NamesIndex | null = null;
let namesPromise: Promise<NamesIndex> | null = null;
const loadedSets = new Set<string>();
const loadingSets = new Map<string, Promise<void>>();

/** Legacy curated / bare Lucide ids → canonical `lucide:…` form. */
const LEGACY_BARE: Record<string, string> = {
  'folder-git': 'lucide:folder-git-2',
  code: 'lucide:code',
  lightbulb: 'lucide:lightbulb',
  folder: 'lucide:folder',
  terminal: 'lucide:terminal',
  rocket: 'lucide:rocket',
  zap: 'lucide:zap',
  sparkles: 'lucide:sparkles',
  star: 'lucide:star',
  flame: 'lucide:flame',
  atom: 'lucide:atom',
  brain: 'lucide:brain',
  cpu: 'lucide:cpu',
  server: 'lucide:server',
  database: 'lucide:database',
  boxes: 'lucide:boxes',
  package: 'lucide:package',
  layers: 'lucide:layers',
  hexagon: 'lucide:hexagon',
  globe: 'lucide:globe',
  map: 'lucide:map',
  compass: 'lucide:compass',
  mountain: 'lucide:mountain',
  leaf: 'lucide:leaf',
  feather: 'lucide:feather',
  palette: 'lucide:palette',
  briefcase: 'lucide:briefcase',
  wrench: 'lucide:wrench',
  shield: 'lucide:shield',
  bug: 'lucide:bug',
  coffee: 'lucide:coffee',
  moon: 'lucide:moon',
};

function humanize(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Normalize stored glyph id to `prefix:name`. */
export function normalizeGlyphId(id: string | null | undefined): string | null {
  if (!id) return null;
  if (LEGACY_BARE[id]) return LEGACY_BARE[id];
  if (id.includes(':')) return id;
  // Bare name → assume Lucide (pre multi-set storage)
  return `lucide:${id}`;
}

export function parseGlyphId(
  id: string | null | undefined,
): { prefix: string; name: string } | null {
  const norm = normalizeGlyphId(id);
  if (!norm) return null;
  const i = norm.indexOf(':');
  if (i <= 0) return null;
  const prefix = norm.slice(0, i);
  const name = norm.slice(i + 1);
  if (!prefix || !name) return null;
  return { prefix, name };
}

export function formatGlyphId(prefix: string, name: string): string {
  return `${prefix}:${name}`;
}

/** Base URL for icon assets — works in Vite dev and production. */
function iconifyUrl(file: string): string {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
  return `${base}iconify/${file}`;
}

export async function loadNamesIndex(): Promise<NamesIndex> {
  if (namesIndex) return namesIndex;
  if (!namesPromise) {
    namesPromise = fetch(iconifyUrl('names.json'))
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load icon index (${r.status})`);
        return r.json() as Promise<NamesIndex>;
      })
      .then((data) => {
        namesIndex = data;
        return data;
      })
      .catch((err) => {
        namesPromise = null;
        throw err;
      });
  }
  return namesPromise;
}

export function getCachedSets(): IconSetMeta[] {
  return namesIndex?.sets ?? [];
}

export function getTotalIconCount(): number {
  return namesIndex?.totalIcons ?? 0;
}

/** Ensure an Iconify collection is registered for rendering. */
export async function ensureIconSet(prefix: string): Promise<void> {
  if (loadedSets.has(prefix)) return;
  const inflight = loadingSets.get(prefix);
  if (inflight) return inflight;

  const p = (async () => {
    const res = await fetch(iconifyUrl(`${prefix}.json`));
    if (!res.ok) throw new Error(`Failed to load icon set ${prefix} (${res.status})`);
    const data = await res.json();
    addCollection(data);
    loadedSets.add(prefix);
    loadingSets.delete(prefix);
  })().catch((err) => {
    loadingSets.delete(prefix);
    throw err;
  });

  loadingSets.set(prefix, p);
  return p;
}

/** Prefetch several sets (e.g. for visible search hits). */
export async function ensureIconSets(prefixes: Iterable<string>): Promise<void> {
  const unique = [...new Set(prefixes)];
  await Promise.all(unique.map((p) => ensureIconSet(p).catch(() => undefined)));
}

export function isSetLoaded(prefix: string): boolean {
  return loadedSets.has(prefix);
}

export function iconReady(id: string | null | undefined): boolean {
  const parsed = parseGlyphId(id);
  if (!parsed) return false;
  if (!loadedSets.has(parsed.prefix)) return false;
  return iconLoaded(`${parsed.prefix}:${parsed.name}`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function matchIconQuery(query: string, id: string, label: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hayId = id.toLowerCase();
  const hayLabel = label.toLowerCase();
  const hayName = hayId.includes(':') ? hayId.slice(hayId.indexOf(':') + 1) : hayId;

  if (!/[*?]/.test(q)) {
    const tokens = q.split(/\s+/).filter(Boolean);
    return tokens.every(
      (t) => hayId.includes(t) || hayName.includes(t) || hayLabel.includes(t),
    );
  }

  const pattern = escapeRegex(q).replace(/\*/g, '.*').replace(/\?/g, '.');
  const re = new RegExp(`^${pattern}$`, 'i');
  return re.test(hayId) || re.test(hayName) || re.test(hayLabel.replace(/\s+/g, '-'));
}

export type SearchOpts = {
  /** Restrict to one set prefix, or null/undefined for all. */
  set?: string | null;
  limit?: number;
};

/**
 * Search the names index. Call `loadNamesIndex()` first (or this will throw
 * if the index is not yet loaded — the picker loads it on open).
 */
export function searchIcons(query: string, opts: SearchOpts = {}): IconRef[] {
  if (!namesIndex) return [];
  const limit = opts.limit ?? 400;
  const setFilter = opts.set || null;
  const q = query.trim();

  const refs: IconRef[] = [];
  const push = (prefix: string, name: string) => {
    const id = formatGlyphId(prefix, name);
    const label = humanize(name);
    if (q && !matchIconQuery(q, id, label)) return;
    refs.push({ id, prefix, name, label });
  };

  const prefixes = setFilter
    ? [setFilter]
    : namesIndex.sets.map((s) => s.prefix);

  if (!q) {
    // Browse: return a slice of the full set (or all if set-filtered).
    for (const prefix of prefixes) {
      const names = namesIndex.icons[prefix] ?? [];
      for (const name of names) {
        push(prefix, name);
        if (refs.length >= limit) return refs;
      }
    }
    return refs;
  }

  // Ranked search across sets
  const qLower = q.toLowerCase().replace(/[*?]/g, '');
  const hits: Array<{ ref: IconRef; score: number }> = [];

  for (const prefix of prefixes) {
    const names = namesIndex.icons[prefix] ?? [];
    for (const name of names) {
      const id = formatGlyphId(prefix, name);
      const label = humanize(name);
      if (!matchIconQuery(q, id, label)) continue;
      const nameL = name.toLowerCase();
      let score = 4;
      if (nameL === qLower || id === qLower) score = 0;
      else if (nameL.startsWith(qLower)) score = 1;
      else if (label.toLowerCase().startsWith(qLower)) score = 2;
      else if (nameL.includes(qLower)) score = 3;
      hits.push({ ref: { id, prefix, name, label }, score });
    }
  }

  hits.sort(
    (a, b) => a.score - b.score || a.ref.id.localeCompare(b.ref.id),
  );
  return hits.slice(0, limit).map((h) => h.ref);
}

/** Diverse cross-set samples for the quick-picks strip. */
export const FEATURED_ICON_IDS: string[] = [
  // Life & home
  'lucide:home',
  'lucide:coffee',
  'lucide:utensils',
  'lucide:heart',
  'lucide:baby',
  'ph:house-line',
  // Nature
  'lucide:sun',
  'lucide:moon',
  'lucide:mountain',
  'lucide:tree-pine',
  'lucide:flower-2',
  'lucide:cat',
  'lucide:dog',
  'lucide:fish',
  'ph:cat',
  'ph:plant',
  'tabler:seeding',
  // Food & fun
  'lucide:pizza',
  'lucide:cookie',
  'lucide:gamepad-2',
  'lucide:puzzle',
  'lucide:music-2',
  'tabler:pizza',
  'ph:game-controller',
  // Arts
  'lucide:palette',
  'lucide:brush',
  'lucide:camera',
  'lucide:film',
  'lucide:book-open',
  'tabler:palette',
  // Travel
  'lucide:plane',
  'lucide:bike',
  'lucide:map',
  'lucide:globe',
  'lucide:compass',
  'tabler:plane',
  // Science / health / work
  'lucide:flask-conical',
  'lucide:dna',
  'lucide:stethoscope',
  'lucide:graduation-cap',
  'lucide:briefcase',
  'lucide:scale',
  'material-symbols:science',
  // Light tech (one slice, not the whole picker)
  'lucide:folder',
  'lucide:code',
  'lucide:bot',
  'lucide:rocket',
  'tabler:robot',
  'ph:robot',
  'tabler:brand-github',
  'tabler:brand-docker',
  'ri:sparkling-2-line',
  'bx:code-alt',
  'iconoir:brain-electricity',
  'heroicons:academic-cap',
  'feather:feather',
  'radix-icons:rocket',
];

export function featuredIcons(): IconRef[] {
  return FEATURED_ICON_IDS.map((id) => {
    const p = parseGlyphId(id);
    if (!p) return null;
    return {
      id: formatGlyphId(p.prefix, p.name),
      prefix: p.prefix,
      name: p.name,
      label: humanize(p.name),
    };
  }).filter((x): x is IconRef => !!x);
}
