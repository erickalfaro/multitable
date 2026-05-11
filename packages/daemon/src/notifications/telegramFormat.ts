import type { PermissionPrompt, AskQuestion } from '../types.js';
import type { SessionAlert } from '../agent/types.js';
import type { InlineKeyboardMarkup, InlineKeyboardButton } from './telegramApi.js';

const MAX_INLINE_LEN = 64;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function formatToolInputBlock(toolInput: Record<string, any>): string {
  let json: string;
  try {
    json = JSON.stringify(toolInput, null, 2);
  } catch {
    json = String(toolInput);
  }
  return `<pre>${escapeHtml(truncate(json, 1200))}</pre>`;
}

export function formatPermissionPrompt(prompt: PermissionPrompt, sessionLabel: string): string {
  const header = prompt.title || prompt.displayName || `${prompt.toolName} requested`;
  const subtitle = prompt.subtitle ? `\n<i>${escapeHtml(truncate(prompt.subtitle, 200))}</i>` : '';
  const blocked = prompt.blockedPath
    ? `\n<b>Blocked path:</b> <code>${escapeHtml(truncate(prompt.blockedPath, 300))}</code>`
    : '';

  return [
    `\u{1F916} <b>${escapeHtml(sessionLabel)}</b>`,
    `<b>${escapeHtml(header)}</b>${subtitle}`,
    `<b>Tool:</b> <code>${escapeHtml(prompt.toolName)}</code>${blocked}`,
    formatToolInputBlock(prompt.toolInput),
  ].join('\n');
}

export function buildPermissionKeyboard(
  promptId: string,
  dashboardUrl?: string,
): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [
    [
      cb('✅ Approve', `perm:${promptId}:allow`),
      cb('❌ Deny', `perm:${promptId}:deny`),
    ],
    [cb('✅✅ Always allow', `perm:${promptId}:always`)],
  ];
  if (dashboardUrl) {
    rows.push([urlButton('\u{1F4F1} Open in dashboard', `${dashboardUrl}/#permission=${promptId}`)]);
  }
  return { inline_keyboard: rows };
}

export function formatAskQuestion(
  prompt: PermissionPrompt,
  state: Map<number, Set<number>>,
  sessionLabel: string,
): string {
  const questions = prompt.questions ?? [];
  const lines: string[] = [`\u{1F4AC} <b>${escapeHtml(sessionLabel)}</b> asks:`];
  questions.forEach((q, i) => {
    const header = q.header ? `<i>${escapeHtml(q.header)}</i>\n` : '';
    const qText = `<b>${escapeHtml(q.question)}</b>`;
    const mode = q.multiSelect ? ' <i>(pick any)</i>' : ' <i>(pick one)</i>';
    const picked = state.get(i);
    const summary =
      picked && picked.size > 0
        ? '\n  → ' +
          [...picked]
            .map((idx) => escapeHtml(q.options[idx]?.label ?? '?'))
            .join(', ')
        : '';
    lines.push('', `${header}${qText}${mode}${summary}`);
  });
  return lines.join('\n');
}

export function buildAskQuestionKeyboard(
  prompt: PermissionPrompt,
  state: Map<number, Set<number>>,
  dashboardUrl?: string,
): InlineKeyboardMarkup {
  const questions = prompt.questions ?? [];
  const rows: InlineKeyboardButton[][] = [];
  const multipleQuestions = questions.length > 1;
  questions.forEach((q, qIdx) => {
    // When there are multiple questions, prefix each block with a header
    // row so the user can tell where one question's options end and the
    // next one's begin. The header is a non-actionable separator (we
    // answer the callback with no action). Single-question prompts skip
    // the separator — it would just be visual noise.
    if (multipleQuestions) {
      const headerLabel = q.header
        ? `── ${q.header.toUpperCase()} ──`
        : `── Question ${qIdx + 1} ──`;
      rows.push([cb(truncate(headerLabel, 60), `aqh:${prompt.id}:${qIdx}`)]);
    }
    const picked = state.get(qIdx) ?? new Set<number>();
    q.options.forEach((opt, optIdx) => {
      const mark = picked.has(optIdx) ? '✅' : '⬜';
      const label = truncate(`${mark} ${opt.label}`, 60);
      rows.push([cb(label, `aqt:${prompt.id}:${qIdx}:${optIdx}`)]);
    });
  });
  rows.push([
    cb('\u{1F4E4} Submit', `aqs:${prompt.id}`),
    cb('❌ Cancel', `aqc:${prompt.id}`),
  ]);
  if (dashboardUrl) {
    rows.push([
      urlButton('\u{1F4F1} Open in dashboard', `${dashboardUrl}/#permission=${prompt.id}`),
    ]);
  }
  return { inline_keyboard: rows };
}

export function applyAskQuestionToggle(
  questions: AskQuestion[],
  state: Map<number, Set<number>>,
  qIdx: number,
  optIdx: number,
): void {
  const q = questions[qIdx];
  if (!q) return;
  let set = state.get(qIdx);
  if (!set) {
    set = new Set<number>();
    state.set(qIdx, set);
  }
  if (q.multiSelect) {
    if (set.has(optIdx)) set.delete(optIdx);
    else set.add(optIdx);
  } else {
    set.clear();
    set.add(optIdx);
  }
}

export function stateToAnswers(
  questions: AskQuestion[],
  state: Map<number, Set<number>>,
): string[][] {
  return questions.map((q, qIdx) => {
    const picked = state.get(qIdx) ?? new Set<number>();
    return [...picked].map((idx) => q.options[idx]?.label ?? '').filter((s) => s.length > 0);
  });
}

export function formatNotificationPayload(payload: unknown, sessionLabel: string): string {
  const i = (payload ?? {}) as Record<string, unknown>;
  const title = typeof i.title === 'string' && i.title ? i.title : 'Notification';
  const body = typeof i.message === 'string' ? i.message : '';
  const head = `\u{1F514} <b>${escapeHtml(sessionLabel)}</b>\n<b>${escapeHtml(title)}</b>`;
  return body ? `${head}\n${escapeHtml(truncate(body, 1500))}` : head;
}

export function formatAlert(alert: SessionAlert, sessionLabel: string): string {
  const icon = severityIcon(alert.severity);
  const head = `${icon} <b>${escapeHtml(sessionLabel)}</b>\n<b>${escapeHtml(alert.title)}</b>`;
  return alert.body ? `${head}\n${escapeHtml(truncate(alert.body, 1500))}` : head;
}

function severityIcon(sev: SessionAlert['severity']): string {
  switch (sev) {
    case 'success':
      return '✅';
    case 'warning':
      return '⚠️';
    case 'error':
      return '\u{1F6A8}';
    case 'attention':
      return '\u{1F514}';
    case 'info':
    default:
      return 'ℹ️';
  }
}

function cb(text: string, data: string): InlineKeyboardButton {
  if (Buffer.byteLength(data, 'utf8') > MAX_INLINE_LEN) {
    throw new Error(`telegram callback_data too long (${data.length}): ${data.slice(0, 32)}…`);
  }
  return { text, callback_data: data };
}

function urlButton(text: string, url: string): InlineKeyboardButton {
  return { text, url };
}

export interface ResolutionFooter {
  text: string;
}

export function appendFooter(messageHtml: string, footer: ResolutionFooter): string {
  return `${messageHtml}\n\n<b>${escapeHtml(footer.text)}</b>`;
}
