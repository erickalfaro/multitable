// Build the `cursor-agent` argv for one headless turn. Cursor's mode/model are
// CLI flags on each (one-shot) invocation; effort is encoded in the model id, so
// there is no effort flag. See .claude/skills/cursor-cli/reference/modes.md.

export interface CursorArgsInput {
  mode: string;
  model: string | null;
  resumeId: string | null;
  prompt: string;
}

// MultiTable mode string → Cursor mode flags.
//   force   → --force            (run everything, no gating)
//   default → (none)             default permission mode (honors ~/.cursor allowlist)
//   plan    → --mode plan        read-only planning
//   ask     → --mode ask         read-only Q&A
function modeFlags(mode: string): string[] {
  switch (mode) {
    case 'force':
      return ['--force'];
    case 'plan':
      return ['--mode', 'plan'];
    case 'ask':
      return ['--mode', 'ask'];
    case 'default':
    default:
      return [];
  }
}

export function buildCursorArgs(input: CursorArgsInput): string[] {
  const args: string[] = [
    '--print',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    // Headless workspace trust — without this cursor-agent would block on the
    // interactive trust prompt (which can't be answered with no TTY).
    '--trust',
  ];
  args.push(...modeFlags(input.mode));
  if (input.model) args.push('--model', input.model);
  if (input.resumeId) args.push('--resume', input.resumeId);
  // The prompt is the trailing positional argument.
  args.push(input.prompt);
  return args;
}
