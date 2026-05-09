import { EventEmitter } from 'events';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Response } from 'express';
import type { PermissionPrompt, AskQuestion } from '../types.js';

// Tools that are always approved without prompting the user
const AUTO_DEFER_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'TodoRead',
  'TodoGet',
  'WebSearch',
]);

// Tool inputs whose path argument we check against cwd before auto-deferring.
// If the path resolves outside cwd, we surface a card to the web UI instead of
// silently allowing — this is the path that attachments take, since they live
// in the multitable data dir, not under the project working directory.
const PATH_FIELDS_BY_TOOL: Record<string, string> = {
  Read: 'file_path',
  Grep: 'path',
  Glob: 'path',
  LS: 'path',
};

function pathInsideCwd(toolName: string, toolInput: Record<string, any>, cwd: string): boolean {
  const field = PATH_FIELDS_BY_TOOL[toolName];
  if (!field) return true; // tool has no path arg → nothing to gate
  const raw = toolInput?.[field];
  if (typeof raw !== 'string' || raw.length === 0) return true; // path arg absent
  if (!cwd) return true; // we don't know the cwd → fall back to auto-defer
  const abs = path.resolve(cwd, raw);
  const rel = path.relative(cwd, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

type HookEventName = 'PreToolUse' | 'PermissionRequest';

// Phase 5: the SDK canUseTool path resolves a Promise instead of writing to
// an Express response. We carry SDK responders alongside HTTP responders on
// the same PendingPermission so dedup still coalesces both paths into a
// single user-facing card.
type SdkResolver = (decision: SdkDecision) => void;

type SdkDecision =
  | { kind: 'allow'; updatedInput: Record<string, any> }
  | { kind: 'deny'; message: string };

export interface PermissionExtras {
  title?: string;
  displayName?: string;
  subtitle?: string;
  blockedPath?: string;
}

// SDK PermissionResult shape (verified against the bundled `claude` binary in
// @anthropic-ai/claude-agent-sdk@0.2.119): the runtime Zod schema requires
// `updatedInput: record` on allow and `message: string` on deny — even though
// sdk.d.ts declares `updatedInput?` as optional. Returning `{ behavior: 'allow' }`
// without `updatedInput` makes the binary throw and synthesize a deny with
// `message: "Tool permission request failed: ZodError..."`, which kills every
// tool call. Always pass the original tool input as `updatedInput`.
export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, any> }
  | { behavior: 'deny'; message: string };

interface PendingPermission {
  prompt: PermissionPrompt;
  // Multiple held-open HTTP responses can attach to the same prompt when
  // Claude Code retries the hook (or parallel agents request the same tool).
  // Each responder carries the event name it arrived from, because PreToolUse
  // and PermissionRequest expect different response shapes — even when they
  // describe the same underlying tool call we coalesced via dedup.
  responders: Array<{ res: Response; eventName: HookEventName }>;
  // Phase 5: SDK callbacks subscribe via a Promise resolver. Multiple SDK
  // resolvers can pile onto a single prompt the same way HTTP responders do
  // (e.g. the same tool retried mid-turn).
  sdkResolvers: Array<{ resolve: SdkResolver; abortCleanup?: () => void }>;
  sessionId: string;
  dedupKey: string;
}

function makeDedupKey(sessionId: string, toolName: string, toolInput: Record<string, any>): string {
  let inputPart: string;
  try {
    inputPart = JSON.stringify(toolInput ?? {});
  } catch {
    inputPart = String(toolInput);
  }
  return `${sessionId}|${toolName}|${inputPart}`;
}

// Claude Code's PreToolUse and PermissionRequest hooks use different response
// shapes. PreToolUse expects `hookSpecificOutput.permissionDecision`, while
// PermissionRequest expects `hookSpecificOutput.decision.behavior`. Both fields
// are nested under `hookSpecificOutput.hookEventName` matching the source event.
function buildAllowBody(eventName: HookEventName, updatedInput?: Record<string, any>): Record<string, any> {
  if (eventName === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          ...(updatedInput ? { updatedInput } : {}),
        },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      ...(updatedInput ? { updatedInput } : {}),
    },
  };
}

