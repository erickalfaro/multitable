# Filesystem containment (the bwrap jail)

Hermes self-gates by command **content**, never by **path** — it has no
repo/workspace confinement of its own (see [`../pitfalls.md`](../pitfalls.md)
§10b). The only enforceable boundary is an OS sandbox around the `hermes acp`
child. MultiTable wraps every Hermes child in **bubblewrap** (`bwrap`), the
same unprivileged user-namespace sandbox Flatpak uses. This is **mandatory and
fail-closed**.

Authoritative file: [`hermes-acp/sandbox.ts`](../../../packages/daemon/src/agent/providers/hermes-acp/sandbox.ts). Wired in [`hermes-acp/transport.ts`](../../../packages/daemon/src/agent/providers/hermes-acp/transport.ts) `start()`.

## What the jailed child sees

| Path | Mode | Why |
|---|---|---|
| project dir (resolved cwd) | **rw** | the agent's actual workspace |
| `~/.hermes` (or `$HERMES_HOME`) | **rw** | auth.json, config.yaml, sessions DB, the venv |
| `/usr` | ro (hard) | python/node/ripgrep/ffmpeg + TLS libs |
| `/bin /sbin /lib* /etc /opt /run` | ro (best-effort) | merged-/usr symlinks, DNS stub, certs, nss |
| resolved `hermes` launcher | ro | the `~/.local/bin` shim is under the wiped $HOME |
| venv interpreter root (`pyvenv.cfg` `home=`'s parent) | ro | uv-managed standalone CPython lives **outside** `~/.hermes` |
| `~/.local/share/uv`, `~/.local/share/pipx`, `~/.pyenv`, `~/.rye` | ro (best-effort) | toolchain fallbacks for non-uv installs |
| `$HOME` (everything else) | **tmpfs (ephemeral, empty)** | `~/.ssh`, `~/.aws`, dotfiles, sibling projects simply do not exist |
| `/tmp` | tmpfs | scratch; doesn't persist or leak |
| host network | shared | Hermes needs `api.x.ai` |

`~/.cache`, `~/.config` etc. are writable but land on the ephemeral $HOME
tmpfs — Hermes won't crash on cache writes, and nothing persists or escapes.

## The toolchain trap (why it's not just project + ~/.hermes)

The documented Hermes install is `uv`-based. Two pieces live **outside**
`~/.hermes` and are wiped by the `$HOME` tmpfs unless explicitly re-bound:

1. The `hermes` launcher is a shell shim in `~/.local/bin` (a real script that
   `exec`s `~/.hermes/hermes-agent/venv/bin/hermes`).
2. The venv's interpreter is a **uv-managed standalone CPython** under
   `~/.local/share/uv/python/cpython-*/` — the venv's `bin/python` is a
   symlink there. The venv dir itself is under `~/.hermes` (bound) but the
   interpreter it points at is not.

`collectToolchainBinds()` re-exposes exactly these read-only: the resolved
launcher file, the interpreter root parsed from `venv/pyvenv.cfg`'s `home =`,
and best-effort fallbacks for pipx/pyenv/rye. **If you change the spawn to a
different binary or Hermes changes its install layout, re-verify the smoke
test below** — a dangling interpreter symlink fails with a confusing
"python: No such file or directory" *inside* the namespace only.

Inside the namespace, `$HOME` is a tmpfs so a PATH lookup of `hermes` (the
`~/.local/bin` shim) fails. The transport therefore execs the **resolved
absolute** `hermesBin` returned by `buildSandboxArgs`, not `'hermes'`.

## Fail-closed policy

Containment is not optional. `buildSandboxArgs` throws
`SandboxUnavailableError` if `bwrap` is not on PATH; `runTurn` surfaces it as
a distinct persistent alert ("Hermes blocked: filesystem sandbox
unavailable") and the turn does not run. The **only** bypass is the explicit
env opt-out `MULTITABLE_HERMES_SANDBOX=off` (logged loudly on every spawn) —
intended for non-Linux dev boxes (bwrap is Linux-only) or debugging, never as
a default. Do not add a silent fallback to unconfined.

## Smoke test (run after any change here)

bwrap version, paths, and the uv layout are environment-specific. After
touching `sandbox.ts` or the spawn, drive a real `initialize` through the jail
and confirm the response carries `authMethods` (proves the bound
`~/.hermes/auth.json` is readable *inside*):

```
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientInfo":{"name":"smoke","version":"0"},"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}}' \
  | <the exact bwrap argv buildSandboxArgs produces> -- <hermesBin> acp 2>/dev/null \
  | grep -m1 '"id":1'
```

A correct result is `{"jsonrpc":"2.0","id":1,"result":{… "authMethods":[{"id":"xai-oauth",…}] …}}`. Also assert `ls -d ~/.ssh` fails and `ls ~/Documents` shows only the project inside the jail.

## What this does NOT contain

bwrap confines the **filesystem** (and ipc/pid/uts/cgroup namespaces). It does
**not** restrict network (Hermes needs xAI) — a Hermes turn can still exfiltrate
project contents over the network, and can still reach any host the box can.
This boundary is about *the rest of your disk*, not data loss prevention. It
also doesn't change Hermes' self-gating (#10b) — within the project dir Hermes
still won't prompt for a non-dangerous `rm`.
