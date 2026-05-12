import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import type { ElicitationPrompt } from '../types.js';
import { trackedTimeout, type TrackedTimer } from '../devLog.js';

// Same rationale as PROMPT_TIMEOUT_MS in PermissionManager: the turn watchdog
// in AgentSessionManager re-arms while an elicitation is pending, so without
// an upper bound a forgotten URL-mode auth prompt (e.g. user signed in
// externally and never came back to click Done) holds the session "Running…"
// indefinitely. Auto-cancel after 10 minutes so the watchdog can fire.
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

export type ElicitAction = 'accept' | 'decline' | 'cancel';

export interface ElicitResponseContent {
  [key: string]: string | number | boolean | string[];
}

export interface ElicitResolution {
  action: ElicitAction;
  content?: ElicitResponseContent;
}

interface SdkRequest {
  serverName: string;
  message: string;
  mode?: 'form' | 'url';
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
}

interface Pending {
  prompt: ElicitationPrompt;
  resolve: (r: ElicitResolution) => void;
  abortCleanup?: () => void;
  expiryTimer: TrackedTimer;
}

/**
 * Holds open MCP elicitation requests until the UI responds. Mirrors the
 * shape of PermissionManager.requestFromSdk but simpler — there's no obvious
 * dedup/coalescing case for elicitations (each request is independent), so
 * one Pending per prompt is the model.
 */
export class ElicitationManager extends EventEmitter {
  private pending = new Map<string, Pending>();

  /**
   * Called by the SDK's onElicitation callback. Registers a prompt, emits
   * `elicitation:prompt`, and returns a Promise that resolves when the user
   * responds via respond() or the timeout / abort fires (auto-decline).
   */
  requestFromSdk(sessionId: string, request: SdkRequest, signal: AbortSignal): Promise<ElicitResolution> {
    const id = uuidv4();
    const prompt: ElicitationPrompt = {
      id,
      sessionId,
      serverName: request.serverName,
      message: request.message,
      mode: request.mode === 'url' ? 'url' : 'form',
      url: request.url,
      elicitationId: request.elicitationId,
      requestedSchema: request.requestedSchema,
      title: request.title,
      displayName: request.displayName,
      description: request.description,
      createdAt: Date.now(),
    };

    return new Promise<ElicitResolution>((resolve) => {
      const onAbort = () => {
        const p = this.pending.get(id);
        if (!p) return;
        p.expiryTimer.cancel();
        this.pending.delete(id);
        this.emit('elicitation:resolved', id);
        resolve({ action: 'cancel' });
      };
      signal.addEventListener('abort', onAbort);
      const abortCleanup = () => signal.removeEventListener('abort', onAbort);

      const expiryTimer = trackedTimeout(
        () => {
          const p = this.pending.get(id);
          if (!p) return;
          p.abortCleanup?.();
          this.pending.delete(id);
          this.emit('elicitation:expired', id);
          resolve({ action: 'cancel' });
        },
        {
          label: 'elicitation prompt expiry',
          ms: PROMPT_TIMEOUT_MS,
          category: 'elicitation',
          detail: `session ${sessionId.slice(0, 8)} · ${request.serverName}`,
          logFire: true,
          logCancel: true,
        },
      );

      this.pending.set(id, { prompt, resolve, abortCleanup, expiryTimer });
      this.emit('elicitation:prompt', prompt);
    });
  }

  /**
   * UI-side response handler. Resolves the held Promise; the SDK then sends
   * the action+content back to the MCP server.
   */
  respond(id: string, action: ElicitAction, content?: ElicitResponseContent): void {
    const p = this.pending.get(id);
    if (!p) return;
    p.abortCleanup?.();
    p.expiryTimer.cancel();
    this.pending.delete(id);
    this.emit('elicitation:resolved', id);
    p.resolve({ action, content });
  }

  /**
   * Drop everything for a session — invoked from AgentSessionManager.remove.
   */
  clearForSession(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.prompt.sessionId === sessionId) {
        p.abortCleanup?.();
        p.expiryTimer.cancel();
        this.pending.delete(id);
        this.emit('elicitation:resolved', id);
        p.resolve({ action: 'cancel' });
      }
    }
  }

  getAll(): ElicitationPrompt[] {
    return [...this.pending.values()].map((p) => p.prompt);
  }

  hasPending(sessionId: string): boolean {
    for (const p of this.pending.values()) {
      if (p.prompt.sessionId === sessionId) return true;
    }
    return false;
  }
}
