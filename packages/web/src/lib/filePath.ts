// Join a project root (an OS-native absolute path, as the daemon stored it) with
// a project-relative path (always '/'-separated on the wire) into a full absolute
// path. The separator follows the root's own style so a Windows root yields
// `C:\repo\src\App.tsx` and a POSIX root yields `/home/me/repo/src/App.tsx`.
export function absoluteFilePath(projectRoot: string, relPath: string): string {
  const rel = relPath.replace(/^[\\/]+/, '');
  const winStyle = /^[a-zA-Z]:[\\/]/.test(projectRoot) || projectRoot.startsWith('\\\\');
  const sep = winStyle ? '\\' : '/';
  const root = projectRoot.replace(/[\\/]+$/, '');
  if (!rel) return root || sep;
  return `${root}${sep}${winStyle ? rel.replace(/\//g, '\\') : rel}`;
}

// Mirror the daemon's POST /file-content validation so we fail fast in the UI.
export function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

export function validateNewPath(raw: string): string | null {
  const p = raw.trim();
  if (!p) return 'Enter a file path';
  if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) return 'Path must be relative to the project';
  if (p.includes('\\')) return 'Use forward slashes (/)';
  if (p.endsWith('/')) return 'Path must point to a file, not a directory';
  if (p.split('/').includes('..')) return 'Path may not contain ".."';
  if (hasControlChar(p)) return 'Path contains invalid characters';
  return null;
}
