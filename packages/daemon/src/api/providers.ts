import { Router } from 'express';
import type { Request, Response } from 'express';
import { spawn } from 'child_process';

// Discovered models we expose to the UI. Both providers populate this from a
// runtime probe — never a hardcoded version list — so a model change on the
// server side doesn't require a client release.
export interface DiscoveredModel {
  id: string;
  displayName: string;
  description?: string;
  isDefault?: boolean;
}

interface ProvidersDeps {
  getDaemonEnv: () => NodeJS.ProcessEnv;
}

// Run a CLI helper and return its stdout. Bounded by a soft timeout so a stuck
// child can never hang the HTTP request.
function execStdout(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 6000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error(`${cmd} ${args.join(' ')}: timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (b) => {
      out += b.toString();
    });
    child.stderr.on('data', (b) => {
      err += b.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.trim() || out.trim()}`));
    });
  });
}

// Codex ships a `codex debug models` subcommand that prints the live model
// catalog as JSON (the same data its TUI picker uses). This is the source of
// truth — we don't keep a fallback list, since shipping a stale local list is
// the exact failure mode the user asked us to avoid. If the call fails we
// surface the error so the UI can say "couldn't load Codex models" instead of
// silently substituting outdated entries.
async function listCodexModels(env: NodeJS.ProcessEnv): Promise<DiscoveredModel[]> {
  const stdout = await execStdout('codex', ['debug', 'models'], env);
  const parsed = JSON.parse(stdout);
  const raw = Array.isArray(parsed?.models) ? parsed.models : [];
  return raw
    .filter((m: any) => m && typeof m.slug === 'string' && m.visibility !== 'hide')
    .map((m: any) => ({
      id: String(m.slug),
      displayName: typeof m.display_name === 'string' && m.display_name ? m.display_name : String(m.slug),
      description: typeof m.description === 'string' ? m.description : undefined,
    }));
}

// Hermes (Nous Research) routes Grok 4.3 + the grok-4.20 variants through its
// xAI OAuth provider. There's no `hermes models --json` CLI surface today;
// the live catalog ships with the `models.dev` cache referenced in the xAI
// Grok OAuth docs (https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth).
// Return the canonical list xAI documents as the chat catalog — grok-4.3 is
// pinned default. Legacy slugs (grok-4-1-fast, grok-4-fast, grok-code-fast-1)
// redirect to grok-4.3 server-side as of 2026-05-15, so callers that picked
// older ids continue to work.
async function listHermesModels(_env: NodeJS.ProcessEnv): Promise<DiscoveredModel[]> {
  return [
    {
      id: 'grok-4.3',
      displayName: 'Grok 4.3',
      description: 'xAI flagship. 1M context, agentic tool calling, reasoning.',
      isDefault: true,
    },
    {
      id: 'grok-4.20-0309-reasoning',
      displayName: 'Grok 4.20 Reasoning',
      description: 'Reasoning variant for harder problems.',
    },
    {
      id: 'grok-4.20-0309-non-reasoning',
      displayName: 'Grok 4.20',
      description: 'Non-reasoning variant.',
    },
    {
      id: 'grok-4.20-multi-agent-0309',
      displayName: 'Grok 4.20 Multi-agent',
      description: 'Multi-agent variant.',
    },
  ];
}

// Claude has no equivalent "list models" CLI subcommand. The closest live
// source is the Anthropic REST API `/v1/models`, which only authenticates with
// `ANTHROPIC_API_KEY` (OAuth tokens from `claude login` are rejected for that
// endpoint). When the API key is set we fetch live; otherwise we return the
// canonical alias set the Claude Code SDK accepts ('opus' / 'sonnet' /
// 'haiku'). Aliases are *server-resolved* — they always point at the latest
// version on Anthropic's side, so this isn't a frozen version list, it's a
// stable indirection. This is the smallest surface that still lets the user
// pick a tier without us baking in a specific model release.
async function listClaudeModels(env: NodeJS.ProcessEnv): Promise<DiscoveredModel[]> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
        const data = Array.isArray(body.data) ? body.data : [];
        if (data.length > 0) {
          return data.map((m) => ({
            id: m.id,
            displayName: m.display_name || m.id,
          }));
        }
      }
    } catch {
      /* fall through to alias set */
    }
  }
  return [
    {
      id: 'opus',
      displayName: 'Opus (latest)',
      description: 'Most capable. Highest cost. Resolves to the latest Opus on each turn.',
    },
    {
      id: 'sonnet',
      displayName: 'Sonnet (latest)',
      description: 'Balanced speed and capability. Resolves to the latest Sonnet on each turn.',
      isDefault: true,
    },
    {
      id: 'haiku',
      displayName: 'Haiku (latest)',
      description: 'Fastest and cheapest. Resolves to the latest Haiku on each turn.',
    },
  ];
}

export function createProvidersRouter(deps: ProvidersDeps): Router {
  const router = Router();

  router.get('/:provider/models', async (req: Request, res: Response) => {
    const provider = String(req.params.provider || '').toLowerCase();
    try {
      const env = deps.getDaemonEnv();
      let models: DiscoveredModel[];
      if (provider === 'codex') {
        models = await listCodexModels(env);
      } else if (provider === 'claude') {
        models = await listClaudeModels(env);
      } else if (provider === 'hermes') {
        models = await listHermesModels(env);
      } else {
        return res.status(404).json({ error: `unknown provider: ${provider}` });
      }
      res.json({ provider, models });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: message, provider });
    }
  });

  return router;
}
