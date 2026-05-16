// Provider registry. Each AgentProvider has one adapter file. Adding a new
// provider (Gemini, Amp, Aider, ...) is two lines: an import + an entry in
// `adapters` below. The adapter implements the ProviderAdapter contract from
// ./types.ts.
//
// Today only Codex is fully behind this seam. Claude's logic still lives
// inline in agent/manager.ts because its handlers are tightly coupled to the
// manager's permission / elicitation / hook plumbing. Treat the manager as
// the de-facto Claude adapter; the explicit ones cover the rest.
export type { ProviderAdapter, AdapterCallbacks } from './types.js';
export { CodexAdapter } from './codex.js';
