import React, { memo, useEffect, useMemo, useState, useRef } from 'react';
import { getHighlighter, normalizeLang, pickShikiTheme } from '../../../lib/shiki';
import { useAppStore } from '../../../stores/appStore';
import { BUILTIN_THEMES } from '../../../lib/themes';
import { useIsStreaming } from './StreamingContext';
import { CopyButton } from '../../ui';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Props {
  code: string;
  lang?: string;
}

// Renders a code block with shiki. Falls back to a plain <pre> until the
// highlighter has initialized (async WASM load on first use). Memoized so
// unrelated parent re-renders don't re-invoke shiki and re-apply innerHTML.
export const CodeBlock = memo(function CodeBlock({ code, lang }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const activeThemeId = useAppStore((s) => s.activeThemeId);
  const customThemes = useAppStore((s) => s.customThemes);
  const mountedRef = useRef(true);
  // While the surrounding assistant message is streaming, skip shiki entirely
  // and render the code as plain themed monospace. Async highlight on every
  // mutating `code` prop races (stale highlights flash, fallback <pre> blinks
  // as setHtml lands one frame behind). When the canonical message lands the
  // streaming bubble unmounts; the canonical bubble mounts with
  // `streaming === false` and shiki runs once, atomically.
  const isStreaming = useIsStreaming();

  useEffect(() => {
    if (isStreaming) return; // freeze: don't run shiki while text is mutating
    mountedRef.current = true;
    const all = [...BUILTIN_THEMES, ...customThemes];
    const active = all.find((t) => t.id === activeThemeId);
    const shikiTheme = pickShikiTheme(active?.isDark ?? true);
    const resolvedLang = normalizeLang(lang);

    getHighlighter()
      .then((hl) => {
        if (!mountedRef.current) return;
        try {
          const out = hl.codeToHtml(code, {
            lang: resolvedLang ?? 'text',
            theme: shikiTheme,
          });
          setHtml(out);
        } catch {
          setHtml(null);
        }
      })
      .catch(() => {
        if (mountedRef.current) setHtml(null);
      });

    return () => {
      mountedRef.current = false;
    };
  }, [code, lang, activeThemeId, customThemes, isStreaming]);

  // No frame and no left marker — the tinted background alone separates code
  // from surrounding prose. Padding lives on the inner pre / .mt-shiki pre.
  const wrapperStyle: React.CSSProperties = {
    position: 'relative',
    fontSize: 12,
    fontFamily: 'inherit',
    borderRadius: 'var(--radius-none)',
    backgroundColor: 'var(--bg-sidebar)',
    overflow: 'hidden',
    margin: '6px 0',
  };

  // Force the plain-pre branch while streaming, even if `html` was set on
  // a prior render (e.g. component reused across a stream→canonical
  // transition before unmount). Atomically swaps to highlighted on the
  // first render after streaming ends.
  const showHtml = !isStreaming && html;

  // Both modes resolve to a string of HTML rendered into the SAME inner
  // <div className="mt-scroll mt-shiki">. The element type, className, and
  // box geometry are identical between modes — only the inner glyphs
  // differ — so when shiki resolves async there is no element remount and
  // no padding change to visibly reflow the surrounding chat.
  // (The `.mt-shiki pre` rule in globals.css gives the inner pre its
  // 10px 16px padding in both cases.)
  const innerHtml = useMemo(() => {
    if (showHtml) return html as string;
    return `<pre style="color:var(--text-primary);white-space:pre;">${escapeHtml(code)}</pre>`;
  }, [showHtml, html, code]);

  return (
    <div
      style={wrapperStyle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        className="mt-scroll mt-shiki"
        style={{
          overflowX: 'auto',
          // iOS momentum scrolling so a code block scrolls naturally under
          // a touch flick rather than feeling stuck. No-op on non-WebKit.
          WebkitOverflowScrolling: 'touch',
          // Prevent the browser from absorbing horizontal swipes inside
          // the code block as a back-gesture / page scroll — the swipe
          // belongs to this scroll container.
          touchAction: 'pan-x pan-y',
        }}
        dangerouslySetInnerHTML={{ __html: innerHtml }}
      />
      <CopyButton
        variant="overlay"
        visible={hover}
        getText={code}
        title="Copy code"
        size={11}
        style={{ top: 6, right: 6 }}
      />
    </div>
  );
});
