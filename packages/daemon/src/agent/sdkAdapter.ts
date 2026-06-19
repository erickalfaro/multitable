// Pure converters from Claude Agent SDK message shapes to MultiTable's
// internal `Message` union (the same shape `parseTranscriptContent` produces
// in transcripts/parser.ts). Keeping this module pure and side-effect-free
// makes it trivial to unit-test and easy to swap if the SDK shape shifts.
//
// SDK types are accepted as `any` here; a later polish pass will import the
// real SDK message types once we lock a version. The small local interfaces
// below exist only to self-document call sites.

import type { Message, Usage } from '../transcripts/parser.js';

// ---------------------------------------------------------------------------
// Local shape hints for the SDK messages we consume. Not exhaustive; defensive
// parsing below tolerates missing/extra fields.
// ---------------------------------------------------------------------------

interface SdkTextBlock {
  type: 'text';
  text: string;
}

interface SdkToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface SdkToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: 'text'; text: string } | { type: 'image' } | unknown>;
  is_error?: boolean;
}

interface SdkThinkingBlock {
  type: 'thinking';
  thinking: string;
}

interface SdkAssistantMessage {
  type: 'assistant';
  message: {
    role: 'assistant';
    model?: string;
    content: Array<SdkTextBlock | SdkToolUseBlock | SdkThinkingBlock>;
    usage?: Usage;
  };
  session_id?: string;
  parent_tool_use_id?: string | null;
  uuid?: string;
  timestamp?: string;
}

interface SdkUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string | Array<SdkToolResultBlock | SdkTextBlock>;
  };
  uuid?: string;
  timestamp?: string;
}

interface SdkSystemInitMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
}

interface SdkResultMessage {
  type: 'result';
  subtype: string;
  session_id: string;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    // Permissive: some SDK builds use snake_case here — tolerate both.
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Exported return types
// ---------------------------------------------------------------------------

export interface SystemInitInfo {
  claudeSessionId: string | null;
}

export interface ResultInfo {
  subtype: string;
  claudeSessionId: string;
  totalCostUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  text: string | null;
  // SDK's `errors: string[]` field on SDKResultError. Empty for SDKResultSuccess.
  // Captured so the adapter can surface model-side failures verbatim to the
  // user instead of silently dropping them.
  errors: string[];
  // True for any non-`success` result subtype (`error_during_execution`,
  // `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`).
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Local helpers. Keep these mirror-images of the equivalents in
// transcripts/parser.ts so SDK-emitted and JSONL-parsed Messages are
// indistinguishable downstream.
// ---------------------------------------------------------------------------

// Strip Claude's injected <system-reminder>, <ide_selection>, etc. so the
// returned text is only what the user actually typed. This is copied (not
// imported) from transcripts/parser.ts where it is private; we do not want
// to widen parser.ts's public surface just for this.
function stripContextWrappers(text: string): string {
  let t = text;
  t = t.replace(/<[a-z][a-z0-9_-]*>[\s\S]*?<\/[a-z][a-z0-9_-]*>/gi, '');
  t = t.replace(/<[a-z][a-z0-9_-]*[^>]*\/>/gi, '');
  return t.trim();
}

function parseTs(v: unknown, fallback: number): number {
  if (typeof v !== 'string') return fallback;
  const n = Date.parse(v);
  return isNaN(n) ? fallback : n;
}

// Mirrors transcripts/parser.ts:toolResultToString exactly so downstream
// rendering sees identical output for SDK and JSONL paths.
function toolResultToString(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const obj = b as { type?: string; text?: unknown };
          if (obj.type === 'text' && typeof obj.text === 'string') return obj.text;
          if (obj.type === 'image') return '[image]';
        }
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

function toNum(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the `session_id` from a system init message. Returns null for any
 * other shape so callers can use a falsy check.
 */
export function sdkSystemInit(msg: any): SystemInitInfo | null {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type !== 'system') return null;
  if (msg.subtype !== 'init') return null;
  const sid = typeof msg.session_id === 'string' && msg.session_id ? msg.session_id : null;
  return { claudeSessionId: sid };
}

/**
 * Convert an SDK `assistant` message into one or more `Message` entries.
 * One text block → one `assistant` Message; one tool_use block → one
 * `tool_use` Message. Usage (cost tokens) attaches to the first assistant
 * text; if the turn is pure tool_use, a zero-text assistant Message is
 * emitted so cost still registers. Matches parseTranscriptContent exactly.
 */
export function sdkAssistantToMessages(msg: any, nowMs?: number): Message[] {
  if (!msg || typeof msg !== 'object') return [];
  if (msg.type !== 'assistant') return [];
  const inner = msg.message;
  if (!inner || typeof inner !== 'object') return [];

  const now = nowMs ?? Date.now();
  const ts = parseTs(msg.timestamp, now);

  // Fallback id counter is scoped to this call — matches parser.ts's
  // per-invocation `let fallbackCounter = 0`.
  let fallbackCounter = 0;
  const parentUuid =
    typeof msg.uuid === 'string' && msg.uuid ? msg.uuid : `gen-${fallbackCounter++}`;

  const model = typeof inner.model === 'string' ? inner.model : '';
  const usage: Usage | undefined = inner.usage;
  const content = inner.content;

  const out: Message[] = [];

  if (Array.isArray(content)) {
    let blockIdx = 0;
    let usageAttached = false;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as {
        type?: string;
        text?: unknown;
        thinking?: unknown;
        id?: unknown;
        name?: unknown;
        input?: unknown;
      };
      if (b.type === 'thinking' && typeof b.thinking === 'string') {
        if (b.thinking.trim()) {
          out.push({
            id: `${parentUuid}-th${blockIdx++}`,
            ts,
            kind: 'reasoning',
            text: b.thinking,
          });
        }
      } else if (b.type === 'text' && typeof b.text === 'string') {
        if (b.text.trim()) {
          const attachUsage = !usageAttached && !!usage;
          out.push({
            id: `${parentUuid}-t${blockIdx++}`,
            ts,
            kind: 'assistant',
            text: b.text,
            model,
            usage: attachUsage ? usage : undefined,
          });
          if (attachUsage) usageAttached = true;
        }
      } else if (b.type === 'tool_use') {
        out.push({
          id: `${parentUuid}-u${blockIdx++}`,
          ts,
          kind: 'tool_use',
          parentId: parentUuid,
          toolUseId: typeof b.id === 'string' ? b.id : '',
          toolName: typeof b.name === 'string' ? b.name : '',
          input: b.input ?? {},
        });
      }
      // Unknown block types: silently skip. Defensive.
    }
    // Assistant turn had only tool_use blocks — attach usage to a zero-text
    // assistant marker so cost shows up. Skip if nothing was emitted.
    if (!usageAttached && usage && blockIdx > 0) {
      out.push({
        id: `${parentUuid}-u`,
        ts,
        kind: 'assistant',
        text: '',
        model,
        usage,
      });
    }
  } else if (typeof content === 'string' && content.trim()) {
    out.push({ id: parentUuid, ts, kind: 'assistant', text: content, model, usage });
  }

