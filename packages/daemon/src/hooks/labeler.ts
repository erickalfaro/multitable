/**
 * Session labeling / commit-message generation.
 *
 * Hot path (rename-ai): Anthropic Messages API directly — no `claude` CLI
 * spawn. Measured ~1–2s with OAuth (vs multi-second CLI cold-start that
 * frequently hit the 60s timeout through corporate TLS). Falls back to the
 * CLI only when no API key / OAuth token is available.
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
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
// so labels stay consistent across sessions. The model is free to coin its own.
const SUGGESTED_TAGS = [
  'feature',
  'bugfix',
  'refactor',
  'debugging',
  'testing',
  'docs',
  'cleanup',
  'review',
  'research',
  'config',
  'optimization',
  'migration',
  'setup',
  'frontend',
  'backend',
  'ui',
  'ux',
  'api',
  'database',
  'auth',
  'cli',
  'infra',
  'ci/cd',
  'devops',
  'networking',
  'styling',
  'state',
  'build',
  'security',
  'performance',
  'git',
  'deployment',
  'dependencies',
  'logging',
];

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

const HAIKU_MODEL = 'claude-haiku-4-5';
/** Direct API should finish in ~1–2s; 12s is hard fail for a "super fast" feature. */
const API_TIMEOUT_MS = 12_000;
/** CLI fallback only — cold start + TLS can drag; still tighter than the old 60s. */
const CLI_TIMEOUT_MS = 25_000;
const MAX_PROMPTS = 5;
const MAX_PROMPT_CHARS = 280;
const LABEL_MAX_TOKENS = 80;
const COMMIT_MAX_TOKENS = 200;

// ── Credentials ──────────────────────────────────────────────────────────────

type AuthMode =
  | { kind: 'api-key'; key: string }
  | { kind: 'oauth'; token: string }
  | null;

function readAuth(): AuthMode {
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (typeof envKey === 'string' && envKey.length > 0) {
    return { kind: 'api-key', key: envKey };
  }
  const envTok = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof envTok === 'string' && envTok.length > 0) {
    return { kind: 'oauth', token: envTok };
  }
  try {
    const raw = readFileSync(join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
    const tok = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } })?.claudeAiOauth
      ?.accessToken;
    if (typeof tok === 'string' && tok.length > 0) return { kind: 'oauth', token: tok };
  } catch {
    /* no subscription credentials */
  }
  return null;
}

// ── Direct Messages API (preferred) ──────────────────────────────────────────

async function runMessagesApi(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  logTag: string,
): Promise<{ ok: true; stdout: string } | LabelError | null> {
  const auth = readAuth();
  if (!auth) return null; // signal caller to try CLI

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (auth.kind === 'api-key') {
    headers['x-api-key'] = auth.key;
  } else {
    headers.authorization = `Bearer ${auth.token}`;
    // Required for Claude Code subscription OAuth against the Messages API.
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: maxTokens,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[${logTag}] API ${res.status} in ${Date.now() - t0}ms:`, text.slice(0, 240));
      // Fall back to CLI for auth/rate-limit — user may have CLI logged in differently.
      if (res.status === 401 || res.status === 403 || res.status === 429) return null;
      return { ok: false, error: `Anthropic API ${res.status}: ${text.slice(0, 160)}` };
    }
    let parsed: { content?: Array<{ type?: string; text?: string }> };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return { ok: false, error: 'Anthropic API returned non-JSON body' };
    }
    const out = (parsed.content ?? [])
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('')
      .trim();
    if (!out) return { ok: false, error: 'Anthropic API returned empty content' };
    console.log(`[${logTag}] API ok in ${Date.now() - t0}ms (${out.length} chars)`);
    return { ok: true, stdout: out };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { ok: false, error: `Anthropic API timed out after ${API_TIMEOUT_MS / 1000}s` };
    }
    console.error(`[${logTag}] API error in ${Date.now() - t0}ms:`, err?.message || err);
    return null; // network blip — try CLI
  } finally {
    clearTimeout(timer);
  }
}

// ── CLI fallback (cold start; avoid when possible) ───────────────────────────

const FAST_FLAGS = [
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--disallowed-tools',
  '*',
];

const FAST_ENV = {
  ...process.env,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
};

async function runClaudeCli(
  systemPrompt: string,
  prompt: string,
  logTag: string,
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
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: `claude CLI timed out after ${CLI_TIMEOUT_MS / 1000}s` });
    }, CLI_TIMEOUT_MS);

    try {
      child = spawn(
        'claude',
        [
          '--model',
          HAIKU_MODEL,
          ...FAST_FLAGS,
          '--system-prompt',
          systemPrompt,
          '--print',
          prompt,
        ],
        { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], env: FAST_ENV },
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

/** Prefer API; fall back to CLI only when no credentials or transient API fail. */
async function runHaiku(
  systemPrompt: string,
  prompt: string,
  maxTokens: number,
  logTag: string,
): Promise<{ ok: true; stdout: string } | LabelError> {
  const api = await runMessagesApi(systemPrompt, prompt, maxTokens, logTag);
  if (api) return api;
  console.log(`[${logTag}] falling back to claude CLI`);
  return runClaudeCli(systemPrompt, prompt, logTag);
}

// ── Parse helpers ────────────────────────────────────────────────────────────

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

function buildLabelUserPrompt(userMessages: string[]): string {
  // Prefer the most recent prompts — they define what the session is "about" now.
  const recent = userMessages.slice(-MAX_PROMPTS);
  const trimmed = recent.map((m) =>
    m.length > MAX_PROMPT_CHARS ? m.slice(0, MAX_PROMPT_CHARS) + '…' : m,
  );
  return `User prompts:\n- ${trimmed.join('\n- ')}\n\nJSON:`;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function generateSessionLabelAndTags(
  userMessages: string[],
): Promise<LabelAndTagsResult | LabelError> {
  if (!userMessages || userMessages.length === 0) {
    return { ok: false, error: 'No prompts to summarize' };
  }

  const prompt = buildLabelUserPrompt(userMessages);
  const res = await runHaiku(LABEL_SYSTEM_PROMPT, prompt, LABEL_MAX_TOKENS, 'labeler');
  if (!res.ok) return res;

  // Haiku sometimes wraps the object in a ```json fence or adds prose.
  const unfenced = res.stdout
    .replace(/```[a-z]*/gi, '')
    .replace(/```/g, '')
    .trim();
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
  stagedDiff: string,
): Promise<CommitMessageResult | LabelError> {
  const trimmed = stagedDiff.trim();
  if (!trimmed) {
    return { ok: false, error: 'Nothing staged to commit' };
  }

  const MAX_INPUT = 28_000;
  const clipped =
    trimmed.length > MAX_INPUT ? trimmed.slice(0, MAX_INPUT) + '\n[…truncated…]' : trimmed;
  const prompt = `Staged diff:\n\n${clipped}\n\nCommit message:`;

  const res = await runHaiku(
    COMMIT_MESSAGE_SYSTEM_PROMPT,
    prompt,
    COMMIT_MAX_TOKENS,
    'commit-msg',
  );
  if (!res.ok) return res;

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
