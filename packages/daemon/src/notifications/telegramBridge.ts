import type { PermissionManager } from '../hooks/permissionManager.js';
import type { AgentSessionManager } from '../agent/manager.js';
import type { PermissionPrompt } from '../types.js';
import type { SessionAlert } from '../agent/types.js';
import { tgCall, type TgUpdate, type TgCallbackQuery, type InlineKeyboardMarkup } from './telegramApi.js';
import {
  formatPermissionPrompt,
  buildPermissionKeyboard,
  formatAskQuestion,
  buildAskQuestionKeyboard,
  applyAskQuestionToggle,
  stateToAnswers,
  formatNotificationPayload,
  formatAlert,
  appendFooter,
} from './telegramFormat.js';

export interface TelegramBridgeOptions {
  token: string;
  chatIds: number[];
  sendNotifications: boolean;
  sendAlerts: boolean;
  // When set, permission/notification messages include an "Open in dashboard"
  // URL button pointing at <dashboardUrl>/#permission=<id> (or
  // <dashboardUrl>/#session=<id> for notifications). Empty string disables
  // the deep-link button entirely.
  dashboardUrl: string;
  permManager: PermissionManager;
  agentManager: AgentSessionManager;
}

interface MessageRef {
  chatId: number;
  messageId: number;
}

interface PromptRecord {
  prompt: PermissionPrompt;
  refs: MessageRef[];
  // Persisted HTML body so resolution-time edits can append a footer below
  // the original content rather than rewriting it from scratch.
  baseHtml: string;
  // For ask-question prompts: per-question selection state.
  askState?: Map<number, Set<number>>;
}

const POLL_TIMEOUT_SECS = 25;

export class TelegramBridge {
  private opts: TelegramBridgeOptions;
  private pending = new Map<string, PromptRecord>();
  private offset = 0;
  private pollAbort: AbortController | null = null;
  private pollPromise: Promise<void> | null = null;
  private listeners: Array<{ emitter: any; event: string; fn: (...args: any[]) => void }> = [];
  private running = false;

  constructor(opts: TelegramBridgeOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    if (!this.opts.token) {
      console.log('[telegram] disabled (no token configured)');
      return;
    }
    this.running = true;

    // Outbound listeners only attach when chatIds is non-empty — there's
    // nowhere to send to otherwise. The poll loop runs regardless so the
    // user can DM /chatid to discover their chat ID before anything is
    // allowlisted (otherwise it's a chicken-and-egg setup).
    if (this.opts.chatIds.length > 0) {
      this.attach(this.opts.permManager, 'permission:prompt', (p: PermissionPrompt) => {
        this.onPermissionPrompt(p).catch((err) => console.error('[telegram] onPermissionPrompt:', err));
      });
      this.attach(this.opts.permManager, 'permission:resolved', (id: string) => {
        this.onPermissionEnded(id, 'resolved').catch((err) =>
          console.error('[telegram] onPermissionResolved:', err),
        );
      });
      this.attach(this.opts.permManager, 'permission:expired', (id: string) => {
        this.onPermissionEnded(id, 'expired').catch((err) =>
          console.error('[telegram] onPermissionExpired:', err),
        );
      });

      if (this.opts.sendNotifications) {
        this.attach(this.opts.agentManager, 'notification', (ev: { sessionId: string; payload: unknown }) => {
          this.onNotification(ev).catch((err) => console.error('[telegram] onNotification:', err));
        });
      }
      if (this.opts.sendAlerts) {
        this.attach(this.opts.agentManager, 'alert', (ev: { alert: SessionAlert }) => {
          this.onAlert(ev).catch((err) => console.error('[telegram] onAlert:', err));
        });
      }
    }

    this.pollAbort = new AbortController();
    this.pollPromise = this.pollLoop(this.pollAbort.signal);

    if (this.opts.chatIds.length === 0) {
      console.log('[telegram] discovery mode (no chatIds yet — DM the bot /chatid to find yours)');
    } else {
      console.log(`[telegram] bridge started (chatIds=${this.opts.chatIds.join(',')})`);
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const l of this.listeners) {
      try {
        l.emitter.off(l.event, l.fn);
      } catch {}
    }
    this.listeners = [];
    if (this.pollAbort) this.pollAbort.abort();
    if (this.pollPromise) {
      try {
        await this.pollPromise;
      } catch {}
    }
    this.pollAbort = null;
    this.pollPromise = null;
  }