  return out;
}

/**
 * Convert an SDK `user` message into Message entries. A user message can
 * carry tool_result blocks (replies to assistant tool_use) and/or text
 * blocks (subsequent user prompts batched in). Text blocks are run through
 * stripContextWrappers to remove Claude's injected <system-reminder> and
 * <ide_selection> blobs. If content is a bare string, we treat it as a
 * single user text message.
 */
export function sdkUserToMessages(msg: any, nowMs?: number): Message[] {
  if (!msg || typeof msg !== 'object') return [];
  if (msg.type !== 'user') return [];
  const inner = msg.message;
  if (!inner || typeof inner !== 'object') return [];

  const now = nowMs ?? Date.now();
  const ts = parseTs(msg.timestamp, now);

  let fallbackCounter = 0;
  const parentUuid =
    typeof msg.uuid === 'string' && msg.uuid ? msg.uuid : `gen-${fallbackCounter++}`;

  const content = inner.content;
  const out: Message[] = [];

  if (typeof content === 'string') {
    const text = stripContextWrappers(content);
    if (text) out.push({ id: parentUuid, ts, kind: 'user', text });
  } else if (Array.isArray(content)) {
    let blockIdx = 0;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as {
        type?: string;
        text?: unknown;
        tool_use_id?: unknown;
        content?: unknown;
        is_error?: unknown;
      };
      if (b.type === 'tool_result') {
        out.push({
          id: `${parentUuid}-r${blockIdx++}`,
          ts,
          kind: 'tool_result',
          toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
          output: toolResultToString(b.content),
          isError: !!b.is_error,
        });
      } else if (b.type === 'text' && typeof b.text === 'string') {
        const text = stripContextWrappers(b.text);
        if (text) {
          out.push({
            id: `${parentUuid}-t${blockIdx++}`,
            ts,
            kind: 'user',
            text,
          });
        }
      }
      // Unknown block types: skip.
    }
  }

  return out;
}

/**
 * Extract cost/usage/session info from an SDK `result` message. Returns
 * null if the input is not a result message. Tolerates both camelCase
 * (documented) and snake_case (observed in some SDK builds) usage keys.
 */
export function sdkResult(msg: any): ResultInfo | null {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type !== 'result') return null;

  const u = (msg.usage ?? {}) as Record<string, unknown>;
  const usage = {
    inputTokens: toNum(u.inputTokens ?? u.input_tokens),
    outputTokens: toNum(u.outputTokens ?? u.output_tokens),
    cacheCreationInputTokens: toNum(u.cacheCreationInputTokens ?? u.cache_creation_input_tokens),
    cacheReadInputTokens: toNum(u.cacheReadInputTokens ?? u.cache_read_input_tokens),
  };

  const subtype = typeof msg.subtype === 'string' ? msg.subtype : '';
  const rawErrors = Array.isArray(msg.errors) ? msg.errors : [];
  const errors = rawErrors
    .map((e: unknown) => (typeof e === 'string' ? e : ''))
    .filter((e: string) => e.length > 0);

  return {
    subtype,
    claudeSessionId: typeof msg.session_id === 'string' ? msg.session_id : '',
    totalCostUsd: toNum(msg.total_cost_usd),
    usage,
    text: typeof msg.result === 'string' ? msg.result : null,
    errors,
    isError: subtype !== '' && subtype !== 'success',
  };
}
