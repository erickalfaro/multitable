# Reasoning effort — three tier sets, one passthrough

This is the most-asked-about Hermes feature, and it crosses **three** different tier vocabularies. Get them straight before touching the plumbing.

## The three tier sets

| Layer | Allowed values | Default | Source |
|---|---|---|---|
| **MultiTable** `AgentSession.thinkingEffort` | `low` `medium` `high` `xhigh` `max` `null` | from `GlobalConfig.lastThinkingEffort` | `CLAUDE.md` "Thinking effort" |
| **Hermes** `agent.reasoning_effort` (`~/.hermes/config.yaml`) | `none` `minimal` `low` `medium` `high` `xhigh` | `""` ⇒ **medium** | [Hermes configuration docs](https://hermes-agent.nousresearch.com/docs/user-guide/configuration) |
| **xAI** native `reasoning_effort` (grok-4.3) | `none` `low` `medium` `high` | **low** | [xAI reasoning spec](https://docs.x.ai/developers/model-capabilities/text/reasoning) |

Hermes squeezes its 6-tier set down onto Grok's native 4-tier set internally (`minimal`/`xhigh` have no native Grok equivalent — Hermes maps them). **We do not do that mapping.** The adapter hands Hermes a level string via the `/reasoning` slash-command and lets Hermes pass it through to Grok's `reasoning.effort`.

## How the adapter sends it: a one-shot prompt prefix

There is no ACP RPC for reasoning effort. Hermes exposes it as the in-band `/reasoning <level>` slash-command, and **Hermes persists the level on the ACP session** once set. So the adapter prepends the command to the prompt body **only when the effort changed** — tracked per session in `this.lastSentEffort`:

```ts
const effort = s.thinkingEffort ?? null;
const hermesEffort = effort === 'max' ? null : effort;   // 'max' is Claude-only — DROP it
let body = text;
if (hermesEffort && this.lastSentEffort.get(s.id) !== hermesEffort) {
  body = `/reasoning ${hermesEffort}\n\n${text}`;
  this.lastSentEffort.set(s.id, hermesEffort);
} else if (!hermesEffort) {
  this.lastSentEffort.delete(s.id);
}
```

Consequences, each load-bearing:

- **`'max'` → `null` → no prefix.** `max` is a Claude-only tier; Hermes/Grok don't accept it. We send nothing and let Hermes' session/config default (medium) stand. Don't "fix" this by mapping `max → xhigh` without checking what the user expects.
- **`minimal` / `none` are never sent from our side** — they aren't MultiTable `thinkingEffort` values. Only `low`/`medium`/`high`/`xhigh` ever become a `/reasoning` argument. `xhigh` is a valid Hermes tier (Hermes maps it down to Grok `high`).
- **Prefix only on change** keeps transcript noise down (the level sticks on the session). If you send it every turn, every persisted user message starts with `/reasoning …`.
- **The cache is poisoned on turn error and on `reset()`**: `runTurn`'s `catch` does `this.lastSentEffort.delete(s.id)` and `reset(s)` deletes it too, so the next turn re-asserts the level (the on-disk session may have been re-loaded fresh).
- **`lastSentEffort` is keyed by MultiTable session id** (`s.id`), not the Hermes session id. A `session/load` that mints the same id keeps the cache; a fresh `session/new` after `/clear`/error correctly re-sends because the cache was cleared.

## The parser strips the prefix back out

Because the `/reasoning <level>` line is mechanical (we injected it, the user didn't type it), [`hermesParser.ts`](../../../../packages/daemon/src/transcripts/hermesParser.ts) strips it from user messages on hydration:

```ts
const stripped = text.replace(/^\/reasoning\s+\S+\s*/i, '').trim();
if (!stripped) continue;   // also drops a user msg that was ONLY the prefix
```

If you change the prefix format in `hermes.ts`, change this regex in lockstep or old transcripts render `/reasoning high` as if the user said it.

## Runtime `/reasoning` subcommands (Hermes)

From the [slash-commands reference](https://hermes-agent.nousresearch.com/docs/reference/slash-commands) — `/reasoning [level|show|hide]`, session-scoped:

| Form | Effect |
|---|---|
| `/reasoning` | show current level |
| `/reasoning <none\|minimal\|low\|medium\|high\|xhigh>` | set effort (persists on the session) |
| `/reasoning show` | reveal the model's thinking steps |
| `/reasoning hide` | hide the model's thinking steps |

We only ever send the **`/reasoning <level>`** form. `show`/`hide` is a TUI/messaging concern; reasoning surfaces to us as `agent_thought_chunk` regardless, rendered as a `ReasoningCard` preview. The adapter clears the live reasoning preview (`cb.emitReasoningDelta('')`) once the turn's canonical assistant message lands, but does **not** push reasoning into `s.messages` (no manager path for that today).

## xAI native semantics (for grok-4.3)

So you can explain to a user what each level *does* downstream:

- `none` — *"Disables reasoning entirely; no thinking tokens"* — fastest.
- `low` (xAI default) — *"Uses some reasoning tokens, but still fast"* — general agentic work.
- `medium` — *"More thinking for less-latency-sensitive applications"*.
- `high` — *"Uses more reasoning tokens for deeper thinking"*.

On `grok-4.20-multi-agent-*`, the same parameter controls **agent collaboration count**, not depth — see [`xai-grok-oauth.md`](xai-grok-oauth.md).
