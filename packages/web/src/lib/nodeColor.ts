import type { Message } from './types';

const FS_READ = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const FS_WRITE = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Patch']);
const SHELL = new Set(['Bash', 'BashOutput', 'KillShell', 'Command']);
const WEB = new Set(['WebFetch', 'WebSearch']);
const SUBAGENT = new Set(['Task', 'Agent']);
const TODO = new Set(['TodoWrite']);

export function getNodeColorVar(m: Message): string {
  if (m.kind === 'reasoning') return '--node-thinking';
  if (m.kind === 'assistant') return '--node-text';
  if (m.kind === 'tool_use') {
    const n = m.toolName ?? '';
    if (n.startsWith('mcp__')) return '--node-mcp';
    if (FS_READ.has(n)) return '--node-fs-read';
    if (FS_WRITE.has(n)) return '--node-fs-write';
    if (SHELL.has(n)) return '--node-shell';
    if (WEB.has(n)) return '--node-web';
    if (SUBAGENT.has(n)) return '--node-subagent';
    if (TODO.has(n)) return '--node-todo';
    return '--node-text';
  }
  return '--node-text';
}

export function getNodeColor(m: Message): string {
  return `var(${getNodeColorVar(m)})`;
}

export function getNodeLabel(m: Message): string {
  if (m.kind === 'reasoning') return 'Thinking';
  if (m.kind === 'assistant') return 'Response';
  if (m.kind === 'tool_use') return m.toolName || 'Tool';
  return '';
}
