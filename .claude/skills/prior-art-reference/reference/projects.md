# Prior-art project directory

All URLs below are the ones the user supplied. Do not invent new paths; if you need a deeper path inside one of these repos, derive it via `WebFetch` or `gh api repos/<owner>/<repo>/contents/<path>`.

The "MultiTable relevance" line on each entry is what to check before designing the corresponding feature here.

---

## The closest match (has its own dedicated skill)

### omnigent
- URL: https://github.com/omnigent-ai/omnigent
- **TL;DR**: Open-source Python (~83%) + TypeScript (~16%) framework that solves a problem almost identical to MultiTable's: unified harness over multiple AI coding agents (Claude Code, Codex, Cursor, Pi, custom), with session sync, multi-agent supervision, governance policies, and cloud sandboxes (Modal / Daytona / Islo). MultiTable is the user's Node/TS variation of the same problem.
- **MultiTable relevance**: This is *the* sibling project — orders of magnitude closer than anything else on this page. **Do not consult it via this skill** — use the dedicated [`omnigent-reference`](../../omnigent-reference/SKILL.md) skill, which has a per-file repo map, a MultiTable↔omnigent parallels table, caveats/license notes, and a sources file. Listed here only so the directory is complete.

---

## Top closest matches (harness + governance focus)

### Mastra
- URL: https://github.com/mastra-ai/mastra
- **TL;DR**: TypeScript framework with a dedicated **Harness** primitive for persistent threads/sessions, tool approvals (human-in-the-loop), model switching, multi-mode agents, and sub-agents. Includes MastraCode (coding agent TUI) and explicit support for integrating other harnesses like Claude/Codex/Cursor. One of the closest conceptual matches.
- **MultiTable relevance**: Mastra's `Harness` primitive is the closest direct analogue to `AgentSession` + `ProviderAdapter`. Check it before redesigning session-lifecycle, tool-approval flows, or sub-agent semantics. Same language (TS), so API shapes transfer well at the design level.

### OpenHarness
- URL: https://github.com/HKUDS/OpenHarness
- **TL;DR**: Lightweight Python "open agent harness" (CLI-focused, ~80% of Claude Code functionality in far less code). Strong on governance (permissions, approvals, hooks), multi-agent coordination, subagent spawning, memory, and skills/plugins.
- **MultiTable relevance**: Reference for compact harness design — especially their permission/approval flow and hook system, both areas where MultiTable already has equivalents (`PermissionManager`, SDK hooks). Useful for sanity-checking that our shapes aren't over-engineered.

### Microsoft Agent Governance Toolkit
- URL: https://github.com/microsoft/agent-governance-toolkit
- **TL;DR**: Runtime governance/security layer for agents. Provides policy enforcement, sandboxing, pre-execution controls, approvals, audit trails, and zero-trust identity. Designed to layer on top of existing frameworks (CrewAI, LangChain, etc.). Excellent for the policy/governance side.
- **MultiTable relevance**: First place to check before adding policy/audit features (e.g. "log every tool call that touches X path"). They've solved the audit-trail and pre-execution-policy shape; we currently only have approval + sandbox modes.

### Cordum (Agent Control Plane)
- URL: https://github.com/cordum-io/cordum
- **TL;DR**: Open "agent control plane" for deterministic governance. Pre-execution policy enforcement, approval gates, and audit trails. Works across LangChain, CrewAI, MCP, and other frameworks.
- **MultiTable relevance**: Similar territory to the Microsoft toolkit — read alongside it. Their "control plane" framing maps to MultiTable's daemon role.

---

## Strong multi-agent orchestration frameworks

### CrewAI
- URL: https://github.com/crewaiinc/crewai
- **TL;DR**: Popular, mature open-source framework for orchestrating role-based autonomous AI agents that collaborate on tasks. Widely used in enterprise multi-agent setups.
- **MultiTable relevance**: Check before scoping any "agents-talking-to-agents" feature. MultiTable today is human-in-the-loop per session; CrewAI is the canonical reference for what a role/team model looks like if we ever go there.

### LangGraph (LangChain ecosystem)
- URL: https://github.com/langchain-ai/langgraph
- **TL;DR**: Graph-based framework for building complex, stateful multi-agent workflows and orchestration. Very flexible for production agent systems with cycles, persistence, and human-in-the-loop.
- **MultiTable relevance**: Reference for stateful workflow design — especially their persistence and human-in-the-loop checkpointing. MultiTable's session-event log + git-baseline-commit is a much thinner version of the same idea.

### Strands Agents (AWS) + Harness SDK
- URL: https://github.com/strands-agents/harness-sdk
- **TL;DR**: Model-driven open-source SDK (Python + TypeScript) for production-ready agents. Includes harness concepts, multi-agent patterns, model-agnostic support, and strong cloud deployment/observability focus.
- **MultiTable relevance**: AWS-backed harness with explicit "harness" naming; worth a side-by-side on observability and model-agnostic abstractions if we ever expand beyond the current five providers.

### VoltAgent
- URL: https://github.com/voltagent/voltagent
- **TL;DR**: TypeScript AI agent engineering platform/framework focused on supervisor-based multi-agent orchestration, declarative workflows, memory, and observability.
- **MultiTable relevance**: TS-native, observability-heavy — closest to MultiTable's stack. Check before adding metrics/observability dashboards.

