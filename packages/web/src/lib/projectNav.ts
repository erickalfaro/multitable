import type { Project, ProjectNavEntry, ProjectNavPrefs } from './types';

// Pure ordering helpers for the ProjectRail's entry list (projects + user
// dividers). The persisted `entries` list is advisory: project entries whose
// id no longer exists are skipped at render (pruned only on removeProject),
// and projects the list has never seen append at the end in server
// (created_at) order — so a project added from another browser still shows up.

export type RailEntry =
  | { kind: 'project'; id: string; project: Project }
  | { kind: 'divider'; id: string };

export function orderRailEntries(projects: Project[], nav: ProjectNavPrefs): RailEntry[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const out: RailEntry[] = [];
  const seen = new Set<string>();
  for (const entry of nav.entries) {
    if (entry.kind === 'divider') {
      out.push({ kind: 'divider', id: entry.id });
      continue;
    }
    const project = byId.get(entry.id);
    if (!project) continue;
    seen.add(entry.id);
    out.push({ kind: 'project', id: entry.id, project });
  }
  for (const project of projects) {
    if (!seen.has(project.id)) out.push({ kind: 'project', id: project.id, project });
  }
  return out;
}

/**
 * Materialize the fully-resolved entries list (what orderRailEntries renders)
 * back into persistable form — used before any structural edit (drag commit,
 * divider insert) so projects that were only implicitly appended get explicit
 * positions.
 */
export function materializeNavEntries(
  projects: Project[],
  nav: ProjectNavPrefs,
): ProjectNavEntry[] {
  return orderRailEntries(projects, nav).map((e) => ({ kind: e.kind, id: e.id }));
}

/**
 * Collapse adjacent duplicate dividers (e.g. after the project between two
 * dividers is deleted). Leading/trailing dividers are kept — a user adds a
 * divider below the last project precisely to drag things under it, and any
 * stray divider is removable via its context menu.
 */
export function normalizeNavEntries(entries: ProjectNavEntry[]): ProjectNavEntry[] {
  const out: ProjectNavEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === 'divider' && out.length > 0 && out[out.length - 1].kind === 'divider')
      continue;
    out.push(entry);
  }
  return out;
}