function buildDenyBody(eventName: HookEventName, reason?: string): Record<string, any> {
  if (eventName === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          ...(reason ? { message: reason } : {}),
        },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      ...(reason ? { permissionDecisionReason: reason } : {}),
    },
  };
}

function sendAll(
  entry: PendingPermission,
  build: (eventName: HookEventName) => Record<string, any>
): void {
  for (const r of entry.responders) {
    try { r.res.json(build(r.eventName)); } catch {}
  }
}

// Resolve every SDK Promise attached to this prompt with the same decision.
// Cleanup any abort listeners we set up at requestFromSdk time.
function resolveAllSdk(entry: PendingPermission, decision: SdkDecision): void {
  for (const r of entry.sdkResolvers) {
    try { r.abortCleanup?.(); } catch {}
    try { r.resolve(decision); } catch {}
  }
  entry.sdkResolvers.length = 0;
}

function parseAskQuestions(toolInput: Record<string, any> | undefined): AskQuestion[] {
  const raw = toolInput?.questions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q) => q && typeof q.question === 'string' && Array.isArray(q.options))
    .map((q) => ({
      question: String(q.question),
      header: typeof q.header === 'string' ? q.header : undefined,
      multiSelect: Boolean(q.multiSelect),
      options: q.options
        .filter((o: any) => o && typeof o.label === 'string')
        .map((o: any) => ({
          label: String(o.label),
          description: typeof o.description === 'string' ? o.description : undefined,
          preview: typeof o.preview === 'string' ? o.preview : undefined,
        })),
    }));
}

// Format the user's AskUserQuestion answers into a hook response. We deny
// the tool call and feed the answer back as the deny reason — Claude Code
// cancels the native AskUserQuestion tool (we don't want its in-terminal UI
// to run) and Claude reads the reason as the user's answer and proceeds.
// Only PreToolUse fires for AskUserQuestion (it's a tool call, not a
// permission dialog), so we always emit the PreToolUse shape.
function buildAskQuestionResponse(
  prompt: PermissionPrompt,
  answers: string[][]
): Record<string, any> {
  const questions = prompt.questions || [];
  const lines: string[] = [];

  questions.forEach((q, i) => {
    const picked = answers[i] || [];
    const header = q.header ? `[${q.header}] ` : '';
    lines.push(`${header}${q.question}`);
    if (picked.length === 0) {
      lines.push('  (no answer)');
    } else {
      for (const p of picked) lines.push(`  → ${p}`);
    }
  });

  const reason = `User answered AskUserQuestion in web UI:\n${lines.join('\n')}`;
  return buildDenyBody('PreToolUse', reason);
}

export type PermissionDecision = 'allow' | 'deny' | 'always-allow';

export class PermissionManager extends EventEmitter {
  private pending = new Map<string, PendingPermission>();
  private autoDeferTools: Set<string>;
  // Per-session "always allow" rules: sessionId -> set of tool names
  private sessionAllowList = new Map<string, Set<string>>();

  constructor(extraAutoDeferTools: string[] = []) {
    super();
    this.autoDeferTools = new Set([...AUTO_DEFER_TOOLS, ...extraAutoDeferTools]);
  }

  addAutoDeferTool(toolName: string): void {
    this.autoDeferTools.add(toolName);
  }

  setAutoDeferTools(tools: string[]): void {
    this.autoDeferTools = new Set([...AUTO_DEFER_TOOLS, ...tools]);
  }

  /**
   * Handle a PreToolUse hook call. Either auto-approves or holds the response open.
   */
  handlePreToolUse(
    hookData: { tool_name: string; tool_input: Record<string, any>; session_id: string },
    res: Response,
    sessionId: string,
    cwd: string
  ): void {
    this.handleHook('PreToolUse', hookData, res, sessionId, cwd);
  }

