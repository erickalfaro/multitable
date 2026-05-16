import React, { useMemo, useState } from 'react';
import { ChevronRight, FileText } from 'lucide-react';
import { Badge } from '../../ui';
import { computeWordDiff, type DiffFile } from './parseDiff';

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

interface Props {
  file: DiffFile;
  defaultExpanded: boolean;
  /** Optional stable file index (for prefixed hunk ids in agent-scope multi-file view). */
  fileIndex?: number;
}

export function GitDiffHunks({ file, defaultExpanded, fileIndex = 0 }: Props) {
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
              data-hunk-anchor={`f${fileIndex}-h${hunkIdx}`}
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
