# Persistent server

A persistent server is one long-running `forge serve` that owns a database and its vault key on a host. Every client
(the GUI on the host, a GUI on another computer, and later the TUI) attaches to it. SSH authenticates and tunnels
clients; it never supplies the server's key. SSH quick connect ([SSH remote servers](./ssh-remote/README.md)) keeps working
unchanged for hosts that haven't been promoted.

Status: the Linux systemd path is implemented. macOS adoption (LaunchDaemon plus the Keychain or root-launcher key
source) and promoting an SSH quick-connect remote from the desktop haven't shipped yet.

## What protects what

- **Vault key.** It lives in the host's protected store: systemd encrypted credentials on Linux. `forge` reads it
  itself, and it never appears in argv, the environment, the unit file, logs, or HTTP responses.
- **HTTP password.** It is stable, stored separately from the key, and handed to authorized SSH users through the
  attach record. Basic auth remains defense in depth. A copied password cannot bypass Unix socket permissions.
- **Unix socket.** The persistent service listens only on `/run/turenos/server.sock`, not TCP.
  `/run/turenos` is `0710`, owned by the service user and `turenos-operators`. The socket is `0660` with the same ownership.
  Operators can connect but cannot replace the socket through that directory.
- **Scope.** Agent tools run as the service account and can read whatever that account can. The vault protects data at
  rest and backups. The service account and its tools are trusted. They can read the key and password and replace the socket.
  This setup does not isolate tools from the service.

### Setup runs as root

`install` works as root inside a data root that belongs to the service account. It prevents that account from
redirecting root's work:

- **Service account.** The account must not be root.
- **Data root location.** The data root's parent, and every directory above it, must be writable only by root. The
  data root itself must not be a symlink. An existing data root must be empty, carry the `.turenos-persistent` marker
  that `install` writes (root-owned `0600`) when it first takes a directory, or already be named by the installed
  unit; `install` refuses any other directory, so `--data-root /var/lib` is never handed to the service account.
- **Taking the data root back.** Before working in it, `install` stops the service and makes the data root and every
  managed directory in it root-owned `0700`. It refuses any managed directory or database file that is a symlink or a
  hard link. It retains handles to claimed directories and hands them back through those handles, children before
  parents. A rejected layout does not enter ownership cleanup; a partial claim releases only directories it acquired.
  Database files are checked and handed back through open handles while their parent directories remain protected.
- **Service binary and recovery copy.** The binary the unit runs (`--forge-bin`, default: the installed unit's binary,
  else the running `forge`, resolved through links) must be a root-owned file in directories only root can write, since it receives the key and
  password. The `--recovery-file` directory must also be writable only by root.
- **Unit values.** Values written into the unit (account, server ID, paths) are limited to characters that can't
  split or reinterpret a unit line.
- **Credential files.** Credential blobs are kept `0600`. Files with secrets are written through the opened file,
  never by path.
- **Password check.** The server compares the HTTP password in constant time.

### Known limits

- **One shared server per host.** A host runs at most one persistent server, and it has no per-user logins. Every
  member of `turenos-operators` attaches with the same attach-record password and shares one set of provider
  credentials, one session history, and the service account's files. People who need separate credentials or data use
  separate Unix accounts with quick connect, on a host that hasn't been promoted.
- **Operator access runs code as the service account.** The attach record grants the whole API, including terminals and
  agent tools, and those run as the service account. Add only users you would trust with that account.
- **No quick connect on a promoted host.** Every SSH user's desktop checks for the attach record first. Operators
  attach to the shared server; any other user gets a conflict instead of a private quick-connect server. Falling back
  would restart the quick-connect database the host was promoted from and split its data.
- **Revoking operator access.** Remove the user from `turenos-operators`, then disconnect existing SSH channels and sessions.
  Existing logins keep their group state. A new SSH login must load the changed group state before revocation takes effect.
  Removing group membership alone does not close existing connections. A copied HTTP password does not grant socket access.
