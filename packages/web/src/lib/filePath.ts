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
