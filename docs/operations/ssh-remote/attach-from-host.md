# Attaching from the remote host

The server the desktop starts is an ordinary `forge serve` with Basic auth, so anything running on
the remote host as the same user can use it directly — a TUI, a script, or a second `forge`
invocation. There is no separate API for host-side attachment.

Discovery goes through the shim rather than through the state files, because `status` also verifies
the pid is alive:

```sh
sh ~/.forge/bin/forge-remote status
# FORGE_REMOTE {"port":41237,"username":"forge","password":"a3f1..."}
```

The CLI already consumes a running server this way. `forge run --attach <url>` skips loading a local
instance entirely and builds a client against the given base URL with
[`ServerAuth.headers`](../../../packages/server/src/auth.ts):

```sh
(
  FORGE_SERVER_PASSWORD="$(cat ~/.forge/run/server.auth)"
  export FORGE_SERVER_PASSWORD
  forge run --attach "http://127.0.0.1:$(cat ~/.forge/run/server.port)" -u forge "hello"
)
```

Under `--attach`, `--dir` is interpreted as a path _on the server_, not locally. A client sharing the
host's filesystem is the normal case here; see
[`packages/forge/src/cli/cmd/run.ts`](../../../packages/forge/src/cli/cmd/run.ts).

Because it is one process over one SQLite database, a local client and the desktop (through its
tunnel) observe the same Sessions live.

The example uses an environment variable to keep the password out of command arguments. The
remote account and administrators remain trusted. No client discovers a desktop-managed server on
its own; a host-side client must read the port and password as shown.

A remote-owned vault with independent startup and access from multiple desktops is not implemented
yet. A second desktop with a different vault key cannot independently restart and unlock the
existing vault; do not replace the key or delete stored secrets to work around a mismatch.

Four constraints shape any client built on this:

- **Port and password rotate on every remote restart.** Resolve them at connect time; never cache
  them across restarts.
- **The desktop owns the lifecycle.** `ensure` is idempotent, so attaching does not disturb it — but
  the desktop's "stop remote" or server removal kills the process the client is attached to.
- **The state files are 0600**, owned by the user the desktop connects as. A different user on the
  same host cannot read them, and loopback binding plus Basic auth leaves no other way in.
- **Starting the server by hand needs a vault key.** Running `forge-remote ensure` without
  `FORGE_SECRET_VAULT_KEY_ID` and `FORGE_SECRET_VAULT_KEY` fails with
  `Persistent secret storage requires an OS-protected key`, and supplying a _different_ key than the
  one that sealed existing credentials fails with `Stored credentials belong to another
OS-protected key`. For a host that must also work standalone, provision one stable key and point
  the desktop at it too — the desktop honors those variables from its own environment
  ([`main/index.ts`](../../../packages/desktop/src/main/index.ts)) — accepting that this bypasses
  `safeStorage` on the desktop side.

A client that tries `forge-remote status` first and falls back to `FORGE_SERVER_*` environment
variables works unchanged against both a desktop-managed remote and a hand-run `forge serve`.