- **Credentials inside the service.** The credential files are readable by the service account, and so by agent
  tools, as described under Scope. After loading them `serve` removes `CREDENTIALS_DIRECTORY` and
  `FORGE_SERVER_PASSWORD_CREDENTIAL` from the environment, so tools, PTYs, and MCP servers are not told where they are.
- **`forge` commands run by tools.** Tools inherit the pinned `FORGE_DB` and persistent mode. In persistent mode a
  database opens only in the process that holds its owner lock, so a `forge` command a tool runs fails before it can
  migrate or write the live database. This guards against accidents, not against a tool: it can clear the
  environment, and it can already read the service account's files.

## Contracts

- **Descriptor.** `GET /global/server` (authenticated). Fields: `serverID`, `dataIdentity { databasePath, databaseUUID }`,
  `keyID`, `mode`, `keySource`, `listener`, `version`. It never contains key bytes or the password.
- **Attach record.** Version 2 contains `serverID`, `socketPath`, `username`, and `password`, not `url`.
  `socketPath` is fixed at `/run/turenos/server.sock`.
  The record lives at `/etc/turenos/attach.json` (`0640 root:turenos-operators`). Clients read it, never a process environment.
- **Ownership.** The owner lock sits beside the database. The owner record inside the database refuses any other
  process on a persistent database, before migrations run. See
  [Secure storage](../systems/secure-storage.md#database-identity-ownership-and-verification).
- **ACP ownership.** `forge acp` also takes the database owner lock. It cannot run beside the persistent service on the same database.
  This exclusion is deliberate. The Unix socket change does not change ACP ownership.

## Linux (systemd)

### Requirements

- systemd as PID 1, version 250 or later, with a working `systemd-creds`.
- A system service. A user service needs systemd 256 or later plus lingering, and isn't set up by this tool.
- `forge persistent preflight` checks all of this and changes nothing. If the host is unsupported it says so, and it
  never falls back to an unprotected key file. Quick connect keeps working either way.

### Fresh host

```sh
sudo forge persistent preflight --user alice
sudo forge persistent install --user alice                    # dry run: prints the plan and unit
sudo forge persistent install --user alice --apply \
  --recovery-file /root/turenos-recovery.key
```

`--data-root` selects the pinned data root (default `/var/lib/turenos-server`). On a re-run it defaults to the installed value.
Moving an installed server to another data root or account is refused.
Persistent commands have no `--port` option. The socket path is fixed.

`install --apply` does the following:

1. Stops an installed service, then creates or takes back the `/var/lib/turenos-server` data root (owned by the
   service user, `0700`) with pinned XDG directories and `FORGE_DB`, away from the default path that the legacy
   quick-connect shim uses. An import is copied and promoted here.
2. Generates a 32-byte key and a key ID exactly once. It writes the recovery copy (`0400`) and the non-secret key ID to
   `/etc/credstore/forge-secret-vault-key-id`, then encrypts the key into
   `/etc/credstore.encrypted/forge-secret-vault-key` through `systemd-creds encrypt` on stdin.
3. Generates the HTTP password and encrypts it as `forge-server-password`.
4. Creates `turenos-operators` if needed. Writes `/etc/systemd/system/turenos.service`, then enables and restarts the service.
5. Waits for `/global/server` and checks the server ID, key ID, and mode.
6. Only then writes `/etc/turenos/attach.json` (`0640 root:turenos-operators`). A server
   that never became healthy leaves no record, so it cannot block quick connect on this host.

Only one `install --apply` runs at a time. The lock is a file holding the owner's PID at `/run/turenos-install.lock`
(root-only, cleared on reboot). It is taken after the root and Linux checks pass and held through planning. A second
install fails with "another install is running". If the owner has exited, as after a crash, the next install takes the
lock over, serialized through a short-lived `/run/turenos-install.lock.takeover` guard file. A live owner, an empty or
unreadable PID, or a guard that is present reports the same message; when no install is running, delete the lock file
(and the guard, if a crash left it) and re-run. As non-root or off Linux, `install --apply` never touches `/run`: it
prints the preflight problem ("setup must run as root (for example with sudo)" or "persistent Linux setup runs only on
Linux") and fails with "preflight failed; nothing was changed". A recovery file left by an install that failed before
finishing makes the re-run refuse with the steps to take: delete it if nothing was sealed with it, or import the key it
holds with `--key-stdin`.

Move the recovery copy offline, then delete it from the host. Host-bound encryption (host key or TPM2) isn't a backup.
Add every user who may attach to `turenos-operators`, then reboot once and confirm that the service comes back with the
same key ID.

The unit (`forge persistent unit --user alice` prints it) runs
`forge serve --key-source systemd-credentials --socket-path /run/turenos/server.sock` with
`FORGE_SERVER_MODE=persistent`, `FORGE_SERVER_ID`, and `FORGE_SERVER_PASSWORD_CREDENTIAL`, loading the key through
`LoadCredentialEncrypted=`. It sets `Group=turenos-operators`, `RuntimeDirectory=turenos`, and `RuntimeDirectoryMode=0710`.
The server sets the socket mode to `0660`. No TCP listener starts. No wrapper script exports anything.
Preflight refuses any systemd drop-in for
`turenos.service` (`turenos.service.d/*.conf` under `/etc/systemd/system`, `/run/systemd/system`, or
`/usr/local/lib/systemd/system`), and any generic `service.d/*.conf` under `/etc/systemd/system` or
`/run/systemd/system`, because a drop-in can replace `ExecStart`, the account, or the environment of the unit
the installer writes; remove it and re-run. Generic drop-ins that the distribution ships under `/usr/lib` are
left alone.

### Existing data (import or restore)

A database that already holds secrets needs its **original** key. A replacement key is never created.

```sh
# Check, read-only, that the key opens every sealed store (safe while the old server still runs)
printf '%s\n%s\n' "$KEY_ID" "$KEY_BASE64" | forge persistent verify-key --db ~/.local/share/forge/forge.db

# Stop the quick-connect daemon and stage root-owned copies of its data and config under /root
sh ~/.forge/bin/forge-remote stop
sudo install -d -m 700 /root/turenos-import
sudo cp -a --no-preserve=ownership ~/.local/share/forge /root/turenos-import/data   # forge.db, -wal, snapshots, plans, ...
sudo cp -a --no-preserve=ownership ~/.config/forge /root/turenos-import/config      # optional: config, agents, MCP servers
sudo chmod -R go-w /root/turenos-import                                             # cp -a keeps directory modes; see below
printf '%s\n%s\n' "$KEY_ID" "$KEY_BASE64" | sudo forge persistent install --user alice --apply \
  --key-stdin --import-db /root/turenos-import/data/forge.db \
  --import-data /root/turenos-import/data --import-config /root/turenos-import/config
```

The unit pins every XDG directory, so a promoted server never reads the old account's `~/.local/share/forge` or
`~/.config/forge` again. The database alone is not the whole state: sessions refer to snapshot repositories, plans, and
retained tool output under the data directory, and the server's behavior comes from the global config. Import all
three, or accept that history diffs and reverts fail for older sessions and that the server starts with default
configuration. `--import-data` skips database files (they come from `--import-db`), `log`, and `repos` (a regenerable
clone cache). Nothing from `~/.cache` or `~/.local/state` is needed.

Every `--import-*` source must sit in a directory another account cannot write, because root reads it: its parent and
every directory above that must be writable only by root. SQLite running as root follows the WAL, SHM, and lock file
names beside a database and changes the ownership of what it opens, so `--import-db` needs the copied database and its
`-wal` file in such a directory.

`--import-data` and `--import-config` copy a whole tree, so they check it first and refuse the import otherwise. The
staged directory and every copied entry under it (not the skipped `log`, `repos`, and database files) must be owned by
root, and no directory in it may be group- or other-writable, so the account whose data this is cannot swap entries
under root while they are copied. `cp -a` keeps directory modes, and on a host with umask 002 (the user-private groups
on Debian and Ubuntu) a user's directories are `0775`. Copy as root, as above, and run `chmod -R go-w` on the staging
directory afterwards.

`--import-db` verifies the key against the source, then takes the source's owner lock, which refuses a server still
running on it. It copies the database with `VACUUM INTO` into the pinned data root and leaves the original untouched as
rollback material, apart from removing the owner lock files the import itself created beside it. It applies pending
schema migrations to the verified destination, then **promotes** the copy: the owner record becomes `persistent` for
the new server ID. Older quick-connect binaries don't take the owner lock, so always
stop the daemon first. Because the promoted data lives outside the default path, an older desktop can only start a
separate, empty quick-connect server. It can never open the promoted database.

An import that is interrupted leaves a partial data root; remove it (`rm -rf /var/lib/turenos-server`) and run the
import again. The staged copies and the original data are untouched.

**Restoring a persistent server's backup** uses the same commands with the backup's own server ID: a backup keeps its
`persistent` owner record, and `--import-db` refuses it under any other ID, naming the ID to pass as `--server-id`. An
import only goes into a data root with no database, so on the original host remove the old data root first. On a new
host, import the original key with `--key-stdin`. A host that still has its vault key credential refuses `--key-stdin`
and reuses the installed key instead, so there leave `--key-stdin` out; the backup must have been sealed with that key.
Never copy a TPM-bound or host-bound credential blob to another machine.

```sh
# On a new host
printf '%s\n%s\n' "$KEY_ID" "$KEY_BASE64" | sudo forge persistent install --user alice --apply \
  --key-stdin --server-id srv_... --import-db /root/turenos-restore/forge.db --import-data /root/turenos-restore
```

### Operating

| Task                       | Command                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status and logs            | `systemctl status turenos`, `journalctl -u turenos`                                                                                                                                                                                                                                                                                                                 |
| Stop or retire the service | `systemctl disable --now turenos`. Clients never stop a persistent server                                                                                                                                                                                                                                                                                           |
| Re-run or upgrade          | `sudo forge persistent install --apply` reuses the installed account, data root, server ID, and binary, then restarts. Use `--forge-bin` to switch binaries. It refuses key replacement, account or data root changes, and a unit for another server. |
| Check what a key opens     | `forge persistent verify-key --db <path>` (key on stdin)                                                                                                                                                                                                                                                                                                            |

### Failure behavior

A missing credential, wrong key bytes, several key IDs, a database owned by another server, or a key or password in the
environment all stop startup before the server accepts work. Configuration errors (missing or invalid credentials, a
key or password in the environment, a unit without `FORGE_PERSISTENT_UNIT=1`, a missing or unsafe socket path, or `--mdns`)
exit with status 78 and a one-line message saying what to fix.

If a step fails before the restart, `install` starts a service that was running again. If a newly installed service
doesn't become healthy, `install` names the last health-check result (for example `HTTP 404` or a refused connection),
prints the last journal lines, then stops and disables the service so it doesn't keep
restarting. It doesn't disable a service that was already installed. Preflight refuses a data root that belongs to another account.
The unit restarts the service on failure, at most five times in 300 seconds, and never after exit
status 78 (a configuration error such as a missing credential or a unit written by a different forge). Fix the cause,
then re-run `install --apply` or `systemctl reset-failed turenos` and start the service.

While `install` works in the data root, the root and its managed directories belong to root. A failure hands them
back before the service is started again. If the process itself dies there (a dropped SSH session, Ctrl-C under
`sudo`), the data root stays root-owned and the service cannot start; preflight reports it as an interrupted setup, and
the next `install --apply` finishes handing it back.

## Clients

A desktop detects the attach record before touching the shim. SSH forwards a private local Unix socket to the remote Unix socket.
The reserved desktop loopback TCP listener proxies that local socket. The desktop verifies the descriptor and never sends its own key.
Removing or disconnecting the client leaves the
server running. See [Managed persistent servers](./ssh-remote/managed-persistent.md).
