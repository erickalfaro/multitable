// Telegram allows EITHER callback_data OR url on a button (mutually
// exclusive). callback_data routes back to our poll loop; url just opens
// in the user's browser (we never see the click). For deep-links we use
// url so the phone OS handles the open-in-browser behavior natively.
export type InlineKeyboardButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TgChat {
  id: number;
  type?: string;
}

export interface TgUser {
  id: number;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  date?: number;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

const API_BASE = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 15_000;

export async function tgCall<T = unknown>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T | null> {
  const url = `${API_BASE}/bot${token}/${method}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onParentAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = (await res.json()) as TgResponse<T>;
    if (!json.ok) {
      console.warn(`[telegram] ${method} failed: ${json.error_code ?? '?'} ${json.description ?? ''}`);
      return null;
    }
    return json.result ?? null;
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      console.warn(`[telegram] ${method} threw:`, err?.message ?? err);
    }
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }
}
