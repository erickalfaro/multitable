# Cursor models & discovery

## `cursor-agent models`

Prints a plain-text list (no `--json` flag), e.g.:

```
Available models

auto - Auto
composer-2.5 - Composer 2.5 (current, default)
gpt-5.5-high - GPT-5.5 1M High
claude-opus-4-7-thinking-max - Opus 4.7 1M Max Thinking
…

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
```

`discoverCursor` (in `providers/discovery.ts`) runs `cursor-agent models`, then:

- Skips the `Available models` header and the trailing `Tip:` line and blanks.
- Parses each `id - Display Name` line on the **first** ` - ` separator.
- Strips a trailing ` (current, default)` / ` (default)` marker from the display
  name and sets `isDefault: true` for that row.
- Sets `supportsEffort: false` for every row — **effort is encoded in the id**
  (`-low`/`-high`/`-xhigh`/`-thinking-…`/`-fast`), not a separate knob.

100+ models are returned; the picker lists them all. `composer-2.5` is the
current default.

## Baseline (`CURSOR_BASELINE`)

Seeds the picker before/if discovery hasn't run. Holds a small headline set
(`composer-2.5` default, plus a couple of well-known ids). Live discovery
replaces it; if `cursor-agent models` fails, the baseline shows through (catalog
keeps the baseline when discovery returns `[]`).

## Effort is in the model id

There is no cross-provider effort flag for Cursor. `capabilities.thinkingEffort
= 'unsupported'`; the UI renders the effort toggle disabled. To use a higher
tier the user picks a higher-tier model id (e.g. `gpt-5.5-extra-high`).
