---
name: prior-art-reference
description: Standing pointer to the broader landscape of open-source agent harnesses, meta-harnesses, governance layers, multi-agent orchestrators, and usage/cost observability sidecars that solve problems adjacent to MultiTable. **Consult proactively** when (a) the user explicitly names a project — Mastra, OpenHarness, "Microsoft Agent Governance Toolkit", Cordum, CrewAI, LangGraph, "Strands Agents", "Harness SDK", VoltAgent, MetaGPT, ruflo, "Claude Flow", artificial (the Go harness), "Claude Squad", OpenCode (sst/opencode), Archon, CodexBar, awesome-agent-harness, awesome-harness-engineering, "9 open-source agent orchestrators" — or asks "is there an OSS project that does X", "what's prior art for Y", "similar projects to MultiTable", "harness comparison", "agent governance frameworks", "meta-harness", "multi-agent orchestrator", "cross-provider usage limits", "menu-bar usage tracker"; **AND ALSO** (b) work is stuck on a persistent bug that's resisted two or more fix attempts in an area covered by the parallels table (provider adapters, permission/governance, multi-agent, parallel-agent isolation, model catalog, usage limits, sandboxing, workflow templates, observability); (c) scoping a non-trivial new feature in any of those areas — read this *before* designing rather than after; (d) hitting an unfamiliar protocol/wire-shape question that another harness has likely already solved. Reference only — not a provider, not implying any port.
allowed-tools: Read, Grep, Glob, Bash, WebFetch
---

# prior-art-reference

A curated directory of ~16 open-source projects that overlap with MultiTable's problem space: unified harnesses over multiple AI coding agents, governance/policy layers, parallel-agent isolation, and multi-agent orchestration. Future sessions consult this skill **before** designing a new feature, to check what comparable projects already do.

This skill is a **standing pointer**. It is **reference only** — read it to compare and steal ideas at the design level, not to port code. Any decision to copy code is a separate, case-by-case decision and is *not* implied by this skill loading.

The dedicated [`omnigent-reference`](../omnigent-reference/SKILL.md) skill handles MultiTable's closest single sibling (omnigent-ai/omnigent) at much greater depth. This skill is the broader landscape around it.

## When to consult this skill proactively

The skill exists so MultiTable doesn't re-derive solved problems. **Reach for it freely** — don't wait for the user to name a project. Three concrete triggers:

### 1. Persistent bug (two or more failed fix attempts)

If you've tried to fix a bug twice and it's still broken — especially in an area another harness has clearly solved (per [`reference/parallels.md`](reference/parallels.md)) — stop and check prior art before a third attempt. Likely candidates:

- Permission/approval flow bugs → OpenHarness, Microsoft Agent Governance Toolkit, omnigent
- Streaming/delta accounting bugs → Mastra, OpenCode, the provider whose protocol you're adapting
- Session resume / persistence bugs → omnigent, LangGraph (checkpointing), Mastra (threads)
- Parallel-session isolation bugs → Claude Squad (git-worktree-per-agent)
- Usage-limit / rate-limit parsing bugs → **CodexBar** (53+ providers)

Pull the relevant project's source via `WebFetch` or `gh api`, find the analogous code path, and compare. A second design point almost always exposes the assumption you missed.

### 2. Complex new feature

Before writing a non-trivial feature in any concept area listed in [`reference/parallels.md`](reference/parallels.md), read what the listed projects already do. This is cheap (1–2 `WebFetch` calls) and shapes the design — don't ship a v1 that the existing harnesses already iterated past. Mention what you found to the user as part of the plan, with project names cited.

### 3. Unfamiliar protocol / wire-shape question

If MultiTable is about to integrate a new transport, parse a new event stream, or implement a new gating mechanism, the odds are high that one of these projects already faced it. Search their repos first; you may save a day.

In all three cases: cite each project by name, don't blend concepts (see pitfalls), and remember — this skill authorizes *reading* their code for inspiration, not porting it. Any decision to copy code is a separate, case-by-case call.

## Strict isolation note

- These projects are **external prior art**, not MultiTable providers. There is no Mastra/CrewAI/LangGraph adapter under `packages/daemon/src/agent/providers/`, and there shouldn't be — adding one is a separate user-directed decision, not something this skill authorizes.
- Never blend concepts from multiple projects into a single recommendation as if they were one design. Cite each source by name when you reference it.
- URLs decay. Before quoting current behavior (APIs, feature lists, license terms), verify with `WebFetch` against the URLs in [`reference/projects.md`](reference/projects.md) or `gh api repos/<owner>/<repo>`.

## Quick task → file map

| What you want | Read |
|---|---|
| The full project list with TL;DRs and URLs | [`reference/projects.md`](reference/projects.md) |
| MultiTable concept → which projects to consult | [`reference/parallels.md`](reference/parallels.md) |
| Mis-uses and cautions | [`pitfalls.md`](pitfalls.md) |

## Decision tree: where do I look?

```
"Is there an OSS project that does <X>?"
├── Which MultiTable concept does <X> map to? ───── reference/parallels.md
├── Need the project's URL, TL;DR, or relevance ─── reference/projects.md
└── Want to read the actual source                ─── reference/projects.md → URL → WebFetch / gh api
```

## When to *not* use this skill

- The user is working on an existing MultiTable provider (Claude, Codex, Hermes, Grok, Cursor). Use that provider's dedicated skill instead.
- The user is asking how omnigent specifically does something — use [`omnigent-reference`](../omnigent-reference/SKILL.md).
- The user is asking about Claude API / Anthropic SDK semantics — use `claude-api` or `claude-agent-sdk`.
