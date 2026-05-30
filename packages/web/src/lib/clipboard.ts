/**
 * Cross-environment clipboard copy. The async Clipboard API is only
 * available in secure contexts (HTTPS or localhost). LAN access over
 * plain HTTP — which is how MultiTable is often used from a phone on
 * the same network — falls back to a hidden textarea + execCommand.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Read clipboard text via the async Clipboard API. Returns null when the API
 * is unavailable or rejects — notably in non-secure contexts (LAN access over
 * plain HTTP), where `navigator.clipboard` is undefined. There is NO silent
 * fallback for reading (browsers block `execCommand('paste')`); callers should
 * fall back to `promptManualPaste()` on null.
 */
export async function readClipboard(): Promise<string | null> {
  try {
    if (navigator.clipboard?.readText && window.isSecureContext) {
      return await navigator.clipboard.readText();
    }
  } catch {}
  return null;
}

/**
 * Manual paste fallback for non-secure contexts. Shows a focused textarea
 * overlay and resolves with whatever the user pastes (mobile: long-press →
 * Paste; desktop: Ctrl/Cmd+V) or types. Resolves null if cancelled. This is
 * the only reliable way to get clipboard text when the Clipboard API is blocked.
 */
export function promptManualPaste(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Paste text');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'padding:16px',
      'background:rgba(0,0,0,0.55)',
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'width:100%',
      'max-width:420px',
      'display:flex',
      'flex-direction:column',
      'gap:10px',
      'padding:16px',
      'border-radius:var(--radius-snug, 8px)',
      'border:1px solid var(--border-strong, #444)',
      'background:var(--bg-elevated, #1e1e1e)',
      'color:var(--text-primary, #eee)',
      'font-family:inherit',
      'box-shadow:0 12px 40px rgba(0,0,0,0.45)',
    ].join(';');

    const label = document.createElement('div');
    label.textContent = 'Paste here (Ctrl/Cmd+V or long-press → Paste), then Send';
    label.style.cssText = 'font-size:12.5px;color:var(--text-muted, #aaa)';

    const textarea = document.createElement('textarea');
    textarea.rows = 4;
    textarea.autocapitalize = 'off';
    textarea.autocomplete = 'off';
    textarea.spellcheck = false;
    textarea.style.cssText = [
      'width:100%',
      'resize:vertical',
      'padding:8px',
      'border-radius:var(--radius-snug, 6px)',
      'border:1px solid var(--border-strong, #444)',
      'background:var(--bg-primary, #111)',
      'color:var(--text-primary, #eee)',
      'font-family:var(--font-mono, monospace)',
      'font-size:13px',
      'box-sizing:border-box',
    ].join(';');

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

    const mkBtn = (text: string, primary: boolean) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.style.cssText = [
        'height:34px',
        'padding:0 14px',
        'border-radius:var(--radius-snug, 6px)',
        'font-family:inherit',
        'font-size:12.5px',
        'font-weight:500',
        'cursor:pointer',
        `border:1px solid ${primary ? 'var(--accent, #3b82f6)' : 'var(--border-strong, #444)'}`,
        `background:${primary ? 'var(--accent, #3b82f6)' : 'var(--bg-elevated, #1e1e1e)'}`,
        `color:${primary ? 'var(--accent-fg, #fff)' : 'var(--text-primary, #eee)'}`,
      ].join(';');
      return b;
    };
    const cancelBtn = mkBtn('Cancel', false);
    const sendBtn = mkBtn('Send', true);
    buttons.append(cancelBtn, sendBtn);

    panel.append(label, textarea, buttons);
    overlay.append(panel);

    const cleanup = () => {
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
    };
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        finish(textarea.value ? textarea.value : null);
      }
    };

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) finish(null);
    });
    cancelBtn.addEventListener('click', () => finish(null));
    sendBtn.addEventListener('click', () => finish(textarea.value ? textarea.value : null));
    document.addEventListener('keydown', onKeyDown, true);

    document.body.append(overlay);
    // Defer focus so mobile keyboards reliably attach to the new node.
    requestAnimationFrame(() => textarea.focus());
  });
}
