/**
 * Curated project glyphs for the left rail. Stored by stable string id in
 * `projectNav.glyphs[projectId]`. Absent key → fall back to project acronyms.
 */

import type { LucideIcon } from 'lucide-react';
import {
  Atom,
  Boxes,
  Brain,
  Briefcase,
  Bug,
  Code2,
  Coffee,
  Compass,
  Cpu,
  Database,
  Feather,
  Flame,
  Folder,
  FolderGit2,
  Globe,
  Hexagon,
  Layers,
  Leaf,
  Lightbulb,
  Map as MapIcon,
  Moon,
  Mountain,
  Package,
  Palette,
  Rocket,
  Server,
  Shield,
  Sparkles,
  Star,
  Terminal,
  Wrench,
  Zap,
} from 'lucide-react';

export interface ProjectGlyphOption {
  id: string;
  label: string;
  Icon: LucideIcon;
}

/** Ordered palette shown in the glyph picker. */
export const PROJECT_GLYPHS: ProjectGlyphOption[] = [
  { id: 'folder', label: 'Folder', Icon: Folder },
  { id: 'folder-git', label: 'Git', Icon: FolderGit2 },
  { id: 'code', label: 'Code', Icon: Code2 },
  { id: 'terminal', label: 'Terminal', Icon: Terminal },
  { id: 'rocket', label: 'Rocket', Icon: Rocket },
  { id: 'zap', label: 'Zap', Icon: Zap },
  { id: 'sparkles', label: 'Sparkles', Icon: Sparkles },
  { id: 'star', label: 'Star', Icon: Star },
  { id: 'flame', label: 'Flame', Icon: Flame },
  { id: 'atom', label: 'Atom', Icon: Atom },
  { id: 'brain', label: 'Brain', Icon: Brain },
  { id: 'cpu', label: 'CPU', Icon: Cpu },
  { id: 'server', label: 'Server', Icon: Server },
  { id: 'database', label: 'Database', Icon: Database },
  { id: 'boxes', label: 'Boxes', Icon: Boxes },
  { id: 'package', label: 'Package', Icon: Package },
  { id: 'layers', label: 'Layers', Icon: Layers },
  { id: 'hexagon', label: 'Hexagon', Icon: Hexagon },
  { id: 'globe', label: 'Globe', Icon: Globe },
  { id: 'map', label: 'Map', Icon: MapIcon },
  { id: 'compass', label: 'Compass', Icon: Compass },
  { id: 'mountain', label: 'Mountain', Icon: Mountain },
  { id: 'leaf', label: 'Leaf', Icon: Leaf },
  { id: 'feather', label: 'Feather', Icon: Feather },
  { id: 'palette', label: 'Palette', Icon: Palette },
  { id: 'lightbulb', label: 'Idea', Icon: Lightbulb },
  { id: 'briefcase', label: 'Briefcase', Icon: Briefcase },
  { id: 'wrench', label: 'Wrench', Icon: Wrench },
  { id: 'shield', label: 'Shield', Icon: Shield },
  { id: 'bug', label: 'Bug', Icon: Bug },
  { id: 'coffee', label: 'Coffee', Icon: Coffee },
  { id: 'moon', label: 'Moon', Icon: Moon },
];

const BY_ID = new Map(PROJECT_GLYPHS.map((g) => [g.id, g]));

export function getProjectGlyph(id: string | null | undefined): ProjectGlyphOption | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

export function isProjectGlyphId(id: string): boolean {
  return BY_ID.has(id);
}
