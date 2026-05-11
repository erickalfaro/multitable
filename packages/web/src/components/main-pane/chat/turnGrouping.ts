import type { Message } from '../../../lib/types';

export type TurnMessage = Extract<Message, { kind: 'assistant' | 'tool_use' | 'reasoning' }>;

export type ChatBlock =
  | { kind: 'user'; message: Extract<Message, { kind: 'user' }> }
  | { kind: 'system'; message: Extract<Message, { kind: 'system' }> }
  | { kind: 'turn'; messages: TurnMessage[] };

export function groupIntoBlocks(messages: Message[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let current: TurnMessage[] | null = null;
  const flush = () => {
    if (current && current.length) blocks.push({ kind: 'turn', messages: current });
    current = null;
  };
  for (const m of messages) {
    if (m.kind === 'tool_result') continue;
    // Cost-only assistant markers (zero-text, usage-bearing) shouldn't render
    // as their own rail node — the dot would float with no card content.
    if (m.kind === 'assistant' && !m.text.trim()) continue;
    if (m.kind === 'user') {
      flush();
      blocks.push({ kind: 'user', message: m });
      continue;
    }
    if (m.kind === 'system') {
      flush();
      blocks.push({ kind: 'system', message: m });
      continue;
    }
    (current ??= []).push(m);
  }
  flush();
  return blocks;
}
