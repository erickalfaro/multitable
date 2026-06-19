// Barrel for the Cursor CLI transport layer. The CursorAdapter
// (../cursor.ts) imports from here; nothing else should reach into the
// individual files.
export { runCursor, resolveCursorCli } from './runner.js';
export type { RunCursorOptions, RunCursorResult, ResolvedCli } from './runner.js';
export { buildCursorArgs } from './args.js';
export type { CursorArgsInput } from './args.js';
export { contentText, readToolCall } from './events.js';
export type {
  CursorEvent,
  CursorInitEvent,
  CursorAssistantEvent,
  CursorThinkingEvent,
  CursorToolCallEvent,
  CursorResultEvent,
  CursorToolBody,
} from './events.js';
