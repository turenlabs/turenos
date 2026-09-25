# Installing and running on the remote

What the desktop puts on the remote host and how it keeps the remote server running: the `forge-remote` shim,
installing and updating `forge`, and runtime state and recovery.

## The remote shim

Before anything else, the connect writes [`shim.ts`](../../../packages/desktop/src/main/ssh/shim.ts)'s
script to `$HOME/.forge/bin/forge-remote` (mode 0755) via `cat` over the master. It is rewritten on
every connect so an outdated copy self-heals, and it is plain POSIX `sh` because a remote may not
have `bash`. It owns four subcommands:

- **`ensure`** (default) — idempotent, and the only subcommand invoked with an environment (piped in
  on stdin; see [Keychain and key material](./keys-and-security.md#keychain-and-key-material)). If a live pid and stored
  port/auth exist, it just reprints the state, so reconnects reattach to the running server instead
  of spawning a second one. Otherwise it
  creates `~/.forge/run` (0700), generates a 16-byte random password from `/dev/urandom`, and
  `nohup`s `forge serve --hostname 127.0.0.1 --port 0` with the CORS origins, then discovers the
  kernel-assigned port by tailing the server's own log line. Pid, port, and auth files are written 0600. Failure prints `FORGE_REMOTE_ERROR` plus the log tail and removes the pidfile.
- **`status`** — prints the state line if a server is alive, else exits nonzero.
- **`install <version>`** — see below.
- **`stop`** — kills the pid and removes the pid/port files.

The state line is the contract between remote and desktop:

```
FORGE_REMOTE {"port":<n>,"username":"forge","password":"<hex>"}
```

`parseRemoteState` takes the _last_ such line, so MOTD and profile noise cannot spoof the value
ahead of it. The same marker discipline applies to `FORGE_PROBE` lines from the capability probe.

The server is started with `FORGE_SERVER_USERNAME=forge`, the generated `FORGE_SERVER_PASSWORD`,
`FORGE_CLIENT=desktop`, `FORGE_EXPERIMENTAL_DISABLE_FILEWATCHER=true`,
`XDG_STATE_HOME=$HOME/.local/state`, and — when the desktop supplies them — the
`FORGE_SECRET_VAULT_KEY_ID` / `FORGE_SECRET_VAULT_KEY` pair described in
[Secure storage](../../systems/secure-storage.md), so credentials sealed by the desktop remain readable on the
remote. `remoteEnsureScript` sends them through stdin, and the shim inherits the exported variables
when it starts `forge serve`.

## Installing and updating forge on the remote

If `ensure` reports `FORGE_REMOTE_ERROR forge is not installed`, the connect runs the install path
once and retries `ensure`. Install has two ordered strategies:

1. **Shim install over curl.** `probeRemote` checks for `curl`; if present, the shim's own `install`
   subcommand downloads the release asset for the detected platform straight from
   `https://github.com/turenlabs/turenos/releases/download/v<version>`, downloads `SHA256SUMS`,
   verifies the archive with `sha256sum` or `shasum`, extracts it, asserts `forge --version` equals
   the requested version, and atomically moves the binary into `~/.forge/bin/forge`. Target detection
   covers linux/darwin × x64/arm64, Rosetta translation, non-AVX2 `-baseline` builds, and musl
   (`-musl`) hosts. A checksum mismatch, a version mismatch, or a symlinked payload aborts the
   install. Being self-contained, the remote never depends on the published install script being
   current.
2. **Same-arch binary stream.** Packaged desktop builds carry a `forge-cli` binary in
   `process.resourcesPath`. When the remote's `uname -sm` maps to the same target as this machine and
   no `curl` is available, that binary is streamed to `~/.forge/bin/forge` over the master
   (temp file, `chmod`, atomic `mv`). Dev builds pass `localForgeBinary: null`, since
   `FORGE_CLI_COMMAND` resolves to `bun` locally and is useless on a remote.

If neither applies, the error names the manual fallback (`curl -fsSL …/install | bash`).

The same install path is exposed as an explicit action: settings show the remote's detected forge
path and version against the desktop version, and **Install TurenOS** or **Update TurenOS** runs `installForge`, re-probes,
asserts via `expectSshForgeVersion` that the remote now reports the expected version — failing
loudly if it does not — and then reconnects with `startServer`.

The reconnect does not restart the remote process. `startServer` only closes and rebuilds the local
tunnel, and the shim's `ensure` finds the still-running `forge serve` and reattaches to it. Replacing
`~/.forge/bin/forge` does not affect that process, so the previous version keeps serving until the
server stops. To run the new version after an update, choose **Stop remote server** from the
server's menu, then **Reconnect**: the stop runs `forge-remote stop`, and the next `ensure` starts
the installed binary.

## Runtime state and recovery

Each server carries one runtime state: `starting`, `ready` (with the loopback `url`, `username`,
`password`), `failed` (with a message), or `stopped`. Only `ready` servers are projected into the
app's server list by
[`readySshConnections`](../../../packages/desktop/src/renderer/ssh/connections.ts).

A dropped tunnel or a failed connect schedules a bounded reconnect on the
`1s, 3s, 10s, 30s, 60s, 60s` schedule — deliberately stretched past a minute so a laptop
sleep/wake recovers without user action — and the counter only resets once a connection actually
reaches `ready`. Two cases never retry: a user-cancelled prompt (retrying would just re-prompt) and
an exhausted schedule. Stale work is discarded by a per-server start-attempt counter, so a removal
or restart during an in-flight connect closes the late connection instead of adopting it.

`stopRemote` kills the remote server (`forge-remote stop`) and closes the master; the server stays
configured and can be started again. `removeServer` drops it from storage and clears cached probes
and version checks, and passes `reachable: false` so removal never opens a new master and never
prompts. The `forge-remote stop` command still runs: over the master when it is alive, otherwise as
a direct `BatchMode=yes` ssh connection, which succeeds for key or agent authentication. Only when
that non-interactive connection fails (for example, a password-only host with no live master) is
the daemonized remote left running, to be reattached or stopped on re-add.

Because `ensure` is idempotent and the remote is daemonized with `nohup`, quitting the desktop does
not kill the remote server. The next launch auto-connects every persisted server and reattaches.
