import { spawn } from 'child_process';
import os from 'os';

export interface LabelAndTagsResult {
  ok: true;
  title: string;
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

// Title + tags in ONE call. rename-ai used to fire two concurrent claude.exe
// processes (a title call and a tags call); each pays a ~2.5s cold-start plus a
// variable API round-trip that occasionally balloons on retries through the
// corporate TLS proxy. Asking Haiku for both in a single JSON object halves the
// process spawns and the round-trips — the biggest practical latency win here.
const LABEL_SYSTEM_PROMPT = [
  'You label coding-agent sessions from the user prompts.',
  'Output ONLY a JSON object with exactly two keys: "title" and "tags".',
  '"title": one short title capturing what the user is working on —',
  'max 6 words, max 50 characters, no quotes, no trailing punctuation.',
  '"tags": a JSON array of 1 to 5 topic tags. Prefer these when they fit:',
  SUGGESTED_TAGS.join(', ') + '.',
  'These are SUGGESTIONS, not a closed set — invent a short tag (a specific',
  'feature, file, domain, or product name) when none fit.',
  'Each tag is preferably 1 word (max 2), lowercase, and max 24 characters.',
  'No markdown, no code fences, no prose — output only the JSON object.',
].join(' ');

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

// With FAST_FLAGS + FAST_ENV a solo call settles at ~5s, but the corporate TLS
// proxy occasionally forces the CLI to retry a dropped request, pushing a single
// call to 20-30s. 60s is deliberate headroom over that tail — a slow rename
// beats a failed one.
const TIMEOUT_MS = 60_000;

// These are one-shot text-generation calls — they never need the agent harness.
// `--setting-sources ''` skips user/project settings (hooks, permissions),
// `--strict-mcp-config` (with no --mcp-config) boots zero MCP servers, and
// `--disallowed-tools '*'` drops tool definitions. On a TLS-inspected corporate
// network this cut a cold `claude --print` from ~22s to ~8s; the rest is the
// Haiku round-trip itself.
const FAST_FLAGS = ['--setting-sources', '', '--strict-mcp-config', '--disallowed-tools', '*'];

// The CLI's non-essential background traffic (autoupdater poll, telemetry,
// error reporting) fires extra requests that each pay the corporate-TLS tax and
// add wild variance — solo calls swung 5s→22s depending on whether those hung.
// Disabling them pinned a solo call to a steady ~5s.
const FAST_ENV = {
  ...process.env,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
};

// Cap how much we send to Haiku so a long-running session doesn't blow past
// argv limits or pad the prompt with stale context that drowns out the topic.
const MAX_PROMPTS = 8;
const MAX_PROMPT_CHARS = 500;

// Single spawn path shared by every labeler call — the timeout, stdio, env, and
// error handling were identical across three functions before this.
async function runClaude(
  systemPrompt: string,
  prompt: string,
  logTag: string
): Promise<{ ok: true; stdout: string } | LabelError> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    let resolved = false;
    const finish = (value: { ok: true; stdout: string } | LabelError) => {
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
      // replaces the default coding-agent prompt with the task-only one.
      child = spawn(
        'claude',
        ['--model', 'claude-haiku-4-5', ...FAST_FLAGS, '--system-prompt', systemPrompt, '--print', prompt],
        // stdin: 'ignore' = `< /dev/null`. Without it, `claude --print` blocks
        // ~3s waiting on stdin it'll never get — the prompt is fully in argv.
        { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env: FAST_ENV }
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
        finish({ ok: true, stdout: out });
        return;
      }
      const reason = stderr.trim() || `claude exited with code ${code ?? 'null'} and no output`;
      console.error(`[${logTag}] empty stdout:`, reason);
      finish({ ok: false, error: reason });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`[${logTag}] spawn error:`, err);
      finish({ ok: false, error: err.message || 'claude CLI failed to start' });
    });
  });
}

// Clean an array of raw tag strings: whitespace-normalize, strip stray
// brackets/quotes, drop trailing punctuation, clamp to 24 chars, dedupe (case-
// insensitive), cap at 5.
function normalizeTags(values: unknown[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const cleaned = value
      .replace(/\s+/g, ' ')
      .trim()
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

export async function generateSessionLabelAndTags(
  userMessages: string[]
): Promise<LabelAndTagsResult | LabelError> {
  if (!userMessages || userMessages.length === 0) {
    return { ok: false, error: 'No prompts to summarize' };
  }

  const trimmed = userMessages
    .slice(0, MAX_PROMPTS)
    .map((m) => (m.length > MAX_PROMPT_CHARS ? m.slice(0, MAX_PROMPT_CHARS) + '…' : m));
  const prompt = `User prompts:\n- ${trimmed.join('\n- ')}\n\nJSON:`;

  const res = await runClaude(LABEL_SYSTEM_PROMPT, prompt, 'labeler');
  if (!res.ok) return res;

  // Haiku sometimes wraps the object in a ```json fence or adds prose despite
  // the prompt — strip fences, then pull the first {...} block and parse it.
  const unfenced = res.stdout.replace(/```[a-z]*/gi, '').replace(/```/g, '').trim();
  const objMatch = unfenced.match(/\{[\s\S]*\}/);
  let parsed: any = null;
  try {
    parsed = JSON.parse(objMatch ? objMatch[0] : unfenced);
  } catch {
    parsed = null;
  }

  const title = typeof parsed?.title === 'string' ? parsed.title.trim() : '';
  if (!title) {
    return { ok: false, error: 'AI returned no usable title' };
  }
  const tags = Array.isArray(parsed?.tags) ? normalizeTags(parsed.tags) : [];
  return { ok: true, title, tags };
}

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

  const res = await runClaude(COMMIT_MESSAGE_SYSTEM_PROMPT, prompt, 'commit-msg');
  if (!res.ok) return res;

  // Strip wrapping code fences / quotes occasionally added by the model despite
  // the prompt. Keep blank lines so a multi-paragraph body survives intact.
  const cleaned = res.stdout
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/, '')
    .replace(/^["']+|["']+$/g, '')
    .trim();
  if (!cleaned) {
    return { ok: false, error: 'claude returned no commit message' };
  }
  return { ok: true, message: cleaned };
}
