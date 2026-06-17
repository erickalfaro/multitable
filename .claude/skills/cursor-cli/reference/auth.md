# Cursor auth

Cursor authenticates exactly where its own CLI does — MultiTable does **not**
manage credentials. The adapter spawns `cursor-agent` with the inherited
`process.env`, so whatever works for `cursor-agent` on the command line works
here.

## Credential sources (in CLI precedence)

1. `CURSOR_API_KEY` env var (or `--api-key <key>`).
2. Logged-in state under `~/.cursor` — written by `cursor-agent login`
   (`NO_OPEN_BROWSER=1` to suppress the browser). Token cache referenced by
   `~/.cursor/cli-config.json` (`serverConfigCache.authCacheKey`,
   `authInfo.{email,userId,teamId}`).

`init` reports `apiKeySource` (`"login"` or `"apiKey"`) so you can confirm which
path was used.

## Checking auth

`cursor-agent status` (alias `whoami`) prints `✓ Logged in as <email>` or an
unauthenticated message. Useful for a health probe; not required at spawn time.

## Failure behavior

Missing/invalid creds make the **first turn fail** — the child exits non-zero
without a `result` line (or emits an error). The adapter surfaces this via an
`auth`-category alert and re-throws so the manager emits `session:turn-error`.
The alert body should point the user to `cursor-agent login` / `CURSOR_API_KEY`.

No per-session BYOK: `capabilities.byok = false` (the machine-wide Cursor login /
env key is used for every session).
