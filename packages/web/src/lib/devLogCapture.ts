// Browser-level error capture for the in-app DevLog. Wraps the global
// error handlers and the noisy console methods so anything the app emits
// (or anything an unhandled exception bubbles past us) shows up in the
// DevLog panel.

import { devLog } from './devLog';

let installed = false;

function describe(value: unknown): { label: string; data: unknown } {
  if (value instanceof Error) {
    return {
      label: value.message || value.name,
      data: { name: value.name, message: value.message, stack: value.stack },
    };
  }
  if (typeof value === 'string') return { label: value, data: value };
  try {
    return { label: JSON.stringify(value), data: value };
  } catch {
    return { label: String(value), data: undefined };
  }
}

export function installDevLogCapture(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (evt) => {
    const { label, data } = describe(evt.error ?? evt.message);
    devLog.add({
      category: 'error',
      label: `window.error: ${label}`,
      detail:
        evt.filename && typeof evt.lineno === 'number'
          ? `${evt.filename}:${evt.lineno}:${evt.colno ?? 0}`
          : undefined,
      data,
    });
  });

  window.addEventListener('unhandledrejection', (evt) => {
    const { label, data } = describe(evt.reason);
    devLog.add({
      category: 'error',
      label: `unhandledrejection: ${label}`,
      data,
    });
  });

  // Tee console.error/warn so messages emitted from anywhere (libraries,
  // our own code, React) end up in the DevLog as well as the browser
  // console. We deliberately don't tee console.log — too noisy.
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    devLog.add({
      category: 'error',
      label:
        args.length === 0
          ? 'console.error'
          : typeof args[0] === 'string'
            ? args[0]
            : describe(args[0]).label,
      data: args.length === 1 ? args[0] : args,
    });
    origError(...args);
  };

  const origWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    devLog.add({
      category: 'warn',
      label:
        args.length === 0
          ? 'console.warn'
          : typeof args[0] === 'string'
            ? args[0]
            : describe(args[0]).label,
      data: args.length === 1 ? args[0] : args,
    });
    origWarn(...args);
  };
}
