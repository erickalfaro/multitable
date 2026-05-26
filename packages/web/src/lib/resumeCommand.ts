import type { AgentProvider } from './types';

/**
 * Builds the shell command that resumes a session in the provider's own CLI.
 * Claude/Codex have first-class resume verbs; other providers fall back to the
 * raw id (there is no resume command to offer). Shared by SessionHeaderBar and
 * the detail panel's Info tab so the two never drift.
 */
export function buildResumeCommand(provider: AgentProvider, id: string): string {
  if (provider === 'claude') return `claude --resume ${id}`;
  if (provider === 'codex') return `codex resume ${id}`;
  return id;
}

/**
 * Human label for a session's persisted id, named after what each provider
 * calls it (Codex threads, Hermes sessions, everything else "Session ID").
 */
export function sessionIdLabel(provider: AgentProvider): string {
  if (provider === 'codex') return 'Thread ID';
  if (provider === 'hermes') return 'Hermes session ID';
  return 'Session ID';
}