### MetaGPT
- URL: https://github.com/foundationagents/metagpt
- **TL;DR**: Multi-agent framework that simulates an "AI software company" with specialized roles and structured collaboration for complex tasks (e.g., natural language programming).
- **MultiTable relevance**: More of a thought-experiment reference than a feature analogue — MultiTable is not role-simulating today.

---

## Meta-harnesses & adjacent

### ruflo (formerly Claude Flow)
- URL: https://github.com/ruvnet/ruflo
- **TL;DR**: Meta-harness for Claude, formerly Claude Flow. Deploys multi-agent swarms with self-learning memory, federated communication, and enterprise security on top of Claude Code / Codex. Built for coordinating 100+ specialized agents across machines and teams.
- **MultiTable relevance**: Closest "meta-harness layered on Claude Code" example. Worth comparing before scoping any feature about distributing sessions across machines or persistent cross-session memory.

### artificial
- URL: https://github.com/AndreBaltazar8/artificial
- **TL;DR**: Go-based multi-agent harness. Spawn and coordinate AI workers (Claude Code, Codex, Cursor Agent, ACP models, local LLMs) as a team with personas, a kanban task board, and inter-agent messaging, all managed from a real-time web dashboard or REST API.
- **MultiTable relevance**: Almost identical scope to MultiTable (web dashboard + REST + multi-provider), but Go-stack. Read for UX inspiration on the kanban + inter-agent messaging surfaces — both things MultiTable doesn't have.

### Claude Squad
- URL: https://github.com/smtg-ai/claude-squad
- **TL;DR**: TUI for running parallel coding agents on one laptop. Uses tmux for sessions and git worktrees for isolation so each agent works on its own branch. Supports Claude Code, Codex, Aider, Gemini, OpenCode, and Amp. Human-in-the-loop, no agent-to-agent communication.
- **MultiTable relevance**: Their **git-worktree-per-agent** isolation model is a real architectural option for MultiTable's parallel-session story. Check before designing anything that needs branch-level isolation.

### OpenCode
- URL: https://github.com/sst/opencode
- **TL;DR**: Open-source, terminal-native alternative to Claude Code. Provider-agnostic (75+ providers), LSP integration, and multi-session support so you can run several agents in parallel on the same project and switch models mid-session. More an open agent than a meta-harness.
- **MultiTable relevance**: 75+ providers is a useful catalog of *what's out there* if we ever expand `ProviderAdapter` registrations. Their LSP integration is something MultiTable lacks entirely.

### Archon
- TL;DR: Open-source harness builder for AI coding. Wraps Claude Code and Codex in deterministic, repeatable, YAML-defined workflows — describe what you want and it generates the harness, adding structure and an audit trail to otherwise freeform agent runs.
- **MultiTable relevance**: Workflow-builder framing is different from MultiTable's per-session model. Reference if we ever want declarative "saved playbooks" feature.
- **URL note**: The user did not supply a github URL for Archon; verify the canonical repo via `WebFetch` / `gh api search/repos` before linking.

---

## Status indicators / observability companions

### CodexBar
- URL: https://github.com/steipete/CodexBar
- **TL;DR**: macOS 14+ menu-bar app (Swift, ~15k stars) that monitors **usage limits, rate limits, and costs across 53+ AI coding providers** including OpenAI Codex, Claude, Cursor, Gemini. Displays provider quotas with countdown timers to reset windows, tracks spending via API dashboards + local log parsing, reuses existing browser sessions / API keys rather than storing credentials. Bundles a CLI for scripting.
- **MultiTable relevance**: Direct prior art for MultiTable's `UsageLimitSnapshot` / `UsageLimitBadge` / `applyUsageLimits(...)` story (see [`docs/reference/USAGE_LIMITS.md`](/home/erick/Documents/multitable/docs/reference/USAGE_LIMITS.md) and each provider skill's `reference/usage-limits.md`). They've already solved the cross-provider normalization problem at scale (53+ providers) — check their parsing logic before designing a new provider's out-of-band rate-limit feed (especially the providers where MultiTable currently has no live signal: Hermes, Grok, Cursor). Not a harness — it's a sidecar observability layer; we likely never adapter-wrap it.

---

## Meta-resources (curated lists & comparisons)

### awesome-agent-harness
- URL: https://github.com/AutoJunjie/awesome-agent-harness
- **TL;DR**: Not a tool but a curated directory of agent harnesses and meta-harnesses (Microsoft Agent Framework, Chorus, Compound Engineering Plugin, and more). Good starting point for discovering others.
- **MultiTable relevance**: Use as a discovery jumping-off point for projects *not* listed here.

### 9 Open-Source Agent Orchestrators (augmentcode writeup)
- URL: https://www.augmentcode.com/tools/open-source-agent-orchestrators
- **TL;DR**: Not a tool but a comparison writeup benchmarking several orchestrators with hands-on notes on isolation, agent support, and coordination models.
- **MultiTable relevance**: External comparison axis already done — read before building a comparison ourselves.

### awesome-harness-engineering
- URL: https://github.com/ai-boost/awesome-harness-engineering
- **TL;DR**: Curated list specifically for AI agent **harness engineering** — covers patterns for orchestration, memory, permissions/sandboxing, governance, evals, observability, and MCP. Great meta-resource if you're exploring this space.
- **MultiTable relevance**: The most directly on-topic meta-list — broader than awesome-agent-harness on patterns specifically.
