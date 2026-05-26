import React, { useState } from 'react';
import { AttentionStream } from './AttentionStream';
import { TasksTab } from '../chat/TasksTab';

interface Props {
  sessionId: string;
}

type ActivityView = 'activity' | 'tasks';

const VIEWS: { id: ActivityView; label: string }[] = [
  { id: 'activity', label: 'Activity' },
  { id: 'tasks', label: 'Tasks' },
];

/**
 * Unified "Activity" tab. Hosts a local segment toggle between the raw tool
 * log (AttentionStream — reads/edits/commands/searches/MCP/reasoning, with its
 * own filter pills + clear) and the subagent/workflow task list (TasksTab, with
 * its live tool-progress banner). Both children are unmodified; this wrapper
 * only owns the toggle and gives each child a full-height flex container so its
 * internal scroller fills the panel body without a double scrollbar.
 */
export function ActivityTab({ sessionId }: Props) {
  const [view, setView] = useState<ActivityView>('activity');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {/* Segment toggle */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 10px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          backgroundColor: 'var(--bg-primary)',
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: 2,
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            overflow: 'hidden',
          }}
        >
          {VIEWS.map((v) => {
            const active = view === v.id;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => setView(v.id)}
                style={{
                  fontSize: 11,
                  padding: '4px 12px',
                  background: active ? 'var(--accent-blue)' : 'transparent',
                  color: active ? 'white' : 'var(--text-secondary)',
                  border: 'none',
                  cursor: 'pointer',
                  fontWeight: active ? 600 : 500,
                }}
              >
                {v.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected view — each child manages its own scroll. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {view === 'activity' ? (
          <AttentionStream sessionId={sessionId} />
        ) : (
          <div className="mt-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <TasksTab sessionId={sessionId} />
          </div>
        )}
      </div>
    </div>
  );
}
