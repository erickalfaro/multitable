const PREFIX = 'multitable:composer-draft:';
const SAVE_DEBOUNCE_MS = 200;

const pending = new Map<string, ReturnType<typeof setTimeout>>();

function key(processId: string): string {
  return PREFIX + processId;
}

export function loadDraft(processId: string): string {
  try {
    return localStorage.getItem(key(processId)) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(processId: string, text: string): void {
  const existing = pending.get(processId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pending.delete(processId);
    try {
      if (text.length === 0) {
        localStorage.removeItem(key(processId));
      } else {
        localStorage.setItem(key(processId), text);
      }
    } catch {
      // Quota / disabled storage — silently give up; the draft is best-effort.
    }
  }, SAVE_DEBOUNCE_MS);
  pending.set(processId, timer);
}

export function clearDraft(processId: string): void {
  const existing = pending.get(processId);
  if (existing) {
    clearTimeout(existing);
    pending.delete(processId);
  }
  try {
    localStorage.removeItem(key(processId));
  } catch {
    // ignore
  }
}

const TITLE_MAX = 60;

/**
 * Derive a note title from prompt text: the first non-empty line, stripped of
 * leading markdown markers (#, -, *, >, "1.") and clamped to ~60 chars. Falls
 * back to a timestamped label when the text has no usable line.
 */
export function firstLineTitle(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) {
    return `Prompt ${new Date().toLocaleString()}`;
  }
  const cleaned = line.replace(/^(#{1,6}\s+|[-*>]\s+|\d+\.\s+)/, '').trim() || line;
  return cleaned.length > TITLE_MAX ? cleaned.slice(0, TITLE_MAX - 1).trimEnd() + '…' : cleaned;
}

export function flushDraft(processId: string, text: string): void {
  const existing = pending.get(processId);
  if (existing) {
    clearTimeout(existing);
    pending.delete(processId);
  }
  try {
    if (text.length === 0) {
      localStorage.removeItem(key(processId));
    } else {
      localStorage.setItem(key(processId), text);
    }
  } catch {
    // ignore
  }
}
