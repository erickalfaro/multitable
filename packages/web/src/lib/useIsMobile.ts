import { useSyncExternalStore } from 'react';

const MOBILE_BREAKPOINT = 768;

// One shared media-query listener for the whole app. The previous
// implementation registered a `resize` listener + setState PER HOOK INSTANCE —
// and this hook is called once per rendered chat message, so a desktop window
// resize fanned out to 150+ listeners each triggering a React update.
// matchMedia only notifies when the breakpoint boundary is actually crossed.
const query =
  typeof window !== 'undefined' ? window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`) : null;

function subscribe(callback: () => void): () => void {
  query?.addEventListener('change', callback);
  return () => query?.removeEventListener('change', callback);
}

function getSnapshot(): boolean {
  return query?.matches ?? false;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
