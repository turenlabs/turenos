# WSL backends

On Windows, TurenOS Desktop can run its backend inside a Windows Subsystem for Linux (WSL) distribution instead of the
local utility process. Desktop installs `forge` into the distro, starts `forge serve` there, and talks to it over HTTP
on `127.0.0.1`. The server binds all interfaces inside the distro, so how far it is reachable depends on the WSL
networking mode; every request still needs the per-start password.

The feature exists only on Windows. On other platforms the WSL IPC handlers report WSL as unavailable.

## Adding a WSL server

**Add WSL server** walks through three checks, each of which can install what is missing:

1. **WSL runtime.** `wsl.exe --install --no-distribution` runs elevated through PowerShell. Windows may need a
   restart before WSL is usable.
2. **Distro.** Desktop lists installed and online distros and can install one. A distro must be able to run commands and
   have `bash` and `curl`.
3. **TurenOS.** Desktop pipes the same `forge-remote` lifecycle script used for [SSH remote servers](./ssh-remote/README.md)
   into the distro and runs its `install <version>` subcommand. It downloads the release asset for the distro's platform
   from the public GitHub release, verifies it against `SHA256SUMS`, and installs `~/.forge/bin/forge`. After an update,
   Desktop checks that `forge --version` reports the Desktop's version and fails if it doesn't.

Installs have a 15-minute timeout; other WSL commands time out after 20 seconds.

## Starting the server

Desktop allocates a free loopback port on Windows, then pipes a startup script into `wsl bash -se` so no secret appears
in a command line. The script:

- changes to the distro user's home directory;
- removes `/mnt/*` entries from `PATH` and clears `WSLENV`, so Windows tools and variables don't leak into the backend;
- sets `FORGE_EXPERIMENTAL_DISABLE_FILEWATCHER=true`, `FORGE_CLIENT=desktop`, and `XDG_STATE_HOME=$HOME/.local/state`;
- sets `FORGE_SERVER_USERNAME=forge` and a random `FORGE_SERVER_PASSWORD` generated for this start;
- exports the Desktop's vault key as `FORGE_SECRET_VAULT_KEY_ID` and `FORGE_SECRET_VAULT_KEY`, which the vault deletes
  from the environment when it initializes (see [Secure storage](../systems/secure-storage.md));
- runs `forge serve --hostname 0.0.0.0 --port <port>` with the renderer's CORS origins, logging at `WARN` in packaged
  builds and `INFO` in development.

Desktop polls the server's health every 100 ms and gives up after 30 seconds, stopping the process and reporting the
last lines of its output. Every persisted WSL server is started when Desktop launches and stopped when it quits.

## Differences from SSH remotes

|               | WSL backend                                                  | [SSH remote](./ssh-remote/README.md)                           |
| ------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| Listener      | `0.0.0.0` inside the distro                                  | `127.0.0.1` on the remote, reached only through the SSH tunnel |
| Transport     | Plain HTTP to `127.0.0.1` through WSL's localhost forwarding | Encrypted SSH tunnel                                           |
| Lifecycle     | Child of Desktop; stops when Desktop quits                   | Daemonized with `nohup`; survives Desktop quitting             |
| File watching | Disabled                                                     | Disabled                                                       |

## Limits

- With WSL's mirrored networking mode, or a port proxy, a `0.0.0.0` listener can be reachable from the network, subject
  to the Windows and Hyper-V firewalls. The Basic-auth password is then the only barrier; don't use a WSL backend on an
  untrusted network without checking the networking mode.
- File watching is disabled in the distro (`FORGE_EXPERIMENTAL_DISABLE_FILEWATCHER=true`), as on SSH remotes.
- Removing `/mnt/*` from `PATH` only stops Windows executables from being found by name. The Windows drives stay
  mounted under `/mnt/` and are reachable by path from commands the agent runs.

## Source

- [`packages/desktop/src/main/wsl/sidecar.ts`](../../packages/desktop/src/main/wsl/sidecar.ts)
- [`packages/desktop/src/main/wsl/runtime.ts`](../../packages/desktop/src/main/wsl/runtime.ts)
- [`packages/desktop/src/main/wsl/servers.ts`](../../packages/desktop/src/main/wsl/servers.ts)
- [`packages/desktop/src/main/wsl/ipc.ts`](../../packages/desktop/src/main/wsl/ipc.ts)
- [`packages/app/src/wsl`](../../packages/app/src/wsl)
