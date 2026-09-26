# Connecting to the host

How the desktop turns a typed target into a verified, authenticated, shared SSH connection, and how the tunnel to
the remote server becomes ready.

## Host identity

A target is typed as `[user@]host[:port]`, including `~/.ssh/config` aliases. `parseSshTarget`
rejects anything that could smuggle options into the destination argument (leading `-`, whitespace,
a second `@`, a non-numeric colon suffix), and the destination is always passed last on the argv so
`ssh` cannot read it as an option.

`resolveSshTarget` then runs `ssh -G <destination>` and takes the effective `HostName`, `User`, and
`Port` from the user's own SSH config, so aliases, `ProxyJump`, and per-host settings behave exactly
as `ssh` defines them. The resolved values produce a canonical id:

```
ssh:user@hostname[:port]     # port omitted when 22
```

That id is the dedupe key — `myalias` and `user@203.0.113.10` resolve to the same server and cannot
be added twice — and it is also the app-level connection key (`ssh:<id-without-prefix>`), so a
remote's stored project state survives across renames of the alias.

`ssh -G`'s `identityfile` is deliberately _not_ adopted: it reports defaults like `~/.ssh/id_rsa`
even when nothing is configured, and re-passing them with `-i` narrows the auth set. Only an
explicitly entered identity file is used.

## Authentication

Every connect first tries key/agent auth in batch mode (`BatchMode=yes`, `ConnectTimeout=15`,
`StrictHostKeyChecking=ask`). If that succeeds, the control master is started as a plain child
process and no terminal is ever allocated.

If batch auth fails with a permission or connection error, the master is re-spawned under a pty
(`@lydell/node-pty`) and `detectSshPrompt` watches the output tail — SSH writes prompts without a
trailing newline, so only the last line matters. It recognizes:

- host-key confirmation (`(yes/no/[fingerprint])?`), returned with the surrounding fingerprint block,
- key passphrases,
- passwords, and keyboard-interactive second factors (verification code, OTP, passcode, smartcard PIN),
  which share the masked-input UX.

Each detected prompt becomes `state.prompt` with a fresh `requestId`, surfaces in the renderer
through [`SshPromptHost`](../../../packages/app/src/ssh/prompt-host.tsx) — mounted once under the shared
providers so a reconnect can prompt from anywhere in the app — and the answer routes back through
`respondPrompt`. A `null` response cancels: the ssh process is killed and the error is raised as an
`AbortError` so the controller does not retry into another prompt. `stopAll` resolves every pending
prompt with `null` rather than leaving ssh hanging at quit.

`StrictHostKeyChecking` is pinned to `ask` rather than `accept-new`: a batch run cannot answer, so
it fails fast and falls through to the pty path where the user sees the fingerprint and decides. A
_changed_ host key still hard-fails, as SSH intends.

## Connection multiplexing

All remote work for one host shares a single authenticated connection, so an interactive password is
asked for at most once. `ensureMaster` creates `-M -N -S <controlPath>` with
`ControlPersist=10m`; every later command, probe, and tunnel passes `-S <controlPath>` and
multiplexes over it.

Control sockets live in a short per-user path — `/tmp/forge-ssh-<uid>` (`%TEMP%\forge-ssh` on
Windows) — because `sockaddr_un` is capped near 104 bytes on macOS and the app data directory
overflows it. The socket name is a SHA-256 prefix of `user@host:port`. Concurrent `ensureMaster`
calls for the same socket (a probe overlapping a connect) are serialized through an in-process lock
so two pty masters never race one socket.

## Tunnel and readiness

With a port in hand the desktop allocates a free loopback port locally (bind :0, read it, close) and
spawns the forward over the master:

```
ssh -S <controlPath> -L 127.0.0.1:<local>:127.0.0.1:<remote> \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=2 -o TCPKeepAlive=yes <dest> 'while :; do sleep 86400; done'
```

Two details are load-bearing. A multiplexed `-N` session exits immediately because there is no
command channel to hold, so a remote sleep loop keeps the child alive and makes _its_ exit a
reliable signal that the connection dropped. And forwards registered through the mux outlive the
session that created them, so on exit the desktop explicitly issues `-O cancel -L <spec>` — otherwise
the local port stays bound and the next connect cannot re-register it.

Startup then races three outcomes: health polling against `GET /global/health` with Basic auth
(`forge:<password>`, 100 ms interval), a 20-second timeout, and tunnel exit. Whichever settles first
wins; a timeout or early exit stops the tunnel and surfaces the summarized ssh stderr.
