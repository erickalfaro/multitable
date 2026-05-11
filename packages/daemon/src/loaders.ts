/**
 * Canonical list of dot-matrix loader variants. Mirrors the array exported from
 * packages/web/src/components/ui/loaders.ts — keep them in sync if loaders are
 * added or removed. Used by the project store to assign each project a unique
 * loader on creation, cycling through every variant before any reuse.
 */
export const LOADER_VARIANTS: readonly string[] = [
  'dotm-square-1',
  'dotm-square-2',
  'dotm-square-3',
  'dotm-square-4',
  'dotm-square-5',
  'dotm-square-6',
  'dotm-square-7',
  'dotm-square-8',
  'dotm-square-9',
  'dotm-square-10',
  'dotm-square-11',
  'dotm-square-12',
  'dotm-square-13',
  'dotm-square-14',
  'dotm-square-15',
  'dotm-square-16',
  'dotm-square-17',
  'dotm-square-18',
  'dotm-square-19',
  'dotm-square-20',
  'dotm-circular-1',
  'dotm-circular-2',
  'dotm-circular-3',
  'dotm-circular-4',
  'dotm-circular-5',
  'dotm-circular-6',
  'dotm-circular-7',
  'dotm-circular-8',
  'dotm-circular-9',
  'dotm-circular-10',
  'dotm-circular-11',
  'dotm-circular-12',
  'dotm-circular-13',
  'dotm-circular-14',
  'dotm-circular-15',
  'dotm-circular-16',
  'dotm-circular-17',
  'dotm-circular-18',
  'dotm-circular-19',
  'dotm-circular-20',
  'dotm-triangle-1',
  'dotm-triangle-2',
  'dotm-triangle-3',
  'dotm-triangle-4',
  'dotm-triangle-5',
  'dotm-triangle-6',
  'dotm-triangle-7',
  'dotm-triangle-8',
  'dotm-triangle-9',
  'dotm-triangle-10',
  'dotm-triangle-11',
  'dotm-triangle-12',
  'dotm-triangle-13',
  'dotm-triangle-14',
  'dotm-triangle-15',
  'dotm-triangle-16',
  'dotm-triangle-17',
  'dotm-triangle-18',
  'dotm-triangle-19',
  'dotm-triangle-20',
];

/**
 * Pick a loader variant for a new project, given the variants currently assigned
 * to existing projects. Returns a random variant from the unused pool; once every
 * variant is in use, returns a random variant from the full list (uniform reuse).
 */
export function pickLoaderVariant(usedVariants: Iterable<string>): string {
  const used = new Set(usedVariants);
  const unused = LOADER_VARIANTS.filter((v) => !used.has(v));
  const pool = unused.length > 0 ? unused : LOADER_VARIANTS;
  return pool[Math.floor(Math.random() * pool.length)]!;
}
