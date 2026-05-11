import React, { useMemo, useState } from 'react';
import { ChevronRight, FileText } from 'lucide-react';
import { Badge } from '../../ui';

// Diff parsing and rendering. Extracted from SessionDetailPanel.tsx so the
// new GitPanel can reuse it. The plan called for adding shiki line-level
// syntax highlighting here; deferred for the initial PR because shiki's
// async loading would require restructuring this synchronous renderer, and
// the existing ±-coloring + word-diff already delivers strong visual signal.

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

function computeWordDiff(
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

function DiffLineContent({
  segments,
  type,
}: {
  segments: { text: string; highlight: boolean }[];
  type: 'add' | 'del';
}) {
  return (
    <>
      {segments.map((seg, i) => (
        <span
          key={i}
          style={
            seg.highlight
              ? {
                  backgroundColor:
                    type === 'add' ? 'rgba(34, 197, 94, 0.35)' : 'rgba(239, 68, 68, 0.35)',
                  borderRadius: 'var(--radius-snug)',
                }
              : undefined
          }
        >
          {seg.text || ' '}
        </span>
      ))}
    </>
  );
}

export function DiffFileSection({
  file,
  defaultExpanded,
}: {
  file: DiffFile;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const displayPath = file.newPath === '/dev/null' ? file.oldPath : file.newPath;
  const isNew = file.oldPath === '/dev/null';
  const isDeleted = file.newPath === '/dev/null';

  const hunkWordDiffs = useMemo(() => {
    return file.hunks.map((hunk) => {
      const wordDiffMap = new Map<
        number,
        { old: { text: string; highlight: boolean }[]; new: { text: string; highlight: boolean }[] }
      >();
      const lines = hunk.lines;
      let i = 0;
      while (i < lines.length) {
        if (lines[i].type === 'del') {
          const delStart = i;
          while (i < lines.length && lines[i].type === 'del') i++;
          const addStart = i;
          while (i < lines.length && lines[i].type === 'add') i++;
          const addEnd = i;
          const delCount = addStart - delStart;
          const addCount = addEnd - addStart;
          const pairs = Math.min(delCount, addCount);
          for (let p = 0; p < pairs; p++) {
            const wd = computeWordDiff(lines[delStart + p].content, lines[addStart + p].content);
            wordDiffMap.set(delStart + p, wd);
            wordDiffMap.set(addStart + p, wd);
          }
        } else {
          i++;
        }
      }
      return wordDiffMap;
    });
  }, [file.hunks]);

  const statsBarWidth = Math.min(file.additions + file.deletions, 5);
  const addBlocks =
    file.additions + file.deletions > 0
      ? Math.round((file.additions / (file.additions + file.deletions)) * statsBarWidth)
      : 0;
  const delBlocks = statsBarWidth - addBlocks;

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 12px',
          backgroundColor: 'var(--bg-sidebar)',
          cursor: 'pointer',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          position: 'sticky',
          top: 0,
          zIndex: 1,
          borderBottom: expanded ? '1px solid var(--border)' : 'none',
        }}
      >
        <ChevronRight
          size={14}
          style={{
            color: 'var(--text-muted)',
            flexShrink: 0,
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform var(--dur-fast) var(--ease-out)',
          }}
        />
        <FileText size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <span
          style={{
            fontSize: 13,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: 'var(--text-primary)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {displayPath}
        </span>
        {isNew && (
          <Badge variant="running" size="sm">
            NEW
          </Badge>
        )}
        {isDeleted && (
          <Badge variant="error" size="sm">
            DELETED
          </Badge>
        )}
        <span
          style={{
            fontSize: 12,
            color: 'var(--status-running)',
            fontWeight: 600,
            marginLeft: 4,
          }}
        >
          +{file.additions}
        </span>
        <span style={{ fontSize: 12, color: 'var(--status-error)', fontWeight: 600 }}>
          -{file.deletions}
        </span>
        <span style={{ display: 'flex', gap: 1, marginLeft: 4 }}>
          {Array.from({ length: addBlocks }).map((_, i) => (
            <span
              key={`a${i}`}
              style={{
                width: 8,
                height: 8,
                borderRadius: 'var(--radius-snug)',
                backgroundColor: 'var(--status-running)',
                display: 'inline-block',
              }}
            />
          ))}
          {Array.from({ length: delBlocks }).map((_, i) => (
            <span
              key={`d${i}`}
              style={{
                width: 8,
                height: 8,
                borderRadius: 'var(--radius-snug)',
                backgroundColor: 'var(--status-error)',
                display: 'inline-block',
              }}
            />
          ))}
        </span>
      </div>

      {expanded && (
        <div style={{ overflow: 'auto' }}>
          {file.hunks.map((hunk, hunkIdx) => (
            <table
              key={hunkIdx}
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontFamily: 'monospace',
                fontSize: 12,
                tableLayout: 'fixed',
              }}
            >
              <colgroup>
                <col style={{ width: 50 }} />
                <col style={{ width: 50 }} />
                <col style={{ width: 16 }} />
                <col />
              </colgroup>
              <tbody>
                {hunk.lines.map((line, lineIdx) => {
                  if (line.type === 'header') {
                    return (
                      <tr key={lineIdx}>
                        <td
                          colSpan={4}
                          style={{
                            padding: '6px 12px',
                            backgroundColor: 'rgba(96, 165, 250, 0.08)',
                            color: 'var(--accent-blue)',
                            fontSize: 12,
                            fontFamily: 'monospace',
                            borderTop: hunkIdx > 0 ? '1px solid var(--border)' : 'none',
                          }}
                        >
                          {line.content}
                        </td>
                      </tr>
                    );
                  }

                  const bgColor =
                    line.type === 'add'
                      ? 'rgba(34, 197, 94, 0.1)'
                      : line.type === 'del'
                        ? 'rgba(239, 68, 68, 0.1)'
                        : 'transparent';

                  const gutterBg =
                    line.type === 'add'
                      ? 'rgba(34, 197, 94, 0.18)'
                      : line.type === 'del'
                        ? 'rgba(239, 68, 68, 0.18)'
                        : 'transparent';

                  const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
                  const prefixColor =
                    line.type === 'add'
                      ? 'var(--status-running)'
                      : line.type === 'del'
                        ? 'var(--status-error)'
                        : 'var(--text-muted)';

                  const wordDiffData = hunkWordDiffs[hunkIdx]?.get(lineIdx);
                  let contentEl: React.ReactNode;
                  if (wordDiffData && line.type === 'del') {
                    contentEl = <DiffLineContent segments={wordDiffData.old} type="del" />;
                  } else if (wordDiffData && line.type === 'add') {
                    contentEl = <DiffLineContent segments={wordDiffData.new} type="add" />;
                  } else {
                    contentEl = line.content || ' ';
                  }

                  return (
                    <tr key={lineIdx} style={{ backgroundColor: bgColor }}>
                      <td
                        style={{
                          padding: '0 8px',
                          textAlign: 'right',
                          color: 'var(--text-muted)',
                          backgroundColor: gutterBg,
                          fontSize: 11,
                          lineHeight: '20px',
                          userSelect: 'none',
                          verticalAlign: 'top',
                          borderRight: '1px solid var(--border)',
                        }}
                      >
                        {line.oldLine ?? ''}
                      </td>
                      <td
                        style={{
                          padding: '0 8px',
                          textAlign: 'right',
                          color: 'var(--text-muted)',
                          backgroundColor: gutterBg,
                          fontSize: 11,
                          lineHeight: '20px',
                          userSelect: 'none',
                          verticalAlign: 'top',
                          borderRight: '1px solid var(--border)',
                        }}
                      >
                        {line.newLine ?? ''}
                      </td>
                      <td
                        style={{
                          padding: '0 4px',
                          textAlign: 'center',
                          color: prefixColor,
                          fontWeight: 700,
                          lineHeight: '20px',
                          userSelect: 'none',
                          verticalAlign: 'top',
                        }}
                      >
                        {prefix}
                      </td>
                      <td
                        style={{
                          padding: '0 8px',
                          lineHeight: '20px',
                          whiteSpace: 'pre',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          color: 'var(--text-primary)',
                          verticalAlign: 'top',
                        }}
                      >
                        {contentEl}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ))}
        </div>
      )}
    </div>
  );
}
