export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'add' | 'del' | 'context' | 'header';
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface DiffStats {
  filesChanged: number;
  totalAdditions: number;
  totalDeletions: number;
}

export function parseDiff(raw: string): { files: DiffFile[]; stats: DiffStats } {
  if (!raw || !raw.trim()) {
    return { files: [], stats: { filesChanged: 0, totalAdditions: 0, totalDeletions: 0 } };
  }

  const files: DiffFile[] = [];
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git')) {
      i++;
      continue;
    }

    let oldPath = '';
    let newPath = '';
    const gitMatch = lines[i].match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitMatch) {
      oldPath = gitMatch[1];
      newPath = gitMatch[2];
    }
    i++;

    while (
      i < lines.length &&
      !lines[i].startsWith('---') &&
      !lines[i].startsWith('diff --git') &&
      !lines[i].startsWith('@@')
    ) {
      if (lines[i].startsWith('new file mode')) {
        oldPath = '/dev/null';
      } else if (lines[i].startsWith('deleted file mode')) {
        newPath = '/dev/null';
      }
      i++;
    }

    if (i < lines.length && lines[i].startsWith('---')) {
      const m = lines[i].match(/^--- (?:a\/)?(.+)$/);
      if (m && m[1] !== '/dev/null') oldPath = m[1];
      else if (m && m[1] === '/dev/null') oldPath = '/dev/null';
      i++;
    }
    if (i < lines.length && lines[i].startsWith('+++')) {
      const m = lines[i].match(/^\+\+\+ (?:b\/)?(.+)$/);
      if (m && m[1] !== '/dev/null') newPath = m[1];
      else if (m && m[1] === '/dev/null') newPath = '/dev/null';
      i++;
    }

    const hunks: DiffHunk[] = [];
    let fileAdditions = 0;
    let fileDeletions = 0;

    while (i < lines.length && !lines[i].startsWith('diff --git')) {
      if (lines[i].startsWith('@@')) {
        const hunkMatch = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
        if (hunkMatch) {
          const oldStart = parseInt(hunkMatch[1]);
          const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2]) : 1;
          const newStart = parseInt(hunkMatch[3]);
          const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4]) : 1;
          const hunkContext = hunkMatch[5] || '';

          const hunk: DiffHunk = {
            header: lines[i],
            oldStart,
            oldCount,
            newStart,
            newCount,
            lines: [
              {
                type: 'header',
                content: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${hunkContext}`,
              },
            ],
          };

          let oldLine = oldStart;
          let newLine = newStart;
          i++;

          while (
            i < lines.length &&
            !lines[i].startsWith('@@') &&
            !lines[i].startsWith('diff --git')
          ) {
            const line = lines[i];
            if (line.startsWith('+')) {
              hunk.lines.push({ type: 'add', content: line.substring(1), newLine: newLine++ });
              fileAdditions++;
            } else if (line.startsWith('-')) {
              hunk.lines.push({ type: 'del', content: line.substring(1), oldLine: oldLine++ });
              fileDeletions++;
            } else if (line.startsWith(' ') || line === '') {
              hunk.lines.push({
                type: 'context',
                content: line.startsWith(' ') ? line.substring(1) : line,
                oldLine: oldLine++,
                newLine: newLine++,
              });
            } else if (!line.startsWith('\\')) {
              hunk.lines.push({
                type: 'context',
                content: line,
                oldLine: oldLine++,
                newLine: newLine++,
              });
            }
            i++;
          }

          hunks.push(hunk);
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    files.push({ oldPath, newPath, hunks, additions: fileAdditions, deletions: fileDeletions });
  }

  const stats: DiffStats = {
    filesChanged: files.length,
    totalAdditions: files.reduce((s, f) => s + f.additions, 0),
    totalDeletions: files.reduce((s, f) => s + f.deletions, 0),
  };

  return { files, stats };
}

export function computeWordDiff(
  oldStr: string,
  newStr: string,
): { old: { text: string; highlight: boolean }[]; new: { text: string; highlight: boolean }[] } {
  const oldChars = oldStr.split('');
  const newChars = newStr.split('');

  if (oldChars.length > 500 || newChars.length > 500) {
    return {
      old: [{ text: oldStr, highlight: true }],
      new: [{ text: newStr, highlight: true }],
    };
  }

  let prefixLen = 0;
  const minLen = Math.min(oldChars.length, newChars.length);
  while (prefixLen < minLen && oldChars[prefixLen] === newChars[prefixLen]) prefixLen++;

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    oldChars[oldChars.length - 1 - suffixLen] === newChars[newChars.length - 1 - suffixLen]
  )
    suffixLen++;

  const commonPrefix = oldStr.substring(0, prefixLen);
  const commonSuffix = oldStr.substring(oldStr.length - suffixLen);
  const oldMiddle = oldStr.substring(prefixLen, oldStr.length - suffixLen);
  const newMiddle = newStr.substring(prefixLen, newStr.length - suffixLen);

  const oldSegments: { text: string; highlight: boolean }[] = [];
  const newSegments: { text: string; highlight: boolean }[] = [];

  if (commonPrefix) {
    oldSegments.push({ text: commonPrefix, highlight: false });
    newSegments.push({ text: commonPrefix, highlight: false });
  }
  if (oldMiddle) oldSegments.push({ text: oldMiddle, highlight: true });
  if (newMiddle) newSegments.push({ text: newMiddle, highlight: true });
  if (commonSuffix) {
    oldSegments.push({ text: commonSuffix, highlight: false });
    newSegments.push({ text: commonSuffix, highlight: false });
  }

  if (!oldMiddle && !newMiddle) {
    return {
      old: [{ text: oldStr, highlight: false }],
      new: [{ text: newStr, highlight: false }],
    };
  }

  return { old: oldSegments, new: newSegments };
}
