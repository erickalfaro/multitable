import fs from 'fs';
import path from 'path';
import os from 'os';

// Claude API pricing per MTok (current tiers, verified against the claude-api
// skill). cacheWrite = 1.25x input (5-minute TTL), cacheRead = 0.1x input.
//   Opus 4.8:  $5 in  / $25 out
//   Sonnet 5:  $3 in  / $15 out
//   Haiku 4.5: $1 in  / $5  out
// This table is only consulted on the historical-JSONL /cost fallback in
// api/sessions.ts (a live session's cost comes from the SDK's totalCostUsd).
// The `includes()` fallbacks in getPricing catch date-suffixed / aliased ids,
// so exact keys are a bonus, not load-bearing.
const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number; cacheWritePerMTok: number; cacheReadPerMTok: number }> = {
  'claude-opus-4-8':   { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.50 },
  'claude-sonnet-5':   { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 },
  'claude-haiku-4-5':  { inputPerMTok: 1, outputPerMTok: 5,  cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.10 },
};

const OPUS_PRICING = MODEL_PRICING['claude-opus-4-8'];
const SONNET_PRICING = MODEL_PRICING['claude-sonnet-5'];
const HAIKU_PRICING = MODEL_PRICING['claude-haiku-4-5'];

// Default pricing (Sonnet-tier) if model is unknown
const DEFAULT_PRICING = { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 };

export function getPricing(model: string | undefined) {
  if (!model) return DEFAULT_PRICING;
  // Try exact match first, then prefix match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key) || key.startsWith(model)) return pricing;
  }
  // Infer from tier — matches date-suffixed / versioned ids the SDK writes to
  // the JSONL (e.g. claude-opus-4-8-20260101).
  if (model.includes('opus')) return OPUS_PRICING;
  if (model.includes('haiku')) return HAIKU_PRICING;
  if (model.includes('sonnet')) return SONNET_PRICING;
  return DEFAULT_PRICING;
}

interface UsageData {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

export interface CostAggregate {
  tokensIn: number;
  tokensOut: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  model: string;
  messageCount: number;
}

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

/**
 * Parse a Claude Code JSONL session file and aggregate all usage/cost data.
 */
export function parseSessionCost(projectPath: string, claudeSessionId: string): CostAggregate | null {
  const jsonlPath = getSessionJsonlPath(projectPath, claudeSessionId);

  let content: string;
  try {
    content = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return null;
  }

  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  let totalIn = 0;
  let totalOut = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let totalCostUsd = 0;
  let messageCount = 0;
  let lastModel = '';

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const msg = entry.message;
    if (!msg || typeof msg !== 'object' || !msg.usage) continue;
    if (msg.role !== 'assistant') continue;

    const usage: UsageData = msg.usage;
    const model = msg.model || '';
    if (model) lastModel = model;

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;

    totalIn += inputTokens;
    totalOut += outputTokens;
    totalCacheCreation += cacheCreation;
    totalCacheRead += cacheRead;
    messageCount++;

    // Calculate cost for this message
    const pricing = getPricing(model);
    const msgCost =
      (inputTokens / 1_000_000) * pricing.inputPerMTok +
      (outputTokens / 1_000_000) * pricing.outputPerMTok +
      (cacheCreation / 1_000_000) * pricing.cacheWritePerMTok +
      (cacheRead / 1_000_000) * pricing.cacheReadPerMTok;
    totalCostUsd += msgCost;
  }

  if (messageCount === 0) return null;

  return {
    tokensIn: totalIn,
    tokensOut: totalOut,
    cacheCreationTokens: totalCacheCreation,
    cacheReadTokens: totalCacheRead,
    costUsd: totalCostUsd,
    model: lastModel,
    messageCount,
  };
}

// ponytail: runnable self-check for the tier-fallback logic (the non-trivial
// part). Run directly with `node dist/hooks/costParser.js` — it throws on a
// bad rate and exits 0 otherwise; a no-op on import.
function demo() {
  const check = (label: string, got: number, want: number) => {
    if (got !== want) throw new Error(`${label}: expected ${want}, got ${got}`);
  };
  // Date-suffixed ids the SDK writes must resolve via the includes() fallback.
  check('opus 4.8 in', getPricing('claude-opus-4-8-20260101').inputPerMTok, 5);
  check('opus 4.8 out', getPricing('claude-opus-4-8-20260101').outputPerMTok, 25);
  check('haiku 4.5 in', getPricing('claude-haiku-4-5').inputPerMTok, 1);
  check('haiku 4.5 out', getPricing('claude-haiku-4-5').outputPerMTok, 5);
  check('sonnet in', getPricing('claude-sonnet-5-20260101').inputPerMTok, 3);
  check('unknown → sonnet default', getPricing(undefined).inputPerMTok, 3);
  console.log('costParser pricing self-check passed');
}

if (process.argv[1]?.endsWith('costParser.js')) {
  demo();
}
