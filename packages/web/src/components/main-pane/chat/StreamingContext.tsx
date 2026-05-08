import { createContext, useContext } from 'react';

// Read by CodeBlock to decide whether to invoke shiki right now.
// Streaming code fences re-render every ~16ms while text accumulates; running
// async shiki on each pass races (stale highlight applied to fresher code)
// and the fallback <pre> visibly flickers as setHtml() lands. While streaming
// we render plain themed monospace and skip shiki entirely; when the canonical
// message lands (streaming === false on a stable element), shiki runs once
// and the swap is atomic.
export const StreamingContext = createContext<boolean>(false);

export function useIsStreaming(): boolean {
  return useContext(StreamingContext);
}
