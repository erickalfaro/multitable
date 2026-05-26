# Grok slash-commands: what matters to MultiTable

Grok Build has a rich slash-command surface in its TUI. Most are **TUI-only** and irrelevant to the `grok agent stdio` integration — MultiTable's composer has its own `/`-autocomplete merge (project + user `.claude/commands` + native built-ins; see CLAUDE.md "Slash commands"), and custom commands flow through `wsClient.sendTurn`. This doc records which Grok-side commands the adapter must *know about*, vs. ignore.

> **`VERIFY`** the exact command list against `grok --help` / `grok inspect` / the in-TUI `/` menu. Below is research-derived.

## Commands relevant to the adapter

| Command | Why it matters | Adapter handling |
|---|---|---|
| `/model <name>` | Switches model. | Surfaced through MultiTable's model picker, not typed. If model switching over agent-stdio is supported, drive it via ACP params, not by injecting `/model` into the prompt. See [`models-and-effort.md`](models-and-effort.md). |
| `/plan`, `/code`, `/ask` (mode switches; `--mode plan` flag) | Native modes. | Driven via MultiTable's ModeBadge → `PUT /api/sessions/:id/mode` → (if `planMode: 'native'`) an ACP set-mode call. **Don't** inject the slash command into the prompt body. See [`modes.md`](modes.md). |
| `/feedback` | Reports bugs to xAI. | Out of scope — TUI only. |

## Commands to ignore (TUI-only / out of scope for v1)

Anything that drives Grok's interactive UI (subagent/Arena views, fullscreen TUI toggles, theme, mouse) has no agent-stdio meaning. The adapter never types slash-commands into `session/prompt` to control Grok — mode/model/effort are driven through ACP params or MultiTable capabilities, not by string injection.

## How MultiTable's own composer commands interact

`/clear` and `/cost` are MultiTable-native built-ins intercepted client-side in `ChatInputCM` (`handleNativeSlash`) — they never reach Grok. `/clear` calls `POST /api/sessions/:id/reset` (which should clear `agentSessionId` and call the adapter's `reset(s)`); `/cost` is an inline system message. For Grok, `/cost` will show the hidden-USD state (`capabilities.costUsd: false`) — that's expected, not a bug. Project/user custom `.md` commands flow through `sendTurn` and are substituted by Grok the same way any prompt is; no special wiring.

## The rule

The adapter controls Grok through **ACP params and capabilities**, never by injecting slash-commands into the prompt text. The only text that goes into `session/prompt.prompt[].text` is the user's actual message (plus an effort prefix *only if* [`models-and-effort.md`](models-and-effort.md) proves Grok uses one). If you find yourself string-building `/plan\n\n…` into a prompt, stop — that's the wrong lever.
