import type { DiscoveredModel } from './types';

const DECORATION_RE =
  /\s*[—–-]?\s*\(?\s*(?:recommended|default)\s*\)?\s*$|\s*[—–-]\s*(?:recommended|default)\s*$/i;

function stripDecorations(name: string): string {
  let out = name;
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(DECORATION_RE, '').trim();
    if (next === out) break;
    out = next;
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function cleanModelLabel(model: Pick<DiscoveredModel, 'displayName' | 'description' | 'id'>): string {
  const stripped = stripDecorations(model.displayName || '');
  if (stripped && stripped.toLowerCase() !== 'default') return stripped;
  const desc = (model.description || '').split(/[·•|–—]/)[0]?.trim();
  if (desc) return desc;
  return model.id;
}

export function cleanModelLabelFromCatalog(
  modelId: string | null | undefined,
  catalog: DiscoveredModel[] | null | undefined,
): string | null {
  if (!modelId) return null;
  const entry = catalog?.find((m) => m.id === modelId);
  if (entry) return cleanModelLabel(entry);
  return stripDecorations(modelId) || modelId;
}
