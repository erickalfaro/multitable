import fs from 'fs';
import path from 'path';
import os from 'os';

export interface ParsedPrompt {
  text: string;
  timestamp: number | null;
}

interface JsonlEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  [key: string]: unknown;
}

function encodePath(projectPath: string): string {
  // Claude Code encodes the absolute path by replacing every non-alphanumeric
  // character with "-", INCLUDING the leading slash, underscores, dots, and
  // existing hyphens. /home/user/my_project → -home-user-my-project. Per
  // the SDK sessions docs:
  // https://code.claude.com/docs/en/agent-sdk/sessions
  // Replacing only "/" misses paths with underscores or dots and lands on a
  // directory that doesn't exist.
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function getSessionJsonlPath(projectPath: string, claudeSessionId: string): string {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  const encodedPath = encodePath(projectPath);
  return path.join(claudeProjectsDir, encodedPath, `${claudeSessionId}.jsonl`);
}

// Extract user-typed text from an entry's content. Filters out tool_result
// entries (role === 'user' but content is a tool response, not a prompt).
// Returns null if the entry isn't a real user prompt.
function extractUserText(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(content)) return null;

  const textParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const type = (part as any).type;
    // tool_result blocks are system-generated, not user prompts
    if (type === 'tool_result') return null;
    if (type === 'text' && typeof (part as any).text === 'string') {
      textParts.push((part as any).text);
    }
  }
  const joined = textParts.join('').trim();
  return joined.length > 0 ? joined : null;
}

function extractPromptsFromJsonl(
  content: string,
  sessionCwd: string | null
): ParsedPrompt[] {
  const prompts: ParsedPrompt[] = [];
  const lines = content.split('\n').filter(Boolean);

  for (const line of lines) {
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const isUser =
      entry.type === 'user' ||
      (entry.message && entry.message.role === 'user');
    if (!isUser) continue;

    // When scanning multiple JSONLs, only include entries whose cwd
    // matches the session's working directory — avoids mixing in
    // prompts from unrelated Claude sessions that happened to live in
    // the same encoded project directory.
    if (sessionCwd) {
      const entryCwd = typeof (entry as any).cwd === 'string' ? (entry as any).cwd : null;
      if (entryCwd && entryCwd !== sessionCwd) continue;
    }

    const msg = entry.message || entry;
    const text = extractUserText((msg as any).content);
    if (!text) continue;

    const ts = typeof entry.timestamp === 'string'
      ? Date.parse(entry.timestamp) || null
      : null;

    prompts.push({ text, timestamp: ts });
  }

  return prompts;
}

export function parseSessionPrompts(
  projectPath: string,
  claudeSessionId: string
): ParsedPrompt[] {
  const jsonlPath = getSessionJsonlPath(projectPath, claudeSessionId);

  try {
    const content = fs.readFileSync(jsonlPath, 'utf8');
    return extractPromptsFromJsonl(content, null);
  } catch {
    return [];
  }
}

/**
 * Scan every JSONL in the project's encoded Claude projects directory,
 * extract user prompts from entries whose `cwd` matches the session's
 * working directory, deduplicate by (text, timestamp), and sort by
 * timestamp ascending. Used as a fallback when a session's own JSONL
 * is empty or missing — catches prompts from ancestor / resumed sessions.
 */
export function parseAllProjectPrompts(projectPath: string): ParsedPrompt[] {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  const encodedPath = encodePath(projectPath);
  const dir = path.join(claudeProjectsDir, encodedPath);

  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const aggregated: ParsedPrompt[] = [];
  for (const filename of entries) {
    const full = path.join(dir, filename);
    try {
      const content = fs.readFileSync(full, 'utf8');
      const prompts = extractPromptsFromJsonl(content, projectPath);
      aggregated.push(...prompts);
    } catch {}
  }

  // Dedupe by (text, timestamp) — resumed sessions sometimes replay the
  // ancestor's history into the new file.
  const seen = new Set<string>();
  const deduped: ParsedPrompt[] = [];
  for (const p of aggregated) {
    const key = `${p.timestamp ?? 'null'}|${p.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  deduped.sort((a, b) => {
    if (a.timestamp == null && b.timestamp == null) return 0;
    if (a.timestamp == null) return 1;
    if (b.timestamp == null) return -1;
    return a.timestamp - b.timestamp;
  });

  return deduped;
}
