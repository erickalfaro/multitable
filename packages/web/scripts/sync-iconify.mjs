#!/usr/bin/env node
/**
 * Sync Iconify sets from ericks_design_store (or a path) into public/iconify/
 * and rebuild the compact names index used by the glyph picker.
 *
 * Usage:
 *   node packages/web/scripts/sync-iconify.mjs
 *   node packages/web/scripts/sync-iconify.mjs /path/to/ericks_design_store
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');
const outDir = path.join(webRoot, 'public', 'iconify');

const sourceRoot =
  process.argv[2] ||
  path.resolve(webRoot, '../../../ericks_design_store') ||
  path.resolve(webRoot, '../../ericks_design_store');

// Prefer sibling of multitable monorepo
const candidates = [
  process.argv[2],
  path.resolve(webRoot, '../../../ericks_design_store'),
  path.resolve(webRoot, '../../../../ericks_design_store'),
  '/home/erick/Documents/ericks_design_store',
].filter(Boolean);

const designStore = candidates.find((p) => fs.existsSync(path.join(p, 'data', 'meta.json')));
if (!designStore) {
  console.error('Could not find ericks_design_store/data/meta.json');
  process.exit(1);
}

const SETS = [
  { file: 'lucide.json', prefix: 'lucide', name: 'Lucide', style: 'line' },
  { file: 'ph.json', prefix: 'ph', name: 'Phosphor', style: 'multi-weight' },
  { file: 'tabler.json', prefix: 'tabler', name: 'Tabler', style: 'line' },
  { file: 'heroicons.json', prefix: 'heroicons', name: 'Heroicons', style: 'outline/solid' },
  { file: 'radix-icons.json', prefix: 'radix-icons', name: 'Radix', style: 'UI' },
  { file: 'feather.json', prefix: 'feather', name: 'Feather', style: 'line' },
  { file: 'material-symbols.json', prefix: 'material-symbols', name: 'Material Symbols', style: 'system' },
  { file: 'ri.json', prefix: 'ri', name: 'Remix', style: 'line/fill' },
  { file: 'bi.json', prefix: 'bi', name: 'Bootstrap', style: 'fill' },
  { file: 'iconoir.json', prefix: 'iconoir', name: 'Iconoir', style: 'line' },
  { file: 'bx.json', prefix: 'bx', name: 'Boxicons', style: 'line/solid/logos' },
];

fs.mkdirSync(outDir, { recursive: true });

const sets = [];
const icons = {};
let total = 0;

for (const s of SETS) {
  const src = path.join(designStore, 'data', s.file);
  if (!fs.existsSync(src)) {
    console.warn('skip missing', s.file);
    continue;
  }
  const dest = path.join(outDir, `${s.prefix}.json`);
  fs.copyFileSync(src, dest);
  const data = JSON.parse(fs.readFileSync(dest, 'utf8'));
  const names = Object.keys(data.icons || {});
  const aliases = Object.keys(data.aliases || {});
  const all = [...new Set([...names, ...aliases])].sort();
  icons[s.prefix] = all;
  total += all.length;
  sets.push({
    prefix: s.prefix,
    name: s.name,
    style: s.style,
    count: all.length,
  });
  console.log(`  ${s.prefix.padEnd(20)} ${String(all.length).padStart(6)}`);
}

sets.sort((a, b) => a.name.localeCompare(b.name));
const index = {
  generatedAt: new Date().toISOString(),
  source: designStore,
  totalIcons: total,
  sets,
  icons,
};
fs.writeFileSync(path.join(outDir, 'names.json'), JSON.stringify(index));
console.log(`\n${total} icons · ${sets.length} sets → ${outDir}`);
console.log(`names.json ${(fs.statSync(path.join(outDir, 'names.json')).size / 1024).toFixed(1)} KB`);
