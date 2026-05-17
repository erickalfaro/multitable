import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Message } from './parser.js';

// Hermes persists each ACP session as a single JSON file at
// `~/.hermes/sessions/session_<sessionId>.json`. The shape is OpenAI-style
// chat completions: a flat `messages: ChatMessage[]` array with roles
// `user` / `assistant` / `tool`.
//
// We map that onto MultiTable's `Message[]` discriminated union so the UI
// renders Hermes scrollback identically to Claude and Codex.

const HERMES_SESSIONS_DIR = path.join(os.homedir(), '.hermes', 'sessions');

interface HermesToolCall {
  id?: string;
  call_id?: string;
  function?: { name?: string; arguments?: string };
}

interface HermesMessage {
  role: 'user' | 'assistant' | 'tool' | string;
  content?: string | unknown;
  reasoning_content?: string;
  tool_calls?: HermesToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface HermesSessionFile {
  session_id?: string;
  model?: string;
  session_start?: string;
  last_updated?: string;
  messages?: HermesMessage[];
}

export function findHermesSessionFile(sessionId: string): string | null {
  const direct = path.join(HERMES_SESSIONS_DIR, `session_${sessionId}.json`);
  if (fs.existsSync(direct)) return direct;
  // Some sessions are filed under a timestamped prefix (`session_<ts>_<id>.json`)
  // when Hermes wasn't given an explicit sessionId. Scan as a fallback.
  try {
    const files = fs.readdirSync(HERMES_SESSIONS_DIR);
    for (const f of files) {
      if (f.startsWith('session_') && f.endsWith('.json') && f.includes(sessionId)) {
        return path.join(HERMES_SESSIONS_DIR, f);
      }
    }
  } catch {
    // dir missing — Hermes never ran on this machine
  }
  return null;
}

function parseTs(v: unknown): number {
  if (typeof v !== 'string') return 0;
  const n = Date.parse(v);
  return Number.isNaN(n) ? 0 : n;
}

function contentToString(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    // Hermes occasionally emits content as a structured array (text + image).
    // Flatten to text-only; image blocks are rendered as a placeholder so
    // the message doesn't collapse to empty.
    return c
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const obj = b as { type?: string; text?: string };
          if (obj.type === 'text' && typeof obj.text === 'string') return obj.text;
          if (obj.type === 'image') return '[image]';
        }
        return '';
      })
      .join('');
  }
  return '';
}

export function parseHermesSession(sessionId: string): Message[] {
  const file = findHermesSessionFile(sessionId);
  if (!file) return [];
  let parsed: HermesSessionFile;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as HermesSessionFile;
  } catch (err) {
    console.warn(`[hermesParser] failed to parse ${file}:`, err);
    return [];
  }
  const raw = Array.isArray(parsed.messages) ? parsed.messages : [];
  const model = parsed.model ?? 'hermes';

  // Hermes doesn't stamp individual messages with timestamps — only the file
  // has session_start / last_updated. Interpolate linearly so messages sort
  // correctly and relative-time labels are roughly right.
  const start = parseTs(parsed.session_start) || Date.now();
  const end = parseTs(parsed.last_updated) || start;
  const span = Math.max(end - start, raw.length); // at least 1ms per slot
  const tsAt = (i: number): number =>
    raw.length <= 1 ? start : start + Math.floor((i * span) / Math.max(raw.length - 1, 1));

  const out: Message[] = [];
  let seq = 0;
  const nextId = (kind: string) => `hermes:${parsed.session_id ?? sessionId}:m${seq++}:${kind}`;

  for (let i = 0; i < raw.length; i++) {
    const m = raw[i];
    const ts = tsAt(i);

    if (m.role === 'user') {
      const text = contentToString(m.content);
      // Skip empty user messages (Hermes occasionally emits a blank slot for
      // synthetic turn boundaries) and the system-injected `/reasoning <level>`
      // prefix we prepended ourselves (it's mechanical, not user-authored).
      const stripped = text.replace(/^\/reasoning\s+\S+\s*/i, '').trim();
      if (!stripped) continue;
      out.push({ id: nextId('user'), ts, kind: 'user', text: stripped });
      continue;
    }

    if (m.role === 'assistant') {
      // Reasoning first, then text, then tool_use blocks — matches the
      // streaming order the UI saw live, so scrollback feels continuous.
      const reasoning = typeof m.reasoning_content === 'string' ? m.reasoning_content.trim() : '';
      if (reasoning) {
        out.push({ id: nextId('reasoning'), ts, kind: 'reasoning', text: reasoning });
      }
      const text = contentToString(m.content).trim();
      const parentId = text
        ? `hermes:${parsed.session_id ?? sessionId}:m${seq}:assistant`
        : nextId('assistant_parent');
      if (text) {
        out.push({ id: nextId('assistant'), ts, kind: 'assistant', text, model });
      }
      const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const tc of toolCalls) {
        const toolUseId = tc.call_id ?? tc.id ?? '';
        if (!toolUseId) continue;
        let input: unknown = {};
        if (tc.function?.arguments) {
          try {
            input = JSON.parse(tc.function.arguments);
          } catch {
            input = { raw: tc.function.arguments };
          }
        }
        out.push({
          id: nextId('tool_use'),
          ts,
          kind: 'tool_use',
          parentId,
          toolUseId,
          toolName: tc.function?.name ?? 'tool',
          input,
        });
      }
      continue;
    }

    if (m.role === 'tool') {
      const toolUseId = m.tool_call_id ?? '';
      if (!toolUseId) continue;
      const output = contentToString(m.content);
      out.push({
        id: nextId('tool_result'),
        ts,
        kind: 'tool_result',
        toolUseId,
        output,
      });
      continue;
    }

    // Unknown role (e.g. 'system') — skip; system prompts aren't shown.
  }

  return out;
}
