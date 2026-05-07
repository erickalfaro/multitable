import fs from 'fs';
import path from 'path';
import os from 'os';

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export type Message =
  | { id: string; ts: number; kind: 'user'; text: string }
  | { id: string; ts: number; kind: 'assistant'; text: string; model: string; usage?: Usage }
  | {
      id: string;
      ts: number;
      kind: 'tool_use';
      parentId: string;
      toolUseId: string;
      toolName: string;
      input: any;
    }
  | {
      id: string;
      ts: number;
      kind: 'tool_result';
      toolUseId: string;
      output: string;
      isError?: boolean;
    }
  | { id: string; ts: number; kind: 'system'; text: string }
  | { id: string; ts: number; kind: 'reasoning'; text: string };

// Claude Code encodes the absolute project path by replacing every
// non-alphanumeric character with "-", including the leading slash and any
// underscores, dots, or hyphens-from-the-source. /home/user/my_project →
// -home-user-my-project (note: the underscore becomes a dash too). Per the
// Anthropic SDK sessions docs:
// https://code.claude.com/docs/en/agent-sdk/sessions
// Replacing only "/" gets close on simple paths but mismatches whenever the
// path contains "_", ".", or any other non-alphanumeric — leading us to look
// in a directory that doesn't exist and silently return empty history.
function encodePath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

export function getSessionJsonlPath(projectPath: string, claudeSessionId: string): string {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  return path.join(claudeProjectsDir, encodePath(projectPath), `${claudeSessionId}.jsonl`);
}

function getSessionDir(projectPath: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodePath(projectPath));
}

// Strip Claude's injected <system-reminder>, <ide_selection>, etc. so the
// returned text is only what the user actually typed.
function stripContextWrappers(text: string): string {
  let t = text;
  t = t.replace(/<[a-z][a-z0-9_-]*>[\s\S]*?<\/[a-z][a-z0-9_-]*>/gi, '');
  t = t.replace(/<[a-z][a-z0-9_-]*[^>]*\/>/gi, '');
  return t.trim();
}

function parseTs(v: unknown): number {
  if (typeof v !== 'string') return 0;
  const n = Date.parse(v);
  return isNaN(n) ? 0 : n;
}

function toolResultToString(output: any): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b?.type === 'text' && typeof b.text === 'string') return b.text;
        if (b?.type === 'image') return '[image]';
        return '';
      })
      .join('');
  }
  if (output && typeof output === 'object') {
    try {
      return JSON.stringify(output, null, 2);
    } catch {
      return '';
    }
  }
  return '';
}

export function parseTranscriptContent(content: string): Message[] {
  const messages: Message[] = [];
  const lines = content.split('\n');
  let fallbackCounter = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const ts = parseTs(entry.timestamp);
    const parentUuid = typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : `gen-${fallbackCounter++}`;

    if (entry.type === 'user' && entry.message) {
      const msgContent = entry.message.content;
      if (typeof msgContent === 'string') {
        const text = stripContextWrappers(msgContent);
        if (text) messages.push({ id: parentUuid, ts, kind: 'user', text });
      } else if (Array.isArray(msgContent)) {
        let blockIdx = 0;
        for (const block of msgContent) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'tool_result') {
            messages.push({
              id: `${parentUuid}-r${blockIdx++}`,
              ts,
              kind: 'tool_result',
              toolUseId: block.tool_use_id || '',
              output: toolResultToString(block.content),
              isError: !!block.is_error,
            });
          } else if (block.type === 'text' && typeof block.text === 'string') {
            const text = stripContextWrappers(block.text);
            if (text) {
              messages.push({
                id: `${parentUuid}-t${blockIdx++}`,
                ts,
                kind: 'user',
                text,
              });
            }
          }
        }
      }
    } else if (entry.type === 'assistant' && entry.message) {
      const msgContent = entry.message.content;
      const model = typeof entry.message.model === 'string' ? entry.message.model : '';
      const usage: Usage | undefined = entry.message.usage;
      let blockIdx = 0;
      let usageAttached = false;
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            if (block.text.trim()) {
              const attachUsage = !usageAttached && !!usage;
              messages.push({
                id: `${parentUuid}-t${blockIdx++}`,
                ts,
                kind: 'assistant',
                text: block.text,
                model,
                usage: attachUsage ? usage : undefined,
              });
              if (attachUsage) usageAttached = true;
            }
          } else if (block.type === 'tool_use') {
            messages.push({
              id: `${parentUuid}-u${blockIdx++}`,
              ts,
              kind: 'tool_use',
              parentId: parentUuid,
              toolUseId: typeof block.id === 'string' ? block.id : '',
              toolName: typeof block.name === 'string' ? block.name : '',
              input: block.input ?? {},
            });
          } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
            if (block.thinking.trim()) {
              messages.push({
                id: `${parentUuid}-th${blockIdx++}`,
                ts,
                kind: 'reasoning',
                text: block.thinking,
              });
            }
          }
        }
        // Assistant turn had only tool_use blocks — attach usage to a
        // zero-text assistant marker so cost shows up. Skip if nothing.
        if (!usageAttached && usage && blockIdx > 0) {
          messages.push({
            id: `${parentUuid}-u`,
            ts,
            kind: 'assistant',
            text: '',
            model,
            usage,
          });
        }
      } else if (typeof msgContent === 'string' && msgContent.trim()) {
        messages.push({ id: parentUuid, ts, kind: 'assistant', text: msgContent, model, usage });
      }
    } else if (entry.type === 'system') {
      const text = typeof entry.content === 'string' ? entry.content.trim() : '';
      if (text) messages.push({ id: parentUuid, ts, kind: 'system', text });
    }
  }
  return messages;
}