  /**
   * Hot-reload the bridge with new options (token, chatIds, toggles). Stops
   * the current poll loop / listener set, swaps options, and re-starts. Used
   * by the /api/integrations PUT handler so the user doesn't have to restart
   * the daemon to pick up a new token. The pending-prompts map is preserved
   * across the swap so any in-flight Telegram message refs survive.
   */
  async reconfigure(opts: TelegramBridgeOptions): Promise<void> {
    await this.stop();
    this.opts = opts;
    this.offset = 0;
    this.start();
  }

  isRunning(): boolean {
    return this.running;
  }

  private attach(emitter: any, event: string, fn: (...args: any[]) => void): void {
    emitter.on(event, fn);
    this.listeners.push({ emitter, event, fn });
  }

  // ─── Outbound: prompt arrived ────────────────────────────────────────────

  private async onPermissionPrompt(prompt: PermissionPrompt): Promise<void> {
    const sessionLabel = this.sessionLabel(prompt.sessionId);
    const isAsk = prompt.kind === 'ask-question';

    let html: string;
    let keyboard: InlineKeyboardMarkup;
    let askState: Map<number, Set<number>> | undefined;

    const url = this.opts.dashboardUrl;
    if (isAsk) {
      askState = new Map<number, Set<number>>();
      html = formatAskQuestion(prompt, askState, sessionLabel);
      keyboard = buildAskQuestionKeyboard(prompt, askState, url);
    } else {
      html = formatPermissionPrompt(prompt, sessionLabel);
      keyboard = buildPermissionKeyboard(prompt.id, url);
    }

    const refs: MessageRef[] = [];
    for (const chatId of this.opts.chatIds) {
      const sent = await tgCall<{ message_id: number; chat: { id: number } }>(
        this.opts.token,
        'sendMessage',
        {
          chat_id: chatId,
          text: html,
          parse_mode: 'HTML',
          reply_markup: keyboard,
          disable_web_page_preview: true,
        },
      );
      if (sent) refs.push({ chatId: sent.chat.id, messageId: sent.message_id });
    }

    if (refs.length === 0) return;
    this.pending.set(prompt.id, { prompt, refs, baseHtml: html, askState });
  }

  // ─── Outbound: prompt resolved or expired ────────────────────────────────

  private async onPermissionEnded(id: string, kind: 'resolved' | 'expired'): Promise<void> {
    const rec = this.pending.get(id);
    if (!rec) return;
    this.pending.delete(id);

    const footerText = kind === 'expired' ? '⏱ Timed out — auto-allowed' : '↩︎ Resolved';
    const newHtml = appendFooter(rec.baseHtml, { text: footerText });
    await this.editAll(rec.refs, newHtml);
  }

