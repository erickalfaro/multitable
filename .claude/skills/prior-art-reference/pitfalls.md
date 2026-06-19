# Pitfalls when using this skill

## Reference only — not a provider

These projects are external prior art. **Never add an adapter under `packages/daemon/src/agent/providers/` for one of them without explicit user direction**, even if the user mentions one in passing. Skill loading does not authorize a port. The provider roster is the live set in `agent/manager.ts` (Claude, Codex, Hermes, Grok, Cursor) plus the `comingSoon` modal entries — extending it is a separate, scoped decision.

## URLs and feature claims decay

The TL;DRs in [`reference/projects.md`](reference/projects.md) are snapshots — APIs change, repos move, license terms shift, projects get archived. Before quoting current behavior to the user:

1. `WebFetch` the github URL (or the homepage for Archon / the augmentcode writeup).
2. For deeper paths, `gh api repos/<owner>/<repo>/contents/<path>` for a directory listing, or `gh api repos/<owner>/<repo>` for metadata + topics + stars.

If a URL 404s, say so explicitly and stop — don't guess a replacement.

## Don't blend concepts across projects

When the user asks "how should we design feature X?", cite each project by name when you reference it (e.g. "Mastra's `Harness` does it via... whereas Claude Squad uses git worktrees..."). Smearing concepts together loses the trace back to a verifiable source.

## Meta-list resources are starting points, not endorsements

`awesome-agent-harness`, `awesome-harness-engineering`, and the augmentcode writeup are **directories**. A project being listed in them does not imply quality, alignment with MultiTable's design, or even that the repo is still maintained. Use them to discover candidates, then evaluate each one independently before recommending.

## Use the dedicated provider skills for current MultiTable code

If the user is asking how *MultiTable* does something (not how another harness does it), this skill is the wrong entry point. Use:

- `claude-agent-sdk` — Claude provider depth.
- `openai-codex-sdk` — Codex provider depth.
- `hermes-grok` — Hermes provider depth.
- `grok-build` — Grok Build provider depth.
- `cursor-cli` — Cursor provider depth.
- `github-copilot-sdk` — Copilot (still `comingSoon`).
- `omnigent-reference` — the single closest external sibling, has its own file-level parallels table.

## Don't propose `docs/reference/` entries for these projects

`docs/reference/` is for *MultiTable's* spec/architecture (OVERVIEW.md, SPEC.md, integration plans). External prior art belongs in this skill folder, mirroring the omnigent-reference layout. Don't sprawl it into the main docs tree.
