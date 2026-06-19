// TypeScript shapes for the Cursor CLI (`cursor-agent`) headless stream-json
// protocol. One JSON object per stdout line (NDJSON), terminated by a single
// `result` event. See .claude/skills/cursor-cli/reference/protocol.md for the
// authoritative wire description.
//
// We type only the fields we consume; every event carries `session_id` and most
// carry `timestamp_ms`. Unknown event types are ignored by the adapter.

export interface CursorInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string; // display name, not the model id
  permissionMode?: string;
  apiKeySource?: string;
  cwd?: string;
}

export interface CursorUserEvent {
  type: 'user';
  message?: { role: 'user'; content?: Array<{ type?: string; text?: string }> };
  session_id?: string;
}

export interface CursorThinkingEvent {
  type: 'thinking';
  subtype: 'delta' | 'completed';
  text?: string;
  session_id?: string;
  timestamp_ms?: number;
}

export interface CursorAssistantEvent {
  type: 'assistant';
  message?: { role: 'assistant'; content?: Array<{ type?: string; text?: string }> };
  session_id?: string;
  // Present on the CONSOLIDATED (full-text) line for a model-call segment.
  // Additive token pieces do NOT carry it (see pitfalls #2).
  model_call_id?: string;
  timestamp_ms?: number;
}

// `tool_call.tool_call` is an object with exactly one key — the tool name, e.g.
// `globToolCall`, `shellToolCall`, `readToolCall`, `editToolCall`. Its value
// holds `args` and (on completion) `result: { success } | { rejected }`.
export interface CursorToolCallEvent {
  type: 'tool_call';
  subtype: 'started' | 'completed';
  call_id?: string;
  tool_call?: Record<string, CursorToolBody>;
  model_call_id?: string;
  session_id?: string;
  timestamp_ms?: number;
}

export interface CursorToolBody {
  args?: Record<string, unknown>;
  result?: {
    success?: Record<string, unknown>;
    rejected?: { reason?: string; isReadonly?: boolean; command?: string };
  };
}

export interface CursorResultEvent {
  type: 'result';
  subtype?: string; // 'success' | …
  is_error?: boolean;
  result?: string; // canonical final assistant text
  duration_ms?: number;
  request_id?: string;
  session_id?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export type CursorEvent =
  | CursorInitEvent
  | CursorUserEvent
  | CursorThinkingEvent
  | CursorAssistantEvent
  | CursorToolCallEvent
  | CursorResultEvent
  | { type: string; [k: string]: unknown };

// Extract the joined plain text from a message.content array.
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
      out += (block as { text: string }).text;
    }
  }
  return out;
}

// Pull the tool name (the single key) and body out of a tool_call event.
export function readToolCall(
  ev: CursorToolCallEvent,
): { name: string; body: CursorToolBody } | null {
  const map = ev.tool_call;
  if (!map || typeof map !== 'object') return null;
  const key = Object.keys(map)[0];
  if (!key) return null;
  return { name: key.replace(/ToolCall$/, ''), body: map[key] ?? {} };
}
