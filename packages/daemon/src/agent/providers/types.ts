import type { AgentSession } from '../types.js';
import type { Message } from '../../transcripts/parser.js';

// What a provider adapter calls back into when it produces output. The
// AgentSessionManager owns the EventEmitter surface and the lifecycle state
// machine; adapters only translate SDK events into this shape.
export interface AdapterCallbacks {
  // Final assistant or tool messages — drive the chat UI.
  emitAssistantMessage(messages: Message[]): void;
  // In-flight assistant text — drives the live streaming preview.
  emitAssistantDelta(text: string): void;
  emitToolEvent(messages: Message[]): void;
  emitUserMessage(messages: Message[]): void;
  // Provider learned (or re-learned) the canonical session id for this
  // conversation. Manager updates AgentSession + DB.
  onSessionIdAssigned(newId: string, history: string[]): void;
  // Snapshot of cumulative cost / token / currentTool for the live state pane.
  emitStateSnapshot(): void;
  // Append the message list to AgentSession.messages — manager owns the
  // dedupe/persistence policy.
  pushMessages(messages: Message[]): void;
  // Cumulative usage updates (tokens/cost) for the result row.
  applyUsage(input: {
    tokensIn: number;
    tokensOut: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  }): void;
  // Surface a successful turn-result for toast / cost / `/cost`.
  emitTurnResult(input: {
    subtype: string;
    totalCostUsd: number;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationInputTokens: number;
      cacheReadInputTokens: number;
    };
    text: string | null;
  }): void;
  // Tool name shown in the live state pane while a tool is running.
  setCurrentTool(name: string | null): void;
  // Bump the activity clock — drives the "running for ___" badge.
  bumpActivity(): void;
  // First-prompt detection for AI rename.
  maybeRenameFromFirstPrompt(prompt: string): void;
  // Daemon-side guarantee tick: the adapter has just diffed in-memory state
  // against its authoritative on-disk log and broadcast any missing items.
  // Manager re-emits as `session:reconciled` so the frontend can do a no-op
  // REST sync to confirm consistency.
  emitReconciled(addedMessageIds: string[]): void;
  // Live in-progress tool execution snapshot — fires on every item.updated
  // for command_execution / file_change / mcp_tool_call / web_search items
  // so the chat UI can render the cumulative output as it arrives, before
  // the canonical tool_use/tool_result messages land at item.completed. Pass
  // `null` to clear the live slot (tool finished, switched, or turn ended).
  emitToolDelta(payload: ToolDeltaPayload | null): void;
  // Live reasoning text — codex emits a stream of model thinking that we
  // surface as an italic preview while the agent is mid-turn. Empty string
  // clears.
  emitReasoningDelta(text: string): void;
  // The optimistic message that was broadcast with `oldId` is now known to
  // be the same logical message as the one with the canonical `newId` (e.g.
  // the user's prompt that was pushed with a temp id, then matched against
  // the codex JSONL after the turn). Frontend updates its store id in place.
  // This is the SOTA pattern for optimistic-UI reconciliation — the same
  // shape Linear/Figma/Slack use for client-temp-id → server-canonical-id.
  emitMessageRekey(oldId: string, newId: string): void;
}

export interface ToolDeltaPayload {
  toolName: string;
  input: unknown;
  output: string;
  isError: boolean;
}

// Adapter contract. Each provider (claude, codex, gemini, ...) implements this.
// The manager picks an adapter by AgentSession.provider and calls runTurn for
// each user turn. reset() is called when /clear nukes the conversation.
export interface ProviderAdapter {
  readonly name: 'claude' | 'codex';
  runTurn(s: AgentSession, text: string, ctrl: AbortController, cb: AdapterCallbacks): Promise<void>;
  reset?(s: AgentSession): void;
}
