import fs from 'fs';
import path from 'path';
import os from 'os';

// Claude API pricing per token (as of 2025)
// Opus 4: $15/MTok input, $75/MTok output
// Sonnet 4: $3/MTok input, $15/MTok output
// Haiku 3.5: $0.80/MTok input, $4/MTok output
// Cache write: 1.25x input price, Cache read: 0.1x input price
const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number; cacheWritePerMTok: number; cacheReadPerMTok: number }> = {
  'claude-opus-4-6':      { inputPerMTok: 15,  outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.50 },
  'claude-opus-4-20250514': { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.50 },
  'claude-sonnet-4-20250514': { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 },
  'claude-3-5-sonnet':    { inputPerMTok: 3,   outputPerMTok: 15, cacheWritePerMTok: 3.75,  cacheReadPerMTok: 0.30 },
  'claude-3-5-haiku':     { inputPerMTok: 0.8, outputPerMTok: 4,  cacheWritePerMTok: 1.0,   cacheReadPerMTok: 0.08 },
};

// Default pricing (Sonnet-tier) if model is unknown
const DEFAULT_PRICING = { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 };

function getPricing(model: string | undefined) {
  if (!model) return DEFAULT_PRICING;
  // Try exact match first, then prefix match
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key) || key.startsWith(model)) return pricing;
  }
  // Infer from model name
  if (model.includes('opus')) return MODEL_PRICING['claude-opus-4-6'];
  if (model.includes('haiku')) return MODEL_PRICING['claude-3-5-haiku'];
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
