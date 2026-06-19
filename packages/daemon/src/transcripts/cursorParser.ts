import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Message } from './parser.js';

// Cursor persists each headless session under
//   ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl
// We parse that JSONL for restart re-hydration and the past-agents browser.
//
// Encoded-cwd collapses every run of non-alphanumeric characters in the
// absolute workspace path to a single '-' (verified:
//   C:\Users\132188\Documents → C-Users-132188-Documents).
//
// Line shapes (Anthropic-like):
//   {"role":"user","message":{"content":[{"type":"text","text":"<user_query>…</user_query>"}]}}
//   {"role":"assistant","message":{"content":[
//       {"type":"text","text":"…"},
//       {"type":"tool_use","name":"Glob","input":{…}}]}}
//   {"type":"turn_ended","status":"success"}
// There is no separate tool_result line — tool output is folded into Cursor's
// own state — so we emit tool_use messages without a matching tool_result.

const CURSOR_PROJECTS_DIR = path.join(os.homedir(), '.cursor', 'projects');

function encodeCursorCwd(p: string): string {
  return p.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function findCursorSessionFile(sessionId: string, cwd?: string): string | null {
  const rel = path.join('agent-transcripts', sessionId, `${sessionId}.jsonl`);
  if (cwd) {
    const direct = path.join(CURSOR_PROJECTS_DIR, encodeCursorCwd(cwd), rel);
    if (fs.existsSync(direct)) return direct;
  }
  // Fallback: scan every project bucket for the session id (cwd unknown or the
  // encoding didn't match).
  try {
    for (const bucket of fs.readdirSync(CURSOR_PROJECTS_DIR)) {
      const candidate = path.join(CURSOR_PROJECTS_DIR, bucket, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // ~/.cursor/projects missing — cursor never ran on this machine.
  }
  return null;
}

// Cursor wraps the real prompt in <user_query>…</user_query> and appends
// context blocks. Pull out the query text when present, else strip tags.
function cleanUserText(text: string): string {
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  let t = m ? m[1] : text;
  t = t.replace(/<\/?[a-z][a-z0-9_-]*>/gi, '');
  return t.trim();
}

type ContentBlock = { type?: string; text?: string; name?: string; input?: unknown };

function textBlocks(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

export function parseCursorSession(sessionId: string, cwd?: string): Message[] {
  const file = findCursorSessionFile(sessionId, cwd);
  if (!file) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  // No per-line timestamps in the transcript; synthesize a linearly increasing
  // ts (anchored a little before the file mtime) so ordering is stable.
  let base = Date.now() - 60_000;
  try {
    base = fs.statSync(file).mtimeMs - 60_000;
  } catch {
    /* keep fallback */
  }

  const out: Message[] = [];
  let seq = 0;
  let turn = 0;
  const nextTs = () => base + seq * 10;
  const model = 'cursor';

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: { role?: string; type?: string; message?: { content?: unknown } };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (parsed.role === 'user') {
      const text = cleanUserText(joinText(parsed.message?.content));
      if (text) {
        turn += 1;
        out.push({ id: `cursor:${sessionId}:m${seq++}:user`, ts: nextTs(), kind: 'user', text });
      }
      continue;
    }

    if (parsed.role === 'assistant') {
      const assistantParent = `cursor:${sessionId}:t${turn}:assistant`;
      for (const block of textBlocks(parsed.message?.content)) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          out.push({
            id: `cursor:${sessionId}:m${seq++}:assistant`,
            ts: nextTs(),
            kind: 'assistant',
            text: block.text,
            model,
          });
        } else if (block.type === 'tool_use') {
          const toolName = typeof block.name === 'string' && block.name ? block.name : 'tool';
          const input =
            block.input && typeof block.input === 'object'
              ? (block.input as Record<string, unknown>)
              : {};
          out.push({
            id: `cursor:${sessionId}:m${seq++}:tool_use`,
            ts: nextTs(),
            kind: 'tool_use',
            parentId: assistantParent,
            toolUseId: `cursor:${sessionId}:tool:${seq}`,
            toolName,
            input,
          });
        }
      }
      continue;
    }
    // {type:'turn_ended'} and anything else — ignored.
  }
  return out;
}

function joinText(content: unknown): string {
  return textBlocks(content)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
}
