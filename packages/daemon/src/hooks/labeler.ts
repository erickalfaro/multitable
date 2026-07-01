import { spawn } from 'child_process';
import os from 'os';

export interface LabelResult {
  ok: true;
  title: string;
}

export interface TagsResult {
  ok: true;
  tags: string[];
}

export interface CommitMessageResult {
  ok: true;
  message: string;
}

export interface LabelError {
  ok: false;
  error: string;
}

const SYSTEM_PROMPT = [
  'You generate short titles for coding-agent sessions.',
  'Read the user prompts and output ONE title that captures what the user is working on.',
  'Constraints: max 6 words, max 50 characters. No preamble, no quotes, no trailing punctuation, no markdown.',
  'Output the title and nothing else.',
].join(' ');

// A curated, standardized tag vocabulary offered to the model as SUGGESTIONS
// so labels stay consistent across sessions. The model is explicitly free to
// coin its own tag when none of these fit (e.g. a specific feature, file, or
// product name). Keep these short (1 word where possible) and lowercase.
const SUGGESTED_TAGS = [
  // work type
  'feature', 'bugfix', 'refactor', 'debugging', 'testing', 'docs', 'cleanup',
  'review', 'research', 'config', 'optimization', 'migration', 'setup',
  // area / layer
  'frontend', 'backend', 'ui', 'ux', 'api', 'database', 'auth', 'cli',
  'infra', 'ci/cd', 'devops', 'networking', 'styling', 'state', 'build',
  // cross-cutting
  'security', 'performance', 'git', 'deployment', 'dependencies', 'logging',
];

const TAGS_SYSTEM_PROMPT = [
  'You generate compact topic tags for coding-agent sessions.',
  'Read ONLY the user prompts and infer the main topics.',
  'Prefer tags from this standardized list when they fit:',
  SUGGESTED_TAGS.join(', ') + '.',
  'These are SUGGESTIONS, not a closed set — if none fit well, invent your own short tag (a specific feature, file, domain, or product name).',
  'Constraints: output a JSON array of 1 to 5 strings. Each tag is preferably 1 word (max 2), lowercase, and max 24 characters.',
  'No markdown, no prose, no trailing commentary — output only the JSON array.',
].join(' ');

const TIMEOUT_MS = 30_000;
// Cap how much we send to Haiku so a long-running session doesn't blow past
// argv limits or pad the prompt with stale context that drowns out the topic.
const MAX_PROMPTS = 8;
const MAX_PROMPT_CHARS = 500;

export async function generateSessionLabel(
  userMessages: string[]
): Promise<LabelResult | LabelError> {
  if (!userMessages || userMessages.length === 0) {
    return { ok: false, error: 'No prompts to summarize' };
  }

  const trimmed = userMessages
    .slice(0, MAX_PROMPTS)
    .map((m) => (m.length > MAX_PROMPT_CHARS ? m.slice(0, MAX_PROMPT_CHARS) + '…' : m));
  const prompt = `User prompts:\n- ${trimmed.join('\n- ')}\n\nTitle:`;

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    let resolved = false;
    const finish = (value: LabelResult | LabelError) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const timeout = setTimeout(() => {
      try {
        child?.kill();
      } catch {}
      finish({ ok: false, error: `claude CLI timed out after ${TIMEOUT_MS / 1000}s` });
    }, TIMEOUT_MS);

    try {
      // Spawn from os.tmpdir() so the project's CLAUDE.md isn't injected and
      // tilt the agent toward conversational responses. --system-prompt
      // replaces the default coding-agent prompt with the title-only one.
      child = spawn(
        'claude',
        [
          '--model', 'claude-haiku-4-5',
          '--system-prompt', SYSTEM_PROMPT,
          '--print', prompt,
        ],
        // stdin: 'ignore' = `< /dev/null`. Without it, `claude --print` blocks
        // ~3s waiting on stdin it'll never get ("no stdin data received in 3s")
        // and the call goes slow/flaky — the prompt is fully in argv.
        { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (err: any) {
      clearTimeout(timeout);
      finish({ ok: false, error: `Failed to spawn claude: ${err?.message || err}` });
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      const out = stdout.trim();
      if (out) {
        finish({ ok: true, title: out });
        return;
      }
      const reason = stderr.trim() || `claude exited with code ${code ?? 'null'} and no output`;
      console.error('[labeler] empty stdout:', reason);
      finish({ ok: false, error: reason });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[labeler] spawn error:', err);
      finish({ ok: false, error: err.message || 'claude CLI failed to start' });
    });
  });
}

