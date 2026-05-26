# Known bugs & version-pinned observations — Grok Build

Grok Build is in **early beta** (CLI launched 2026-05-14, `grok-build-0.1` model 2026-05-20). The CLI changes frequently, so every wire observation must be stamped with the `grok --version` it was seen on. This is the running log — append, don't overwrite, and re-verify after each Grok upgrade.

## How to re-baseline after a Grok upgrade

```bash
grok --version                          # stamp every observation with this
grok inspect                            # config sources, MCP, skills, plugins, hooks, AGENTS.md
# scripted ACP handshake (records real frame shapes):
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}}' | grok agent stdio
```

Capture: the `initialize` result (`protocolVersion`, `agentCapabilities`, `authMethods`), whether `session/new`/`session/load`/`session/prompt` respond, the `session/update` kinds emitted, the `session/request_permission` payload + option ids, and whether `session/set_mode` / model override / effort knobs exist.

## Observed quirks (research-derived; confirm locally)

| ID | Observed on | Symptom | Cause | Mitigation |
|---|---|---|---|---|
| G1 | grok 0.1.x | `session/*` requests silently time out (~12 s) while `initialize` works | Grok's ACP parser does not unescape `\/` in `method` names | Transport rewrites `\/`→`/` in outbound `method`. [`../pitfalls.md`](../pitfalls.md) §1 |
| G2 | grok 0.1.210 | `x.ai/billing` returns `-32601 Method not found` over agent-stdio | Billing extension wired into the TUI only, not the agent-stdio surface | `costUsd=false`; don't probe per-turn; cache `-32601` as unavailable. [`../reference/xai-auth.md`](../reference/xai-auth.md) |
| G3 | grok 0.1.x | Tool runs / file writes with no prompt in `code` mode | Grok self-gates approvals; no host force-prompt over ACP | Document, not fix. Use `ask`/`plan`. [`../pitfalls.md`](../pitfalls.md) §6 |
| G4 | grok 0.1.x | First turn in a fresh dir stalls or refuses tools | Workspace-trust gate (`~/.grok/workspace-trust.json`) | VERIFY trust behavior over agent-stdio; route or pre-seed. [`../pitfalls.md`](../pitfalls.md) §9 |

## Open VERIFY items (resolve against a live binary, then promote to confirmed)

These gate the final `ProviderCapabilities` values and the adapter's lever choices:

- [ ] **`planMode`** — is mode switching (`session/set_mode` / `session/new` mode param / `availableModes`) reachable over agent-stdio? → `'native'` vs `'simulated'`. [`../reference/modes.md`](../reference/modes.md)
- [ ] **`session/load` + replay** — does Grok support `session/load`? Does it replay history as `session/update`? How much? → shapes the parser dedupe + drain. [`persistence-and-parser.md`](persistence-and-parser.md)
- [ ] **On-disk format** — exact `~/.grok/` sessions path + record schema + whether stable per-event ids exist → shapes `grokParser.ts` + `emitMessageRekey` vs `toolUseId`-scan dedupe.
- [ ] **Per-cwd vs singleton** — does Grok honor per-session `cwd` (singleton OK, Codex model) or read its own `os.getcwd()` (per-cwd required)? [`adapter-architecture.md`](adapter-architecture.md)
- [ ] **Subagents** — which `session/update` kinds carry the up-to-8 parallel subagents / Arena Mode? → `subagents` capability + `emitTaskEvent` mapping.
- [ ] **`thinkingEffort`** — any reasoning-effort knob for grok-build-0.1 over agent-stdio? → `'native'` vs `'unsupported'`. [`../reference/models-and-effort.md`](../reference/models-and-effort.md)
- [ ] **`userQuestion` / `elicitation`** — any free-form question / MCP elicitation channel over agent-stdio? → currently both assumed off.
- [ ] **`hardSandbox` / fs capability** — does Grok respect `clientCapabilities.fs:false,terminal:false`, or require host fs? → confirms `hardSandbox=true` and the reject-by-design handlers.
- [ ] **Auth error strings** — exact code/message for a **prompt-time** (not billing) auth failure → the auth-alert classifier. [`../reference/xai-auth.md`](../reference/xai-auth.md)
- [ ] **`protocolVersion`** — integer `1` vs string `"1"` on `initialize`.
- [ ] **`session/request_permission` payload** — real `options[]` `optionId`/`kind` values + `toolCall` field names → the option matcher + prompt-card extraction. [`permission-wiring.md`](permission-wiring.md)

When an item is resolved, move it into the confirmed table above with its version stamp and update the relevant reference doc + the `VERIFY` markers in [`../SKILL.md`](../SKILL.md).
