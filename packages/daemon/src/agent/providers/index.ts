// Provider registry barrel. Each AgentProvider (`claude` | `codex` | `hermes`)
// has its own adapter file implementing the ProviderAdapter contract from
// ./types.ts. They are registered in AgentSessionManager's `adapters` map
// (agent/manager.ts); adding a new provider (Gemini, Amp, Aider, ...) is an
// import + one entry there.
//
// The manager is fully provider-agnostic — every turn is delegated through
// ProviderAdapter. There is no "Claude lives inline in the manager" path
// anymore; ClaudeAdapter is a peer of CodexAdapter and HermesAdapter.
export type { ProviderAdapter, AdapterCallbacks } from './types.js';
export { ClaudeAdapter } from './claude.js';
export { CodexAdapter } from './codex.js';
export { HermesAdapter } from './hermes.js';
export { GrokAdapter } from './grok.js';
export { CursorAdapter } from './cursor.js';
