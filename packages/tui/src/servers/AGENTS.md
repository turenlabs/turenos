# Server discovery and attach

`src/servers.ts` is the façade the dashboard, the server picker (`src/server-picker/`) and agent commands use. Behind it, `discovery.ts` lists the servers on this computer, `records.ts` reads the records their owners publish, `resolve.ts` turns a choice into an endpoint, `verify.ts` proves it, and `ssh.ts` reaches SSH hosts. The record table and SSH steps are in `docs/systems/tui/README.md`.

## Conventions

- A record's credentials go only to the server it names. Read local records through `readPrivate` (owner and mode checked) and keep the freshness checks in `freshness.ts`.
- A record that names a `serverID` is accepted only when `GET /global/server` answers that ID (`verify.ts`).
- A version 2 persistent record names a Unix socket and must name exactly `PERSISTENT_SOCKET`. That path must match the desktop's `PERSISTENT_SOCKET_PATH` in `packages/desktop/src/main/ssh/persistent.ts`.
- A socket record never matches a typed URL (`trustedRecord`), so its `http://localhost` placeholder lends no credentials.
- An endpoint with `socketPath` is reached through that socket by every request path (see `src/server/AGENTS.md`).
- An SSH endpoint is the tunnel's loopback end and carries no socket path: the forward ends at the host's socket or port.
- `ssh` runs from argument lists with `sshEnvironment` (no `FORGE_*` variables), `BatchMode=yes` and `ControlMaster=no`. Secrets never go in argv; over SSH they go on stdin. The only child given a password in its environment is the local headless server (`headless.ts`), which is how forge reads it.
- Discovery order (`localEntries`) is the desktop app, then the persistent server, then the quick-connect server, then port 4096. `--server persistent` names the persistent server on Linux (`servers.find`), after any saved server of that name.

## Tests

- `test/servers*.test.ts` build servers with `createServers` options in place of the real paths: `home`, `platform`, `uid: undefined`, `persistentRecord` and `persistentSocket`. A fake `ssh` script answers the probe and forwards tunnels.
- `test/persistent-socket.test.ts` runs a fake server on a Unix socket with `turen({ socket })`.