function sanitizeTags(raw: string): string[] {
  // Haiku frequently wraps the array in a ```json code fence and/or adds
  // prose around it despite the system prompt. Strip fences first, then pull
  // out the first [...] block so we parse the actual array rather than tripping
  // JSON.parse on the surrounding noise (which used to leak "json" and bracket
  // fragments as literal tags via the line-split fallback).
  const unfenced = raw.replace(/```[a-z]*/gi, '').replace(/```/g, '').trim();
  const arrayMatch = unfenced.match(/\[[\s\S]*\]/);

  let values: unknown = null;
  try {
    values = JSON.parse(arrayMatch ? arrayMatch[0] : unfenced);
  } catch {
    values = (arrayMatch ? arrayMatch[0] : unfenced)
      .replace(/^[[\]]+|[[\]]+$/g, '')
      .split(/[\n,]/)
      .map((part) => part.replace(/^[-*\d.\s]+/, '').trim())
      .filter(Boolean);
  }

  if (!Array.isArray(values)) return [];

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const cleaned = value
      .replace(/\s+/g, ' ')
      .trim()
      // Strip wrapping brackets/quotes/backticks a fallback split can leave on.
      .replace(/^[[\]"'`]+|[[\]"'`]+$/g, '')
      .replace(/[.!?]+$/, '')
      .trim();
    if (!cleaned) continue;
    const clipped = cleaned.length > 24 ? cleaned.slice(0, 24).trimEnd() : cleaned;
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(clipped);
    if (tags.length >= 5) break;
  }
  return tags;
}

const COMMIT_MESSAGE_SYSTEM_PROMPT = [
  'You write Conventional Commit messages for staged git diffs.',
  'Read the diff and output ONE commit message, formatted as:',
  '<type>(<optional scope>): <subject>',
  '',
  '<optional body explaining the why, wrapped at ~72 chars>',
  '',
  'Rules: subject is imperative mood (e.g. "add", "fix", "refactor"), max 72 chars, no trailing period.',
  'Common types: feat, fix, refactor, docs, test, chore, perf, style, build, ci.',
  'Omit the body when the change is trivial. Output the commit message and nothing else — no preamble, no markdown fences, no quotes.',
].join(' ');

export async function generateCommitMessage(
  stagedDiff: string
): Promise<CommitMessageResult | LabelError> {
  const trimmed = stagedDiff.trim();
  if (!trimmed) {
    return { ok: false, error: 'Nothing staged to commit' };
  }

  // Cap input again at the labeler boundary as a defense — keep us well under
  // any argv ceiling on Linux/macOS regardless of what the caller passed.
  const MAX_INPUT = 28_000;
  const clipped =
    trimmed.length > MAX_INPUT ? trimmed.slice(0, MAX_INPUT) + '\n[…truncated…]' : trimmed;
  const prompt = `Staged diff:\n\n${clipped}\n\nCommit message:`;

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    let resolved = false;
    const finish = (value: CommitMessageResult | LabelError) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const timeout = setTimeout(() => {
      try {
        child?.kill();
      } catch {}
      finish({ ok: false, error: `claude CLI timed out after ${TIMEOUT_MS / 1000}s` });
    }, TIMEOUT_MS);

    try {
      child = spawn(
        'claude',
        [
          '--model', 'claude-haiku-4-5',
          '--system-prompt', COMMIT_MESSAGE_SYSTEM_PROMPT,
          '--print', prompt,
        ],
        // stdin: 'ignore' = `< /dev/null` — see generateSessionLabel.
        { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (err: any) {
      clearTimeout(timeout);
      finish({ ok: false, error: `Failed to spawn claude: ${err?.message || err}` });
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      // Strip wrapping code fences / quotes occasionally added by the model
      // despite the prompt. Keep blank lines so a multi-paragraph body
      // (subject + body) survives intact.
      const cleaned = stdout
        .trim()
        .replace(/^```[a-z]*\n?/i, '')
        .replace(/\n?```$/, '')
        .replace(/^["']+|["']+$/g, '')
        .trim();
      if (cleaned) {
        finish({ ok: true, message: cleaned });
        return;
      }
      const reason = stderr.trim() || `claude exited with code ${code ?? 'null'} and no output`;
      console.error('[commit-msg] empty stdout:', reason);
      finish({ ok: false, error: reason });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[commit-msg] spawn error:', err);
      finish({ ok: false, error: err.message || 'claude CLI failed to start' });
    });
  });
}

export async function generateSessionTags(
  userMessages: string[]
): Promise<TagsResult | LabelError> {
  if (!userMessages || userMessages.length === 0) {
    return { ok: false, error: 'No prompts to tag' };
  }

  const trimmed = userMessages
    .slice(0, MAX_PROMPTS)
    .map((m) => (m.length > MAX_PROMPT_CHARS ? m.slice(0, MAX_PROMPT_CHARS) + '…' : m));
  const prompt = `User prompts:\n- ${trimmed.join('\n- ')}\n\nTags JSON:`;

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    let resolved = false;
    const finish = (value: TagsResult | LabelError) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const timeout = setTimeout(() => {
      try {
        child?.kill();
      } catch {}
      finish({ ok: false, error: `claude CLI timed out after ${TIMEOUT_MS / 1000}s` });
    }, TIMEOUT_MS);

    try {
      child = spawn(
        'claude',
        [
          '--model', 'claude-haiku-4-5',
          '--system-prompt', TAGS_SYSTEM_PROMPT,
          '--print', prompt,
        ],
        // stdin: 'ignore' = `< /dev/null` — see generateSessionLabel.
        { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (err: any) {
      clearTimeout(timeout);
      finish({ ok: false, error: `Failed to spawn claude: ${err?.message || err}` });
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      const tags = sanitizeTags(stdout.trim());
      if (tags.length > 0) {
        finish({ ok: true, tags });
        return;
      }
      const reason = stderr.trim() || `claude exited with code ${code ?? 'null'} and no usable tags`;
      console.error('[labeler] empty tags:', reason);
      finish({ ok: false, error: reason });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[labeler] tag spawn error:', err);
      finish({ ok: false, error: err.message || 'claude CLI failed to start' });
    });
  });
}
