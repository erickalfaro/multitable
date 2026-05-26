import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Message } from './parser.js';

// Grok Build persists each session under
//   ~/.grok/sessions/<url-encoded-cwd>/<sessionId>/
// with several files. We parse `updates.jsonl` — a verbatim replay log of the
// ACP `session/update` notification stream (the same shape the live adapter's
// handleNotification consumes). This makes hydrated scrollback identical to what
// the user saw live, and it naturally excludes the synthetic context-wrapper
// messages that live in `chat_history.jsonl`.
//
// Each line: { timestamp, method: 'session/update', params: { sessionId,
//   update: { sessionUpdate, content?, toolCallId?, status?, ... } } }.

const GROK_SESSIONS_DIR = path.join(os.homedir(), '.grok', 'sessions');

interface UpdateLine {
  timestamp?: number;
  method?: string;
  params?: {
    sessionId?: string;
    update?: Record<string, unknown>;
  };
}

// Locate the session directory. The on-disk layout keys sessions by
// url-encoded cwd then sessionId, so we prefer a direct lookup when the cwd is
// known and fall back to scanning every cwd bucket for the session id.
export function findGrokSessionDir(sessionId: string, cwd?: string): string | null {
  if (cwd) {
    const direct = path.join(GROK_SESSIONS_DIR, encodeURIComponent(cwd), sessionId);
    if (fs.existsSync(direct)) return direct;
  }
  try {
    for (const bucket of fs.readdirSync(GROK_SESSIONS_DIR)) {
      const candidate = path.join(GROK_SESSIONS_DIR, bucket, sessionId);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // dir missing — grok never ran on this machine
  }
  return null;
}

function extractText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as Record<string, unknown>;
  if (typeof c.text === 'string') return c.text;
  return '';
}

function renderToolOutput(update: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = update.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const inner = (item as Record<string, unknown>).content;
      const text = extractText(inner);
      if (text) parts.push(text);
    }
  }
  if (parts.length === 0 && update.rawOutput != null) {
    try {
      parts.push(
        typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput),
      );
    } catch {
      parts.push(String(update.rawOutput));
    }
  }
  return parts.join('\n');
}

export function parseGrokSession(sessionId: string, cwd?: string): Message[] {
  const dir = findGrokSessionDir(sessionId, cwd);
  if (!dir) return [];
  const file = path.join(dir, 'updates.jsonl');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const out: Message[] = [];
  let seq = 0;
  let turn = 0;
  // Coalesce consecutive same-kind text chunks into one message. Held inside a
  // mutable object so TS doesn't mis-narrow the closure-captured value to null.
  type PendingMsg = { kind: 'user' | 'assistant' | 'reasoning'; text: string; ts: number };
  const buf: { msg: PendingMsg | null } = { msg: null };
  // The current turn's assistant message id, used as tool_use parentId so tools
  // nest under their turn.
  let assistantParent = `grok:${sessionId}:t0:assistant`;
  const model = 'grok-build';

  const flush = () => {
    const p = buf.msg;
    if (!p || !p.text.trim()) {
      buf.msg = null;
      return;
    }
    const id = `grok:${sessionId}:m${seq++}:${p.kind}`;
    if (p.kind === 'assistant') {
      out.push({ id, ts: p.ts, kind: 'assistant', text: p.text, model });
    } else if (p.kind === 'reasoning') {
      out.push({ id, ts: p.ts, kind: 'reasoning', text: p.text });
    } else {
      out.push({ id, ts: p.ts, kind: 'user', text: p.text });
    }
    buf.msg = null;
  };

  const accumulate = (kind: 'user' | 'assistant' | 'reasoning', text: string, ts: number) => {
    if (buf.msg && buf.msg.kind !== kind) flush();
    if (!buf.msg) buf.msg = { kind, text: '', ts };
    buf.msg.text += text;
  };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: UpdateLine;
    try {
      parsed = JSON.parse(trimmed) as UpdateLine;
    } catch {
      continue;
    }
    if (parsed.method !== 'session/update') continue;
    const update = parsed.params?.update;
    if (!update || typeof update !== 'object') continue;
    const ts = typeof parsed.timestamp === 'number' ? parsed.timestamp * 1000 : Date.now();
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';

    switch (kind) {
      case 'user_message_chunk': {
        // A new user turn begins — flush the previous turn and bump the parent.
        if (buf.msg && buf.msg.kind !== 'user') flush();
        if (!buf.msg) {
          turn += 1;
          assistantParent = `grok:${sessionId}:t${turn}:assistant`;
        }
        accumulate('user', extractText(update.content), ts);
        break;
      }
      case 'agent_thought_chunk':
        accumulate('reasoning', extractText(update.content), ts);
        break;
      case 'agent_message_chunk':
        accumulate('assistant', extractText(update.content), ts);
        break;
      case 'tool_call': {
        flush();
        const toolUseId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
        if (!toolUseId) break;
        const toolName =
          (typeof update.title === 'string' && update.title) ||
          (typeof update.kind === 'string' && update.kind) ||
          'tool';
        const input =
          update.rawInput && typeof update.rawInput === 'object'
            ? (update.rawInput as Record<string, unknown>)
            : {};
        out.push({
          id: `grok:${sessionId}:m${seq++}:tool_use`,
          ts,
          kind: 'tool_use',
          parentId: assistantParent,
          toolUseId,
          toolName,
          input,
        });
        break;
      }
      case 'tool_call_update': {
        const toolUseId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
        const status = typeof update.status === 'string' ? update.status : '';
        if (!toolUseId || (status !== 'completed' && status !== 'failed')) break;
        out.push({
          id: `grok:${sessionId}:m${seq++}:tool_result`,
          ts,
          kind: 'tool_result',
          toolUseId,
          output: renderToolOutput(update),
          isError: status === 'failed',
        });
        break;
      }
      default:
        // available_commands_update / plan / usage_update / etc. — not shown in
        // hydrated scrollback.
        break;
    }
  }
  flush();
  return out;
}
