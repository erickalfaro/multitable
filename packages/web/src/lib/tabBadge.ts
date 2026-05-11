// Reflect unread alert count in the browser tab title and favicon. Cleared
// when the tab regains focus. The user is allowed to mute this via prefs in
// Phase 10 (showCenterBadge → controls both tab badge and StatusBar bell badge).

const BASE_TITLE = 'MultiTable';

let originalTitle = BASE_TITLE;
let originalFaviconHref: string | null = null;
let badgedFaviconUrl: string | null = null;

function findFaviconLink(): HTMLLinkElement | null {
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]');
  return links.length > 0 ? links[links.length - 1] : null;
}

function generateBadgeFavicon(count: number): string {
  // 32x32 canvas with a red dot bottom-right showing the unread count.
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Background — soft rounded square so the dot reads as overlay rather than full image.
  ctx.fillStyle = '#1f2937';
  ctx.beginPath();
  const r = 6;
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#fafafa';
  ctx.font = 'bold 16px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('mt', size / 2, size / 2 - 1);

  // Badge dot
  const dotR = 9;
  const cx = size - dotR + 1;
  const cy = size - dotR + 1;
  ctx.fillStyle = '#ef4444';
  ctx.beginPath();
  ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'white';
  ctx.font = 'bold 11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(count > 9 ? '9+' : String(count), cx, cy + 1);

  return canvas.toDataURL('image/png');
}

export function updateTabBadge(unreadCount: number): void {
  if (typeof document === 'undefined') return;

  if (originalTitle === BASE_TITLE && document.title) {
    // Capture whatever the page initially set, in case it isn't 'MultiTable'.
    originalTitle = document.title.replace(/^\(\d+\)\s+/, '') || BASE_TITLE;
  }

  document.title = unreadCount > 0 ? `(${unreadCount > 99 ? '99+' : unreadCount}) ${originalTitle}` : originalTitle;

  const link = findFaviconLink();
  if (!link) return;
  if (originalFaviconHref === null) originalFaviconHref = link.href;

  if (unreadCount > 0) {
    if (!badgedFaviconUrl || link.dataset.mtBadgeCount !== String(unreadCount)) {
      badgedFaviconUrl = generateBadgeFavicon(unreadCount);
      link.dataset.mtBadgeCount = String(unreadCount);
      if (badgedFaviconUrl) link.href = badgedFaviconUrl;
    }
  } else if (originalFaviconHref) {
    link.href = originalFaviconHref;
    delete link.dataset.mtBadgeCount;
    badgedFaviconUrl = null;
  }
}
