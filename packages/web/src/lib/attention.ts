import type { Message, AgentProvider } from './types';
import type { AttentionEvent, AttentionKind } from '../stores/appStore';

/** Classify a tool name into an AttentionKind. Default = command. */
export function kindForTool(toolName: string): AttentionKind {
  if (!toolName) return 'command';
  if (toolName.startsWith('mcp__') || toolName.startsWith('mcp.')) return 'mcp';
  const t = toolName.toLowerCase();
  if (t === 'read' || t === 'glob' || t === 'ls' || t === 'tree') return 'read';
  if (t === 'edit' || t === 'write' || t === 'multiedit' || t === 'create' || t === 'apply_patch') {
    return 'edit';
  }
  if (t === 'grep' || t === 'search' || t === 'websearch') return 'search';
  if (t === 'bash' || t === 'shell' || t === 'exec' || t === 'run' || t === 'execcommand') {
    return 'command';
  }
  return 'command';
}

/** Truncate a long line for the row label. Single-line clamp. */
function clampLabel(s: string, max = 96): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + '…';
}

/** Pull a short, scannable label out of a tool's input bag. */
function describeToolInput(toolName: string, input: unknown): string {
  if (input == null) return toolName;
  if (typeof input === 'string') return `${toolName} ${clampLabel(input)}`;
  if (typeof input !== 'object') return toolName;
  const obj = input as Record<string, unknown>;
  const target =
    (typeof obj.file_path === 'string' && obj.file_path) ||
    (typeof obj.path === 'string' && obj.path) ||
    (typeof obj.target_file === 'string' && obj.target_file) ||
    (typeof obj.filename === 'string' && obj.filename) ||
    null;
  const command =
    (typeof obj.command === 'string' && obj.command) ||
    (typeof obj.cmd === 'string' && obj.cmd) ||
    (typeof obj.script === 'string' && obj.script) ||
    null;
  const pattern =
    (typeof obj.pattern === 'string' && obj.pattern) ||
    (typeof obj.query === 'string' && obj.query) ||
    null;

  if (target) return `${toolName} ${target}`;
  if (command) return `$ ${clampLabel(command)}`;
  if (pattern) return `${toolName} '${clampLabel(pattern, 60)}'`;
  return toolName;
}

/** Stringify the tool input for the expandable detail body. */
function inputDetail(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/**
 * Convert a batch of Messages (from `session:tool-event` / canonical paths)
 * into AttentionEvents. Each tool_use produces one event keyed by toolUseId;
 * tool_result and reasoning rows are handled separately by callers because
 * they may need to be applied as a patch to an existing event rather than as
 * an independent row.
 */
export function deriveAttentionEvents(
  sessionId: string,
  provider: AgentProvider,
  messages: Message[],
): AttentionEvent[] {
  const out: AttentionEvent[] = [];
  for (const m of messages) {
    if (m.kind === 'tool_use') {
      out.push({
        id: m.toolUseId,
        itemId: m.toolUseId,
        sessionId,
        provider,
        kind: kindForTool(m.toolName),
        label: describeToolInput(m.toolName, m.input),
        detail: inputDetail(m.input) || undefined,
        timestamp: m.ts,
      });
    } else if (m.kind === 'reasoning') {
      out.push({
        id: m.id,
        itemId: m.id,
        sessionId,
        provider,
        kind: 'reasoning',
        label: clampLabel(m.text || 'Thinking…'),
        detail: m.text,
        timestamp: m.ts,
      });
    }
  }
  return out;
}

/** Build the patch a tool_result message implies for its tool_use row. */
export function attentionPatchForToolResult(output: string, isError: boolean) {
  return {
    detail: output,
    isError,
  };
}
