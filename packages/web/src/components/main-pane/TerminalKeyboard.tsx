import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { terminalManager } from '../../lib/terminalManager';
import { wsClient } from '../../lib/ws';

type TerminalKey = {
  label: string;
  input?: string;
  title?: string;
  action?: 'paste';
  kind?: 'modifier';
};

const KEYS: TerminalKey[] = [
  { label: 'Ctrl', kind: 'modifier', title: 'Sticky Control' },
  { label: 'Shift', kind: 'modifier', title: 'Sticky Shift' },
  { label: 'Esc', input: '\x1b' },
  { label: 'Tab', input: '\t' },
  { label: '^C', input: '\x03', title: 'Ctrl+C / interrupt' },
  { label: '^D', input: '\x04', title: 'Ctrl+D / EOF' },
  { label: '^Z', input: '\x1a', title: 'Ctrl+Z / suspend' },
  { label: '^L', input: '\x0c', title: 'Ctrl+L / clear screen' },
  { label: 'Paste', action: 'paste' },
  { label: 'Home', input: '\x1b[H' },
  { label: 'End', input: '\x1b[F' },
  { label: 'PgUp', input: '\x1b[5~' },
  { label: 'PgDn', input: '\x1b[6~' },
  { label: 'Up', input: '\x1b[A' },
  { label: 'Left', input: '\x1b[D' },
  { label: 'Down', input: '\x1b[B' },
  { label: 'Right', input: '\x1b[C' },
  { label: 'Ins', input: '\x1b[2~' },
  { label: 'Del', input: '\x1b[3~' },
  { label: 'Bksp', input: '\x7f', title: 'Backspace' },
  { label: 'Enter', input: '\r' },
  { label: '/', input: '/' },
  { label: '-', input: '-' },
  { label: '_', input: '_' },
  { label: '.', input: '.' },
  { label: '~', input: '~' },
  { label: '|', input: '|' },
  { label: 'Space', input: ' ' },
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((label) => ({
    label,
    input: label.toLowerCase(),
    title: `${label} / Ctrl+${label} with sticky Control`,
  })),
];

interface Props {
  processId: string;
}

interface Modifiers {
  ctrl: boolean;
  shift: boolean;
}

const SHIFTED_PRINTABLE: Record<string, string> = {
  '/': '?',
  '-': '_',
  '.': '>',
  ',': '<',
  ';': ':',
  "'": '"',
  '`': '~',
  '[': '{',
  ']': '}',
  '\\': '|',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
};

const CSI_FINALS = new Set(['A', 'B', 'C', 'D', 'F', 'H']);

function xtermModifierParam(modifiers: Modifiers) {
  return 1 + (modifiers.shift ? 1 : 0) + (modifiers.ctrl ? 4 : 0);
}

function withCsiModifiers(input: string, modifiers: Modifiers) {
  const modifierParam = xtermModifierParam(modifiers);
  if (modifierParam === 1) return input;

  if (input.length === 3 && input.startsWith('\x1b[') && CSI_FINALS.has(input[2])) {
    return `\x1b[1;${modifierParam}${input[2]}`;
  }

  if (input.startsWith('\x1b[') && input.endsWith('~')) {
    const params = input.slice(2, -1);
    if (params.length > 0 && /^\d+$/.test(params)) {
      return `\x1b[${params};${modifierParam}~`;
    }
  }

  return input;
}

function withPrintableModifiers(input: string, modifiers: Modifiers) {
  let value = input;

  if (modifiers.shift) {
    if (/^[a-z]$/.test(value)) {
      value = value.toUpperCase();
    } else {
      value = SHIFTED_PRINTABLE[value] ?? value;
    }
  }

  if (!modifiers.ctrl) return value;

  if (value === ' ') return '\x00';
  if (value === '/' || value === '_' || value === '?') return '\x1f';

  const upper = value.toUpperCase();
  const code = upper.charCodeAt(0);
  if (upper.length === 1 && code >= 64 && code <= 95) {
    return String.fromCharCode(code - 64);
  }

  return value;
}

function applyStickyModifiers(input: string, modifiers: Modifiers) {
  if (!modifiers.ctrl && !modifiers.shift) return input;
  if (input === '\t' && modifiers.shift) return '\x1b[Z';
  if (input === '\x7f' && modifiers.ctrl) return '\x17';
  if (input.startsWith('\x1b[')) return withCsiModifiers(input, modifiers);
  if (input.length === 1) return withPrintableModifiers(input, modifiers);
  return input;
}

export function TerminalKeyboard({ processId }: Props) {
  const [modifiers, setModifiers] = useState<Modifiers>({ ctrl: false, shift: false });

  const sendInput = (input: string) => {
    wsClient.sendInput(processId, input);
    terminalManager.focus(processId);
  };

  const clearModifiers = () => setModifiers({ ctrl: false, shift: false });

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendInput(text);
    } catch {
      toast.error('Clipboard access denied');
      terminalManager.focus(processId);
    }
  };

  const onPress = (key: TerminalKey) => {
    if (key.kind === 'modifier') {
      const modifier = key.label === 'Ctrl' ? 'ctrl' : 'shift';
      setModifiers((current) => ({
        ...current,
        [modifier]: !current[modifier],
      }));
      terminalManager.focus(processId);
      return;
    }

    if (key.action === 'paste') {
      void pasteFromClipboard();
      clearModifiers();
      return;
    }

    if (key.input !== undefined) {
      sendInput(applyStickyModifiers(key.input, modifiers));
      clearModifiers();
    }
  };

  const getLabelScale = (label: string) => {
    if (label.length >= 5) return 0.72;
    if (label.length >= 4) return 0.82;
    return 1;
  };

  return (
    <div className="terminal-keyboard mt-scroll" aria-label="Terminal keyboard">
      {KEYS.map((key) => {
        const isModifier = key.kind === 'modifier';
        const active = isModifier && (key.label === 'Ctrl' ? modifiers.ctrl : modifiers.shift);

        return (
          <button
            key={key.label}
            type="button"
            className={[
              'terminal-keyboard__key',
              active ? 'terminal-keyboard__key--active' : '',
            ].filter(Boolean).join(' ')}
            title={key.title ?? key.label}
            aria-label={key.title ?? key.label}
            aria-pressed={isModifier ? active : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPress(key)}
          >
            <span
              className="terminal-keyboard__label"
              style={{ ['--terminal-key-label-scale' as string]: getLabelScale(key.label) }}
            >
              {key.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
