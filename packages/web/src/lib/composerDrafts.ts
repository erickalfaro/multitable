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
