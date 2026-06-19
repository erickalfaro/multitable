---
name: omnigent-reference
description: Standing pointer to the external `omnigent-ai/omnigent` project — MultiTable's closest prior-art / sibling. Trigger when the user mentions omnigent, omni, omnigent-ai, "compare to omnigent", "how does omnigent do X", `claude_native.py` / `codex_native.py` / `cursor_native.py` / `pi_native.py`, omnigent's `runner/` / `server/` / `policies/`, omnigent policy engine, omnigent governance, omnigent host registry / presence / attach / co-drive, omnigent cloud sandbox (Modal / Daytona / Islo), or wants a side-by-side of an omnigent concept against MultiTable.
allowed-tools: Read, Grep, Glob, Bash, WebFetch
---

# omnigent-reference

`omnigent-ai/omnigent` is an open-source Python (~83%) + TypeScript (~16%) framework that solves a problem almost identical to MultiTable's: a unified harness over multiple AI coding agents (Claude Code, Codex, Cursor, Pi, custom), with session sync, multi-agent supervision, governance policies, and cloud sandboxes. MultiTable is the user's variation of that same problem, written in Node/TS.

This skill is a **standing pointer** so future sessions don't re-derive omnigent's structure from scratch every time. It is **reference only** — read it to compare, not to port. Any decision to copy code is a separate, case-by-case decision and is *not* implied by this skill loading.

## Strict isolation note

- omnigent is **external prior art**, not a MultiTable provider. There is no omnigent adapter under `packages/daemon/src/agent/providers/`, and there shouldn't be.
- Never blend omnigent concepts (`runner/`, `policies/`, `host_registry`) into MultiTable code commentary as if they were ours. When citing omnigent, use a full `omnigent/...` path and (where useful) a github URL from [`reference/sources.md`](reference/sources.md).
- Don't repeat their `claude_native.py` subprocess-bridging pattern in our code — we deliberately retired that approach (see [`/home/erick/Documents/multitable/CLAUDE.md`](../../../CLAUDE.md) "Recently retired").

## Quick task → file map

| What you want | Read |
|---|---|
| Top-down directory map of the omnigent repo | [`reference/repo-map.md`](reference/repo-map.md) |
| MultiTable concept ↔ omnigent file/dir comparison | [`reference/parallels.md`](reference/parallels.md) |
| Cautions, license, and architectural divergences | [`reference/caveats-and-license.md`](reference/caveats-and-license.md) |
| Canonical github URLs to browse | [`reference/sources.md`](reference/sources.md) |
| Mistakes / mis-mappings to avoid | [`pitfalls.md`](pitfalls.md) |

## Decision tree: where do I look?

```
"How does omnigent do <X>?"
├── Where does <X> physically live in their repo? ───── reference/repo-map.md
├── Which of our files is the analogue?          ───── reference/parallels.md
├── How do they differ in stack/architecture?    ───── reference/caveats-and-license.md
└── I want to read the actual source           ───── reference/sources.md → github URL → WebFetch / gh api
```

## Reading omnigent source

For one-off file reads, use the github URL pattern in [`reference/sources.md`](reference/sources.md) with `WebFetch`, or `gh api repos/omnigent-ai/omnigent/contents/<path>` for a directory listing. Don't try to clone or install omnigent locally for this purpose.