  /**
   * Handle a PermissionRequest hook call. This fires when Claude Code is about
   * to show its built-in permission dialog (e.g. for paths outside cwd) —
   * sometimes for tool calls that PreToolUse already approved. We surface the
   * same Allow/Deny card to the web UI and reply with the PermissionRequest
   * response shape (`hookSpecificOutput.decision.behavior`) when the user picks.
   */
  handlePermissionRequest(
    hookData: { tool_name: string; tool_input: Record<string, any>; session_id: string },
    res: Response,
    sessionId: string,
    cwd: string
  ): void {
    this.handleHook('PermissionRequest', hookData, res, sessionId, cwd);
  }

  private handleHook(
    eventName: HookEventName,
    hookData: { tool_name: string; tool_input: Record<string, any>; session_id: string },
    res: Response,
    sessionId: string,
    cwd: string
  ): void {
    const { tool_name, tool_input, session_id: claudeSessionId } = hookData;
    const input = tool_input || {};

    // AskUserQuestion is a structured question payload, not a permission
    // gate. Don't auto-defer or auto-allow it — always surface to the web UI
    // so we can render a proper radio/checkbox interface. (Only meaningful
    // for PreToolUse; PermissionRequest never fires for AskUserQuestion.)
    const isAskQuestion = tool_name === 'AskUserQuestion';

    // Auto-defer safe read-only tools — but only when the path argument
    // (if any) resolves inside the session cwd. Paths outside cwd (e.g.
    // attachment uploads in ~/.local/share/multitable/...) get surfaced to
    // the web UI so the user can explicitly approve them.
    const insideCwd = pathInsideCwd(tool_name, input, cwd);

    if (!isAskQuestion && this.autoDeferTools.has(tool_name) && insideCwd) {
      res.json(buildAllowBody(eventName));
      return;
    }

    // Honor prior "always allow" decisions for this session + tool. These
    // ignore the cwd check — the user explicitly opted in for this tool.
    if (!isAskQuestion && this.sessionAllowList.get(sessionId)?.has(tool_name)) {
      res.json(buildAllowBody(eventName));
      return;
    }

    // Dedup: if an identical prompt is already pending for this session,
    // attach this HTTP response to it instead of creating a second card.
    const dedupKey = makeDedupKey(sessionId, tool_name, input);
    for (const entry of this.pending.values()) {
      if (entry.dedupKey === dedupKey) {
        entry.responders.push({ res, eventName });
        return;
      }
    }

    const id = uuidv4();
    const prompt: PermissionPrompt = {
      id,
      sessionId,
      claudeSessionId: claudeSessionId || '',
      toolName: tool_name,
      toolInput: input,
      createdAt: Date.now(),
      ...(isAskQuestion
        ? {
            kind: 'ask-question' as const,
            questions: parseAskQuestions(input),
          }
        : { kind: 'permission' as const }),
    };

    this.pending.set(id, {
      prompt,
      responders: [{ res, eventName }],
      sdkResolvers: [],
      sessionId,
      dedupKey,
    });
    this.emit('permission:prompt', prompt);
  }

  /**
   * Respond to a pending permission prompt.
   */
  respond(id: string, decision: PermissionDecision, updatedInput?: Record<string, any>): void {
    const entry = this.pending.get(id);
    if (!entry) return;

    this.pending.delete(id);

    if (decision === 'always-allow') {
      let set = this.sessionAllowList.get(entry.sessionId);
      if (!set) {
        set = new Set<string>();
        this.sessionAllowList.set(entry.sessionId, set);
      }
      set.add(entry.prompt.toolName);
    }

    const approved = decision === 'allow' || decision === 'always-allow';
    if (approved) {
      sendAll(entry, (eventName) => buildAllowBody(eventName, updatedInput));
      resolveAllSdk(entry, { kind: 'allow', updatedInput: updatedInput ?? entry.prompt.toolInput });
    } else {
      sendAll(entry, (eventName) => buildDenyBody(eventName));
      resolveAllSdk(entry, { kind: 'deny', message: 'Denied by user' });
    }

    this.emit('permission:resolved', id);
  }