  private async editAll(refs: MessageRef[], html: string): Promise<void> {
    for (const ref of refs) {
      await tgCall(this.opts.token, 'editMessageText', {
        chat_id: ref.chatId,
        message_id: ref.messageId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    }
  }

  // ─── Outbound: notifications and alerts ──────────────────────────────────

  private async onNotification(ev: { sessionId: string; payload: unknown }): Promise<void> {
    const html = formatNotificationPayload(ev.payload, this.sessionLabel(ev.sessionId));
    await this.broadcast(html, this.sessionDeepLink(ev.sessionId));
  }

  private async onAlert(ev: { alert: SessionAlert }): Promise<void> {
    // Permission-category alerts are already covered by the permission flow.
    if (ev.alert.category === 'permission') return;
    const html = formatAlert(ev.alert, this.sessionLabel(ev.alert.sessionId));
    await this.broadcast(html, this.sessionDeepLink(ev.alert.sessionId));
  }

  private sessionDeepLink(sessionId: string): InlineKeyboardMarkup | undefined {
    if (!this.opts.dashboardUrl) return undefined;
    return {
      inline_keyboard: [
        [
          {
            text: '\u{1F4F1} Open in dashboard',
            url: `${this.opts.dashboardUrl}/#session=${sessionId}`,
          },
        ],
      ],
    };
  }

  private async broadcast(html: string, replyMarkup?: InlineKeyboardMarkup): Promise<void> {
    for (const chatId of this.opts.chatIds) {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };
      if (replyMarkup) body.reply_markup = replyMarkup;
      await tgCall(this.opts.token, 'sendMessage', body);
    }
  }

  // ─── Inbound: poll loop ──────────────────────────────────────────────────

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const updates = await tgCall<TgUpdate[]>(
        this.opts.token,
        'getUpdates',
        {
          offset: this.offset,
          timeout: POLL_TIMEOUT_SECS,
          allowed_updates: ['message', 'callback_query'],
        },
        signal,
        (POLL_TIMEOUT_SECS + 5) * 1000,
      );
      if (signal.aborted) return;
      if (!updates) {
        // Network or API error; back off briefly.
        await sleep(2000, signal);
        continue;
      }
      for (const u of updates) {
        this.offset = Math.max(this.offset, u.update_id + 1);
        if (u.callback_query) {
          await this.handleCallbackQuery(u.callback_query);
        } else if (u.message?.text) {
          await this.handleTextMessage(u.message.chat.id, u.message.from?.id ?? 0, u.message.text);
        }
      }
    }
  }

  private async handleTextMessage(chatId: number, fromId: number, text: string): Promise<void> {
    const t = text.trim();
    const isCommand = t === '/start' || t === '/chatid' || t === '/help';

    if (!isCommand) {
      // Be helpful for any other text so the user isn't stuck guessing.
      await tgCall(this.opts.token, 'sendMessage', {
        chat_id: chatId,
        text: 'Send <code>/chatid</code> to see this chat\'s ID, then add it to MultiTable → Settings → Integrations.',
        parse_mode: 'HTML',
      });
      return;
    }

    const allowed = this.opts.chatIds.includes(chatId);
    const status = allowed
      ? '✅ This chat is authorized — permission prompts and notifications will arrive here.'
      : '⚠️ This chat is NOT yet authorized.';
    const body = [
      `<b>MultiTable Telegram bridge</b>`,
      ``,
      `<b>Chat ID:</b> <code>${chatId}</code>`,
      `<b>Your user ID:</b> <code>${fromId}</code>`,
      ``,
      status,
      allowed
        ? ''
        : `To authorize: open MultiTable → click the gear in the status bar (or <code>Ctrl+,</code>) → <b>Integrations</b> → paste <code>${chatId}</code> into "Authorized chat IDs" → Save. No daemon restart needed.`,
    ]
      .filter(Boolean)
      .join('\n');

    await tgCall(this.opts.token, 'sendMessage', {
      chat_id: chatId,
      text: body,
      parse_mode: 'HTML',
    });
  }

  private async handleCallbackQuery(cbq: TgCallbackQuery): Promise<void> {
    const data = cbq.data ?? '';
    const chatId = cbq.message?.chat.id ?? 0;

    if (!this.opts.chatIds.includes(chatId)) {
      await tgCall(this.opts.token, 'answerCallbackQuery', {
        callback_query_id: cbq.id,
        text: 'Unauthorized',
        show_alert: true,
      });
      return;
    }

    const parts = data.split(':');
    const kind = parts[0];

    if (kind === 'perm') {
      await this.handlePermCallback(cbq, parts);
      return;
    }
    if (kind === 'aqt') {
      await this.handleAskToggle(cbq, parts);
      return;
    }
    if (kind === 'aqs') {
      await this.handleAskSubmit(cbq, parts);
      return;
    }
    if (kind === 'aqc') {
      await this.handleAskCancel(cbq, parts);
      return;
    }
    if (kind === 'aqh') {
      // Header separator row in multi-question prompts — purely visual.
      await tgCall(this.opts.token, 'answerCallbackQuery', {
        callback_query_id: cbq.id,
      });
      return;
    }

    await tgCall(this.opts.token, 'answerCallbackQuery', {
      callback_query_id: cbq.id,
      text: 'Unknown action',
    });
  }

  private async handlePermCallback(cbq: TgCallbackQuery, parts: string[]): Promise<void> {
    const promptId = parts[1];
    const action = parts[2];
    const rec = this.pending.get(promptId);
    if (!rec) {
      await tgCall(this.opts.token, 'answerCallbackQuery', {
        callback_query_id: cbq.id,
        text: 'Already resolved',
      });
      return;
    }

    let decision: 'allow' | 'deny' | 'always-allow';
    let ack: string;
    if (action === 'allow') {
      decision = 'allow';
      ack = 'Approved';
    } else if (action === 'deny') {
      decision = 'deny';
      ack = 'Denied';
    } else if (action === 'always') {
      decision = 'always-allow';
      ack = 'Always allowed';
    } else {
      await tgCall(this.opts.token, 'answerCallbackQuery', {
        callback_query_id: cbq.id,
        text: 'Bad action',
      });
      return;
    }

    await tgCall(this.opts.token, 'answerCallbackQuery', {
      callback_query_id: cbq.id,
      text: ack,
    });
    // Pre-empt the resolution edit so the user sees who acted; the
    // permission:resolved listener will further append the canonical footer.
    const stamped = appendFooter(rec.baseHtml, { text: `${ack} via Telegram` });
    rec.baseHtml = stamped;
    await this.editAll(rec.refs, stamped);

    try {
      this.opts.permManager.respond(promptId, decision);
    } catch (err) {
      console.error('[telegram] permManager.respond failed:', err);
    }
  }

  private async handleAskToggle(cbq: TgCallbackQuery, parts: string[]): Promise<void> {
    const promptId = parts[1];
    const qIdx = Number(parts[2]);
    const optIdx = Number(parts[3]);
    const rec = this.pending.get(promptId);
    if (!rec || rec.prompt.kind !== 'ask-question' || !rec.askState) {
      await tgCall(this.opts.token, 'answerCallbackQuery', {
        callback_query_id: cbq.id,
        text: 'Already resolved',
      });
      return;
    }

    applyAskQuestionToggle(rec.prompt.questions ?? [], rec.askState, qIdx, optIdx);
    const sessionLabel = this.sessionLabel(rec.prompt.sessionId);
    const newHtml = formatAskQuestion(rec.prompt, rec.askState, sessionLabel);
    rec.baseHtml = newHtml;
    const newKb = buildAskQuestionKeyboard(rec.prompt, rec.askState);

    await tgCall(this.opts.token, 'answerCallbackQuery', { callback_query_id: cbq.id });
    for (const ref of rec.refs) {
      await tgCall(this.opts.token, 'editMessageText', {
        chat_id: ref.chatId,
        message_id: ref.messageId,
        text: newHtml,
        parse_mode: 'HTML',
        reply_markup: newKb,
        disable_web_page_preview: true,
      });
    }
  }

  private async handleAskSubmit(cbq: TgCallbackQuery, parts: string[]): Promise<void> {
    const promptId = parts[1];
    const rec = this.pending.get(promptId);
    if (!rec || rec.prompt.kind !== 'ask-question' || !rec.askState) {
      await tgCall(this.opts.token, 'answerCallbackQuery', {
        callback_query_id: cbq.id,
        text: 'Already resolved',
      });
      return;
    }

    const answers = stateToAnswers(rec.prompt.questions ?? [], rec.askState);
    await tgCall(this.opts.token, 'answerCallbackQuery', {
      callback_query_id: cbq.id,
      text: 'Submitted',
    });
    const stamped = appendFooter(rec.baseHtml, { text: 'Submitted via Telegram' });
    rec.baseHtml = stamped;
    await this.editAll(rec.refs, stamped);

    try {
      this.opts.permManager.respondAskQuestion(promptId, answers);
    } catch (err) {
      console.error('[telegram] permManager.respondAskQuestion failed:', err);
    }
  }

  private async handleAskCancel(cbq: TgCallbackQuery, parts: string[]): Promise<void> {
    const promptId = parts[1];
    const rec = this.pending.get(promptId);
    if (!rec) {
      await tgCall(this.opts.token, 'answerCallbackQuery', {
        callback_query_id: cbq.id,
        text: 'Already resolved',
      });
      return;
    }
    await tgCall(this.opts.token, 'answerCallbackQuery', {
      callback_query_id: cbq.id,
      text: 'Cancelled',
    });
    const stamped = appendFooter(rec.baseHtml, { text: 'Cancelled via Telegram' });
    rec.baseHtml = stamped;
    await this.editAll(rec.refs, stamped);

    try {
      // Cancelling AskUserQuestion = answer with no selections, which the
      // hook serializes as "(no answer)" and Claude reads as the user's reply.
      this.opts.permManager.respondAskQuestion(promptId, []);
    } catch (err) {
      console.error('[telegram] permManager.respondAskQuestion (cancel) failed:', err);
    }
  }

  private sessionLabel(sessionId: string): string {
    const s = this.opts.agentManager.get(sessionId);
    return s?.name || sessionId.slice(0, 8);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
