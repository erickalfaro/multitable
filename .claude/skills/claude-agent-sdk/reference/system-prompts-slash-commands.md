# System prompts and slash commands

Anthropic docs: https://docs.claude.com/en/api/agent-sdk/modifying-system-prompts • https://docs.claude.com/en/api/agent-sdk/slash-commands

## `systemPrompt` — four forms

| Form | Effect |
|---|---|
| Omitted | Use the SDK's default (a small built-in prompt — NOT the Claude Code preset) |
| `'You are...'` (string) | Replace the system prompt entirely with this string |
| `{ type: 'preset', preset: 'claude_code' }` | Use the full Claude Code preset (the same one the `claude` CLI uses) |
| `{ type: 'preset', preset: 'claude_code', append: '...' }` | Preset + extra instructions tacked on the end |
| `{ type: 'preset', preset: 'claude_code', append: '...', excludeDynamicSections: true }` | Preset + append, but strip dynamic sections (working dir, git status, env metadata) — see below |

## When to use `excludeDynamicSections`

The Claude Code preset includes dynamic sections that change per turn (current working directory, git status, environment info). Those changes invalidate the prompt cache.

For workflows where:
- The same system prompt should be reusable across many sessions (e.g., a workflow agent that runs hundreds of times)
- You want maximum cache reuse

Set `excludeDynamicSections: true`. The dynamic info moves into the first user message instead. Tradeoff: the model may not have the env context it expects baked into the system prompt — but in practice, putting it in the first user message works fine and the cache savings can be large.

Available since SDK v0.2.98 (TS) / v0.1.58 (Python). Our pinned 0.2.119 supports it.

MultiTable currently does NOT set `systemPrompt`. The SDK ships with the right default for our case.

## `settingSources` — loading filesystem settings

```ts
settingSources: ('user' | 'project' | 'local')[]
```

- `'user'` → `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, `~/.claude/commands/`, `~/.claude/skills/`
- `'project'` → `<cwd>/CLAUDE.md`, `<cwd>/.claude/settings.json`, `<cwd>/.claude/commands/`, `<cwd>/.claude/skills/`
- `'local'` → `<cwd>/.claude/settings.local.json` (gitignored personal overrides)

Pass `[]` to fully isolate from filesystem. We use `['project', 'user']` ([`agent/manager.ts:284`](../../../../packages/daemon/src/agent/manager.ts)) — the project's CLAUDE.md and the user's home CLAUDE.md both flow into the agent's system prompt. We deliberately exclude `'local'` because daemons shouldn't pick up developer-specific overrides.

## CLAUDE.md

The de-facto memory file. Format is plain markdown; no frontmatter required. Loaded into the system prompt when `settingSources` includes the appropriate scope.

The repo's [`CLAUDE.md`](../../../../CLAUDE.md) is the source of truth for project-level conventions. Anything you'd want every Claude Code session in this repo to know goes there.

## Slash commands

Two flavors:

**Built-in slash commands** — discoverable via `system.init.slash_commands`:

```ts
for await (const msg of query({ prompt: '/help', options })) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    console.log(msg.data.slash_commands);
    // ['/compact', '/context', '/usage', '/init', '/cost', '/clear', ...]
  }
}
```

These are intercepted by the Claude Code preset itself. They land as plain prompt text from MultiTable's perspective, which is why we don't surface them in the composer (the model would just see "/init" as text and likely confused).

**Custom slash commands** — markdown files at `<cwd>/.claude/commands/<name>.md` or `~/.claude/commands/<name>.md`. The SDK reads the file when the user types `/<name>`. Format:

```markdown
---
description: Refactor selected code for readability
allowed-tools: Read, Edit, Write
---

Refactor the code at $ARGUMENTS for readability:
- Variable naming clarity
- Function decomposition
- DRY
```

`$ARGUMENTS` is substituted with whatever the user typed after the command name.

MultiTable's composer offers `@`-mention completion and `/`-command completion. The slash-completion source merges:

1. Project commands from `<cwd>/.claude/commands/*.md` (highest rank)
2. User commands from `~/.claude/commands/*.md`
3. MultiTable-native built-ins intercepted client-side in `ChatInputCM`'s `handleNativeSlash` — currently `/clear` and `/cost`

To add a new MultiTable-native built-in: intercept in `handleNativeSlash`, then add it to `BUILTIN_SLASH_COMMANDS` in [`packages/web/src/lib/cm-completions.ts`](../../../../packages/web/src/lib/cm-completions.ts).

We deliberately don't surface built-in TUI commands like `/model`, `/compact`, `/init` because the SDK doesn't intercept them and they'd land as plain text.

## Plugins

The SDK supports `Options.plugins: SdkPluginConfig[]` for loading plugin directories. We don't use this.

## Common mistakes

- **Loading `'local'` settings sources from the daemon.** Then developer overrides leak into shared sessions. Stick to `['project', 'user']`.
- **Forgetting to set `excludeDynamicSections` for cache-heavy workloads.** The dynamic sections evict the cache every turn.
- **Surfacing built-in slash commands like `/model` in the composer.** They look right but turn into plain prompt text. Either intercept them in `handleNativeSlash` and translate to a real action, or hide them.
