import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Message } from './parser.js';

// GitHub Copilot persists each session under
//   ~/.copilot/session-state/<sessionId>/
// with `events.jsonl` — the full session event log (the same event shapes the
// live adapter consumes over the SDK) — plus workspace.yaml metadata and
// checkpoints/*.md, which are COMPACTION SUMMARIES, not the transcript. We
// parse events.jsonl so hydrated scrollback matches what the user saw live.
//
// Each line: { type, data, id, timestamp, parentId } with types like
// session.start, user.message, assistant.message (content + toolRequests),
// tool.execution_complete. Ephemeral events (deltas, session.idle) are not
// persisted. Verified against copilot CLI 1.0.63–1.0.68 logs.

const COPILOT_STATE_DIR = path.join(os.homedir(), '.copilot', 'session-state');

interface EventLine {
  type?: string;
  timestamp?: string;
  agentId?: string;
  data?: Record<string, unknown>;
}

function renderToolResult(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const r = result as Record<string, unknown>;
  if (typeof r.content === 'string') return r.content;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export function parseCopilotSession(sessionId: string): Message[] {
  const file = path.join(COPILOT_STATE_DIR, sessionId, 'events.jsonl');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const out: Message[] = [];
  let seq = 0;
  let sessionModel: string | undefined;
  let assistantParent = `copilot:${sessionId}:t0:assistant`;
  // The runtime repeats the same reasoningText across a turn's
  // assistant.message events — dedup or every tool round duplicates the card.
  let lastReasoning = '';

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: EventLine;
    try {
      parsed = JSON.parse(trimmed) as EventLine;
    } catch {
      continue;
    }
    // Sub-agent internals stay out of the main transcript.
    if (parsed.agentId) continue;
    const d = parsed.data ?? {};
    const ts =
      typeof parsed.timestamp === 'string' && !Number.isNaN(Date.parse(parsed.timestamp))
        ? Date.parse(parsed.timestamp)
        : Date.now();

    switch (parsed.type) {
      case 'session.start': {
        if (typeof d.selectedModel === 'string') sessionModel = d.selectedModel;
        break;
      }
      case 'user.message': {
        if (typeof d.content !== 'string' || !d.content.trim()) break;
        out.push({ id: `copilot:${sessionId}:m${seq++}:user`, ts, kind: 'user', text: d.content });
        break;
      }
      case 'assistant.message': {
        const reasoning = typeof d.reasoningText === 'string' ? d.reasoningText : '';
        if (reasoning.trim() && reasoning !== lastReasoning) {
          lastReasoning = reasoning;
          out.push({
            id: `copilot:${sessionId}:m${seq++}:reasoning`,
            ts,
            kind: 'reasoning',
            text: reasoning,
          });
        }
        const assistantId = `copilot:${sessionId}:m${seq++}:assistant`;
        if (typeof d.content === 'string' && d.content.trim()) {
          out.push({
            id: assistantId,
            ts,
            kind: 'assistant',
            text: d.content,
            model: (typeof d.model === 'string' && d.model) || sessionModel || 'copilot',
          });
          assistantParent = assistantId;
        }
        const toolRequests = Array.isArray(d.toolRequests) ? d.toolRequests : [];
        for (const tr of toolRequests as Array<Record<string, unknown>>) {
          if (!tr || typeof tr.toolCallId !== 'string') continue;
          out.push({
            id: `copilot:${sessionId}:m${seq++}:tool_use`,
            ts,
            kind: 'tool_use',
            parentId: assistantParent,
            toolUseId: tr.toolCallId,
            toolName: typeof tr.name === 'string' ? tr.name : 'tool',
            input:
              tr.arguments && typeof tr.arguments === 'object'
                ? (tr.arguments as Record<string, unknown>)
                : {},
          });
        }
        break;
      }
      case 'tool.execution_complete': {
        if (typeof d.toolCallId !== 'string') break;
        out.push({
          id: `copilot:${sessionId}:m${seq++}:tool_result`,
          ts,
          kind: 'tool_result',
          toolUseId: d.toolCallId,
          output: renderToolResult(d.result),
          isError: d.success === false,
        });
        break;
      }
      default:
        // turn/hook/compaction/system/usage events — not shown in scrollback.
        break;
    }
  }
  return out;
}
