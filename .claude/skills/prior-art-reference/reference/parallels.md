# MultiTable concept → which projects to consult

When you're designing or scoping a feature in one of these areas, read the listed projects' approaches before committing to a shape. Depth and URLs live in [`projects.md`](projects.md); this table is just the index.

| MultiTable concept | Where it lives today | Projects to consult first |
|---|---|---|
| Provider adapter pattern (`ProviderAdapter`) | `packages/daemon/src/agent/providers/`, `agent/types.ts` | omnigent (closest), Mastra (`Harness` primitive), OpenCode (75+ providers), artificial (multi-runtime spawn) |
| Permission/approval routing | `hooks/permissionManager.ts`, Claude/Hermes `canUseTool` bridges | omnigent (`policies/`), OpenHarness, **Microsoft Agent Governance Toolkit**, Cordum |
| Policy enforcement / audit trails | (no MultiTable equivalent today) | Microsoft Agent Governance Toolkit, Cordum, Archon |
| Multi-agent orchestration / agent-to-agent | (not a current feature; sessions are isolated) | CrewAI, LangGraph, MetaGPT, VoltAgent, artificial, ruflo |
| Session persistence & resume | `db/store.ts`, per-provider rollout/JSONL parsers under `transcripts/` | omnigent, LangGraph (checkpointing), Mastra (threads) |
| Parallel-agent isolation | per-session `cwd`; no git/branch isolation today | Claude Squad (git-worktree-per-agent — direct prior art), OpenCode (multi-session) |
| Model catalog & discovery | `packages/daemon/src/providers/` (`baselines.ts`, `discovery.ts`, `catalog.ts`) | OpenCode (75+ providers), Strands/Harness SDK |
| Usage limits / cost tracking | `agent/applyUsageLimits.ts`, `UsageLimitBadge`, per-provider `reference/usage-limits.md` | **CodexBar** (53+ providers, the canonical cross-provider tracker), Mastra |
| Cloud sandbox / remote execution | (not implemented; daemon is local-only) | omnigent (Modal / Daytona / Islo), Strands/Harness SDK |
| Workflow templates / playbooks | (not implemented) | Archon (YAML workflows), LangGraph (graphs) |
| Observability / dashboards | `devLog.ts`, `DevLogPanel`, `NotificationCenter` | VoltAgent, Strands/Harness SDK, CodexBar (for usage specifically) |
| Discovery of *other* projects in this space | n/a | awesome-harness-engineering (most on-topic), awesome-agent-harness, augmentcode 9-orchestrators writeup |

When in doubt, [`omnigent-reference`](../../omnigent-reference/SKILL.md) is always a useful first stop — it's the closest sibling and has its own dedicated parallels table at the file/directory level.