export interface ParseResult {
  messages: Message[];
  endOffset: number;
}

// Read a JSONL file from the given byte offset to EOF, parse complete lines
// only, and return both the messages and the new end offset (on a line
// boundary). Callers should pass the returned endOffset back on the next call
// to get only newly-appended entries.
export function parseTranscript(jsonlPath: string, fromOffset = 0): ParseResult {
  let fd: number;
  try {
    fd = fs.openSync(jsonlPath, 'r');
  } catch {
    return { messages: [], endOffset: 0 };
  }
  try {
    const stat = fs.fstatSync(fd);
    const start = Math.max(0, Math.min(fromOffset, stat.size));
    if (start >= stat.size) return { messages: [], endOffset: stat.size };
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    const content = buf.toString('utf8');
    const lastNewline = content.lastIndexOf('\n');
    if (lastNewline < 0) {
      // No complete line in this window yet — don't advance.
      return { messages: [], endOffset: start };
    }
    const completeContent = content.slice(0, lastNewline + 1);
    const endOffset = start + Buffer.byteLength(completeContent, 'utf8');
    return { messages: parseTranscriptContent(completeContent), endOffset };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

// Read every JSONL in the given chain (oldest → newest claudeSessionId), merge
// raw entries deduped by `entry.uuid`, sort chronologically, and parse the
// joined stream. The dedupe is critical: when the SDK forks on resume, it
// sometimes replicates ancestor history into the new file. Without dedupe,
// every replicated entry would render twice. `endOffset` is the byte size of
// the LAST file only — preserves the per-file offset contract for any caller
// that still tails the current JSONL by offset.
export function parseTranscriptChain(
  projectPath: string,
  claudeSessionIds: string[]
): ParseResult {
  if (claudeSessionIds.length === 0) return { messages: [], endOffset: 0 };

  const seenUuids = new Set<string>();
  type Entry = { ts: number; uuid: string | null; line: string };
  const entries: Entry[] = [];
  let endOffset = 0;

  for (let i = 0; i < claudeSessionIds.length; i++) {
    const sid = claudeSessionIds[i];
    const isLast = i === claudeSessionIds.length - 1;
    const jsonlPath = getSessionJsonlPath(projectPath, sid);
    let content: string;
    try {
      content = fs.readFileSync(jsonlPath, 'utf8');
    } catch {
      continue;
    }
    if (isLast) {
      endOffset = Buffer.byteLength(content, 'utf8');
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const uuid = typeof parsed.uuid === 'string' ? parsed.uuid : null;
      if (uuid) {
        if (seenUuids.has(uuid)) continue;
        seenUuids.add(uuid);
      }
      const ts =
        typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) || 0 : 0;
      entries.push({ ts, uuid, line: trimmed });
    }
  }

  // Stable sort by timestamp; entries without a timestamp keep insertion order
  // relative to themselves (sorted to 0, but Array.prototype.sort is stable in
  // modern V8 so JSONL-write-order is preserved within the same ts).
  entries.sort((a, b) => a.ts - b.ts);

  const joined = entries.map((e) => e.line).join('\n') + '\n';
  return { messages: parseTranscriptContent(joined), endOffset };
}

// Legacy backfill: when a session's claudeSessionIdHistory is empty (the row
// predates chain tracking), we may still be able to discover the ancestor
// chain by walking parentUuid links across JSONL files in the same encoded-cwd
// directory. The first user/assistant entry of a forked session has a
// parentUuid that points into the ancestor's JSONL; we scan sibling files for
// a match, then recurse on that ancestor's filename stem.
//
// Returns the ancestor session ids in chronological order (oldest first), NOT
// including the starting id. Capped at depth 10 to bound runtime on projects
// with hundreds of JSONLs.
export function walkParentUuidChain(
  projectPath: string,
  claudeSessionId: string
): string[] {
  const dir = getSessionDir(projectPath);
  const ancestors: string[] = [];
  const visited = new Set<string>([claudeSessionId]);
  let currentSid = claudeSessionId;

  for (let depth = 0; depth < 10; depth++) {
    const currentPath = path.join(dir, `${currentSid}.jsonl`);
    let content: string;
    try {
      content = fs.readFileSync(currentPath, 'utf8');
    } catch {
      break;
    }

    let firstParent: string | null = null;
    const localUuids = new Set<string>();
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof parsed.uuid === 'string') localUuids.add(parsed.uuid);
      if (firstParent === null && (parsed.type === 'user' || parsed.type === 'assistant')) {
        firstParent =
          typeof parsed.parentUuid === 'string' && parsed.parentUuid
            ? parsed.parentUuid
            : null;
      }
    }

    if (!firstParent || localUuids.has(firstParent)) break;

    let siblings: string[];
    try {
      siblings = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      break;
    }

    const needle = `"uuid":"${firstParent}"`;
    let foundSid: string | null = null;
    for (const filename of siblings) {
      const sid = filename.slice(0, -'.jsonl'.length);
      if (visited.has(sid)) continue;
      try {
        const siblingContent = fs.readFileSync(path.join(dir, filename), 'utf8');
        if (siblingContent.includes(needle)) {
          foundSid = sid;
          break;
        }
      } catch {}
    }

    if (!foundSid) break;
    ancestors.unshift(foundSid);
    visited.add(foundSid);
    currentSid = foundSid;
  }

  return ancestors;
}
