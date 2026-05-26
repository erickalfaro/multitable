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

## Resolved on grok v0.2.2 (2026-05-27 handshake spike)

The G1/G2/G4 quirks above were **0.1.x** observations and did NOT reproduce on 0.2.2:
- **G1 (`\/` parser bug):** not observed — plain `session/new`/`session/prompt` work (Node's `JSON.stringify` doesn't escape `/`). The transport shim is unnecessary on 0.2.2; we don't ship one.
- **G2 (`x.ai/billing -32601`):** not re-tested (we don't probe billing). `costUsd=false` stands, but real token usage **is** available (see below).
- **G4 (workspace-trust):** no trust gate hit over agent-stdio in this repo's cwd.

The original VERIFY checklist, now answered against 0.2.2:

| Item | Verified answer |
|---|---|
| `planMode` | **native** — `--permission-mode` enum = Claude's (default/acceptEdits/auto/dontAsk/bypassPermissions/plan); `session/new` accepts `permissionMode`. |
| `session/load` + replay | `agentCapabilities.loadSession: true`. No replay flood observed on a fresh session; the adapter keeps a 500ms post-load drain defensively. |
| On-disk format | `~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId(uuidv7)>/` with `summary.json`, `chat_history.jsonl`, **`updates.jsonl`** (the session/update replay — what `grokParser` reads), `session_search.sqlite` index. |
| Per-cwd vs singleton | Grok honors the per-session `cwd` on `session/new` (returns `currentWorkingDirectory`). We still pool **per-cwd** for parity/scoping; a singleton would also be correct. |
| Subagents | session/update kinds for subagents not exercised yet → `subagents: 'none'` for now. |
| `thinkingEffort` | **native** — `--effort low\|medium\|high\|xhigh\|max`; `session/new` accepts `effort`. |
| `userQuestion` / `elicitation` | none seen → both off. |
| `hardSandbox` / fs | Grok accepted `clientCapabilities.fs:false,terminal:false`; sent no fs/terminal requests. `hardSandbox: false` (v1 leaves `--sandbox` default). |
| Auth | `authMethods: [cached_token, grok.com]`; `authenticate({methodId:'cached_token'})` succeeds for subscribers. needsSetup when only `grok.com` is offered / authenticate fails. |
| `protocolVersion` | integer `1`. |
| usage | `session/prompt` response `_meta`: `inputTokens`, `outputTokens`, `cachedReadTokens`, `reasoningTokens`, `totalTokens`, `modelId` → `applyUsage` (no USD). |
| `session/request_permission` payload | not exercised in the spike (no tool calls on "hi") — the option matcher mirrors the ACP `allow_once`/`allow_session`/`allow_always` ids; re-verify the real `optionId`/`kind` on a tool-using turn. |

Re-baseline (re-run the handshake spike) after each `grok` upgrade and update this table.

## `ask_user_question` is non-interactive over agent-stdio (read-only render)

Grok has an `ask_user_question` tool (Claude `AskUserQuestion` shape: `tool_call` with `rawInput.questions[].options[{label, description, preview}]`). Over `grok agent stdio` it is **not interactive** — verified in session `019e6655`: the tool's permission auto-resolves (`wait_ms:0`) and it `tool_completed` in `0ms` without waiting for an answer (interactive answering is TUI-only; there's no ACP channel to deliver a choice back). So `capabilities.userQuestion` stays `'unsupported'`.

MultiTable therefore renders it **read-only**: `ToolCallCard` (web) special-cases `ask_user_question` / `AskUserQuestion`, showing the question + options legibly (not raw JSON) with a "Reply in chat with your choice" hint — the user answers by sending the next message. Do **not** wire clickable options that pretend to send an answer back to Grok; it already moved on.
