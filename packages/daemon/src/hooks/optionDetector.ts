import fs from 'fs';
import path from 'path';
import os from 'os';

interface AssistantMessage {
  type: string;
  role?: string;
  content?: any;
}

interface JsonlEntry {
  type: string;
  message?: AssistantMessage;
  [key: string]: any;
}

const QUESTION_SIGNALS = [
  /\?$/m,
  /which\s+(one|option|approach|do you)/i,
  /what\s+(would|do|should)/i,
  /how\s+would\s+you/i,
  /please\s+(choose|select|pick)/i,
  /let\s+me\s+know/i,
  /\bor\b.*\bor\b/i,
];

const NUMBERED_LIST_RE = /^\s*(\d+)[.)]\s+(.+)$/;

function encodePath(projectPath: string): string {
  // Claude Code replaces every non-alphanumeric character with "-" including
  // the leading slash, underscores, and dots. /home/user/my_project ->
  // -home-user-my-project. See SDK sessions docs:
  // https://code.claude.com/docs/en/agent-sdk/sessions
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function getSessionJsonlPath(projectPath: string, claudeSessionId: string): string {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  const encodedPath = encodePath(projectPath);
  return path.join(claudeProjectsDir, encodedPath, `${claudeSessionId}.jsonl`);
}

function extractTextFromContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (typeof c === 'string') return c;
        if (c && c.type === 'text' && typeof c.text === 'string') return c.text;
        return '';
      })
      .join('');
  }
  return '';
}

function parseNumberedOptions(text: string): string[] | null {
  const lines = text.split('\n');
  const options: Array<{ num: number; text: string }> = [];

  for (const line of lines) {
    const m = line.match(NUMBERED_LIST_RE);
    if (m) {
      const num = parseInt(m[1], 10);
      const optText = m[2].trim();
      if (optText.length <= 150) {
        options.push({ num, text: optText });
      }
    }
  }

  if (options.length < 2 || options.length > 8) return null;

  // Verify it's a sequential numbered list starting at 1
  const sorted = options.sort((a, b) => a.num - b.num);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].num !== i + 1) return null;
  }

  return sorted.map((o) => o.text);
}

function hasQuestionSignal(text: string): boolean {
  return QUESTION_SIGNALS.some((re) => re.test(text));
}

const QUESTION_MAX_LEN = 200;

// The prompt text shown above the option buttons: everything before the first
// numbered-list item, collapsed to a single line and capped. Falls back to a
// generic prompt when the list has no lead-in (e.g. the message is bare items).
function extractQuestion(text: string): string {
  const lines = text.split('\n');
  const lead: string[] = [];
  for (const line of lines) {
    if (NUMBERED_LIST_RE.test(line)) break;
    lead.push(line);
  }
  const question = lead.join(' ').replace(/\s+/g, ' ').trim();
  if (!question) return 'Choose an option:';
  return question.length <= QUESTION_MAX_LEN
    ? question
    : question.slice(0, QUESTION_MAX_LEN - 1) + '…';
}

export interface DetectedOptions {
  options: string[];
  question: string;
  rawText: string;
}

export async function detectOptions(
  projectPath: string,
  claudeSessionId: string
): Promise<DetectedOptions | null> {
  const jsonlPath = getSessionJsonlPath(projectPath, claudeSessionId);

  let content: string;
  try {
    content = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return null;
  }

  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  // Find last assistant message
  let lastAssistantText: string | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (
      entry.type === 'assistant' ||
      (entry.message && entry.message.role === 'assistant')
    ) {
      const msg = entry.message || entry;
      const text = extractTextFromContent(msg.content);
      if (text) {
        lastAssistantText = text;
        break;
      }
    }
  }

  if (!lastAssistantText) return null;

  const options = parseNumberedOptions(lastAssistantText);
  if (!options) return null;

  if (!hasQuestionSignal(lastAssistantText)) return null;

  return { options, question: extractQuestion(lastAssistantText), rawText: lastAssistantText };
}
