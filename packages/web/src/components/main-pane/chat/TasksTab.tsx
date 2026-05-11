import React, { useEffect, useState } from 'react';
import { useAppStore } from '../../../stores/appStore';
import type { TaskEntry, ToolProgress } from '../../../stores/appStore';
import { CheckCircle2, AlertCircle, Loader2, CircleSlash, Clock } from 'lucide-react';

interface Props {
  sessionId: string;
}

function StateBadge({ state }: { state: TaskEntry['state'] }) {
  const styles: Record<string, { bg: string; fg: string; icon: React.ReactNode }> = {
    running: {
      bg: 'color-mix(in srgb, var(--accent-blue) 14%, transparent)',
      fg: 'var(--accent-blue)',
      icon: <Loader2 size={11} className="mt-spin" />,
    },
    completed: {
      bg: 'color-mix(in srgb, var(--status-running) 14%, transparent)',
      fg: 'var(--status-running)',
      icon: <CheckCircle2 size={11} />,
    },
    failed: {
      bg: 'color-mix(in srgb, var(--status-error) 14%, transparent)',
      fg: 'var(--status-error)',
      icon: <AlertCircle size={11} />,
    },
    killed: {
      bg: 'color-mix(in srgb, var(--status-error) 14%, transparent)',
      fg: 'var(--status-error)',
      icon: <CircleSlash size={11} />,
    },
    stopped: {
      bg: 'var(--bg-elevated)',
      fg: 'var(--text-secondary)',
      icon: <CircleSlash size={11} />,
    },
    pending: {
      bg: 'var(--bg-elevated)',
      fg: 'var(--text-secondary)',
      icon: <Clock size={11} />,
    },
    unknown: {
      bg: 'var(--bg-elevated)',
      fg: 'var(--text-muted)',
      icon: <Clock size={11} />,
    },
  };
  const s = styles[state] ?? styles.unknown;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 'var(--radius-snug)',
        background: s.bg,
        color: s.fg,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'capitalize',
      }}
    >
      {s.icon}
      {state}
    </span>
  );
}

function ToolProgressBanner({ p }: { p: ToolProgress }) {
  // Re-render every second while a tool is running so the elapsed counter
  // ticks visibly even if no SDK update arrives.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  const liveSeconds = Math.max(p.elapsedSeconds, (Date.now() - p.receivedAt) / 1000 + p.elapsedSeconds);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        background: 'color-mix(in srgb, var(--accent-blue) 8%, transparent)',
        border: '1px solid color-mix(in srgb, var(--accent-blue) 30%, transparent)',
        borderRadius: 'var(--radius-md)',
        marginBottom: 12,
        fontSize: 12.5,
        color: 'var(--text-primary)',
      }}
    >
      <Loader2 size={13} className="mt-spin" color="var(--accent-blue)" />
      <span style={{ fontWeight: 600 }}>{p.toolName}</span>
      <span style={{ color: 'var(--text-secondary)' }}>running for {Math.round(liveSeconds)}s</span>
    </div>
  );
}

function durationLabel(ms: number | undefined): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function TasksTab({ sessionId }: Props) {
  const tasks = useAppStore((s) => s.tasksBySession[sessionId] ?? []);
  const toolProgress = useAppStore((s) => s.toolProgressBySession[sessionId] ?? null);
  const status = useAppStore((s) => s.statusBySession[sessionId] ?? { status: null });

  const visible = tasks.filter((t) => !t.skipTranscript);

  return (
    <div style={{ padding: '14px 16px' }}>
      {status.status && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            marginBottom: 12,
            fontSize: 12.5,
            color: 'var(--text-secondary)',
          }}
        >
          <Loader2 size={13} className="mt-spin" />
          {status.status === 'compacting' ? 'Compacting context…' : 'Requesting…'}
        </div>
      )}

      {toolProgress && <ToolProgressBanner p={toolProgress} />}

      {visible.length === 0 ? (
        <div
          style={{
            padding: '32px 16px',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: 12.5,
          }}
        >
          No active tasks. Subagents and workflow tasks will appear here.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {visible.map((task) => (
            <div
              key={task.taskId}
              style={{
                padding: '10px 12px',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {task.description || task.taskType || 'Task'}
                </span>
                <StateBadge state={task.state} />
              </div>
              {(task.taskType || task.workflowName) && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  {task.workflowName ? `workflow · ${task.workflowName}` : `type · ${task.taskType}`}
                </div>
              )}
              {(task.totalTokens || task.toolUses || task.durationMs || task.lastToolName) && (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    marginTop: 6,
                    fontSize: 11,
                    color: 'var(--text-secondary)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {task.lastToolName && <span>tool: {task.lastToolName}</span>}
                  {task.toolUses !== undefined && <span>uses: {task.toolUses}</span>}
                  {task.totalTokens !== undefined && <span>tokens: {task.totalTokens.toLocaleString()}</span>}
                  {task.durationMs !== undefined && <span>{durationLabel(task.durationMs)}</span>}
                </div>
              )}
              {task.summary && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.45 }}>
                  {task.summary}
                </div>
              )}
              {task.outputFile && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' }}>
                  {task.outputFile}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