  /**
   * Respond to a pending AskUserQuestion prompt with the user's selections.
   * `answers` is parallel to `prompt.questions` — one string array per
   * question containing the selected option labels.
   */
  respondAskQuestion(id: string, answers: string[][]): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    if (entry.prompt.kind !== 'ask-question') {
      // Fall back to plain approve; caller used the wrong method.
      this.respond(id, 'allow');
      return;
    }

    this.pending.delete(id);

    const body = buildAskQuestionResponse(entry.prompt, answers);
    sendAll(entry, () => body);

    // SDK side: AskUserQuestion arrives via canUseTool. The SDK reads the
    // `message` of a deny result as the tool result string, so we serialize
    // the user's selections into JSON and deny — Claude reads the JSON and
    // proceeds with the answer. Mirrors the CLI buildAskQuestionResponse
    // semantics (deny + reason = answer) on the SDK side.
    const askPayload = {
      questions: (entry.prompt.questions || []).map((q, i) => ({
        question: q.question,
        header: q.header,
        answer: answers[i] || [],
      })),
    };
    let askJson: string;
    try {
      askJson = JSON.stringify(askPayload);
    } catch {
      askJson = String(askPayload);
    }
    resolveAllSdk(entry, { kind: 'deny', message: askJson });

    this.emit('permission:resolved', id);
  }

  getPending(): PermissionPrompt[] {
    return Array.from(this.pending.values()).map(e => e.prompt);
  }

  getPendingById(id: string): PermissionPrompt | null {
    return this.pending.get(id)?.prompt ?? null;
  }

  hasPending(sessionId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  clearForSession(sessionId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.sessionId === sessionId) {
        sendAll(entry, (eventName) => buildAllowBody(eventName));
        // SDK side: deny pending Promises with a descriptive message so the
        // SDK's tool call fails cleanly rather than silently allowing after
        // the session is gone.
        resolveAllSdk(entry, { kind: 'deny', message: 'Session cleared' });
        this.pending.delete(id);
        this.emit('permission:resolved', id);
      }
    }
    this.sessionAllowList.delete(sessionId);
  }

  /**
   * SDK entry point: invoked from AgentSessionManager.makeCanUseTool when the
   * Claude Agent SDK's canUseTool callback fires. Mirrors handleHook semantics
   * (auto-defer for read-only tools inside cwd, sessionAllowList honor, dedup
   * across in-flight prompts, 110s auto-allow timeout) but resolves a Promise
   * carrying the SDK PermissionResult shape instead of writing to an Express
   * response.
   *
   * NOTE: this duplicates the auto-defer / allowlist / dedup logic from
   * handleHook rather than sharing a refactored helper. The HTTP path's
   * responder model is tightly coupled to per-eventName response shapes
   * (PreToolUse vs PermissionRequest); restructuring it before Phase 6 (which
   * deletes the HTTP path entirely) risks regressions for marginal benefit.
   * Will consolidate when the HTTP path goes away.
   */
  async requestFromSdk(
    sessionId: string,
    claudeSessionId: string,
    toolName: string,
    toolInput: Record<string, any>,
    signal: AbortSignal,
    extras?: PermissionExtras
  ): Promise<PermissionResult> {
    const input = toolInput || {};
    const isAskQuestion = toolName === 'AskUserQuestion';

    // Bail immediately if the caller is already aborted — don't even build a
    // prompt; the SDK is unwinding and the for-await will exit.
    if (signal.aborted) {
      return { behavior: 'deny', message: 'Cancelled' };
    }

    // Resolve cwd for the path-scope check. We have the multitable session id
    // here but not the workingDirectory directly; look it up via dynamic
    // import to avoid a static cycle (db/store.ts is fine to require lazily
    // — it's already imported by the rest of the daemon at startup).
    let cwd = '';
    try {
      const { getSessionById } = await import('../db/store.js');
      cwd = sessionId ? getSessionById(sessionId)?.workingDirectory ?? '' : '';
    } catch {
      cwd = '';
    }

    // Auto-defer: identical rules to handleHook. AskUserQuestion is never
    // auto-deferred; it always surfaces a structured prompt.
    const insideCwd = pathInsideCwd(toolName, input, cwd);
    if (!isAskQuestion && this.autoDeferTools.has(toolName) && insideCwd) {
      return { behavior: 'allow', updatedInput: input };
    }

    // sessionAllowList: same honor rules.
    if (!isAskQuestion && this.sessionAllowList.get(sessionId)?.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }

    // Dedup: attach to an existing pending prompt with the same key.
    const dedupKey = makeDedupKey(sessionId, toolName, input);
    for (const entry of this.pending.values()) {
      if (entry.dedupKey === dedupKey) {
        return new Promise<PermissionResult>((resolve) => {
          this.attachSdkResolver(signal, entry, resolve);
        });
      }
    }

    // Build a fresh prompt and broadcast it so the UI can render the card.
    const id = uuidv4();
    const prompt: PermissionPrompt = {
      id,
      sessionId,
      claudeSessionId: claudeSessionId || '',
      toolName,
      toolInput: input,
      createdAt: Date.now(),
      ...(isAskQuestion
        ? {
            kind: 'ask-question' as const,
            questions: parseAskQuestions(input),
          }
        : { kind: 'permission' as const }),
      ...(extras?.title ? { title: extras.title } : {}),
      ...(extras?.displayName ? { displayName: extras.displayName } : {}),
      ...(extras?.subtitle ? { subtitle: extras.subtitle } : {}),
      ...(extras?.blockedPath ? { blockedPath: extras.blockedPath } : {}),
    };

    const entry: PendingPermission = {
      prompt,
      responders: [],
      sdkResolvers: [],
      sessionId,
      dedupKey,
    };
    this.pending.set(id, entry);

    return new Promise<PermissionResult>((resolve) => {
      this.attachSdkResolver(signal, entry, resolve);
      this.emit('permission:prompt', prompt);
    });
  }

  /**
   * Push an SDK resolver onto an in-flight prompt and wire its AbortSignal so
   * a turn cancellation deny-resolves this Promise (with `message: 'Cancelled'`)
   * and removes the resolver from the entry. If the entry has no remaining
   * subscribers (no SDK Promises, no HTTP responders) after an abort, drop the
   * prompt and emit `permission:resolved` so the UI clears its card.
   */
  private attachSdkResolver(
    signal: AbortSignal,
    entry: PendingPermission,
    resolve: (r: PermissionResult) => void
  ): void {
    const sdkResolve: SdkResolver = (decision) => resolve(decisionToResult(decision));
    const onAbort = () => {
      const idx = entry.sdkResolvers.findIndex((r) => r.resolve === sdkResolve);
      if (idx >= 0) entry.sdkResolvers.splice(idx, 1);
      resolve({ behavior: 'deny', message: 'Cancelled' });
      if (entry.sdkResolvers.length === 0 && entry.responders.length === 0) {
        if (this.pending.get(entry.prompt.id) === entry) {
          this.pending.delete(entry.prompt.id);
          this.emit('permission:resolved', entry.prompt.id);
        }
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const abortCleanup = () => signal.removeEventListener('abort', onAbort);
    entry.sdkResolvers.push({ resolve: sdkResolve, abortCleanup });
  }
}

function decisionToResult(decision: SdkDecision): PermissionResult {
  if (decision.kind === 'allow') {
    return { behavior: 'allow', updatedInput: decision.updatedInput };
  }
  return { behavior: 'deny', message: decision.message };
}
