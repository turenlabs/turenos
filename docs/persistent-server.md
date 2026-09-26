# Persistent server

A persistent server is one long-running `forge serve` that owns a database and its vault key on a host. Every client
(the GUI on the host, a GUI on another computer, and later the TUI) attaches to it. SSH authenticates and tunnels
clients; it never supplies the server's key. SSH quick connect ([SSH remote servers](./ssh-remote.md)) keeps working
unchanged for hosts that haven't been promoted.

Status: the Linux systemd path is implemented. macOS adoption (LaunchDaemon plus the Keychain or root-launcher key
source) and promoting an SSH quick-connect remote from the desktop haven't shipped yet.

## What protects what

- **Vault key.** It lives in the host's protected store: systemd encrypted credentials on Linux. `forge` reads it
  itself, and it never appears in argv, the environment, the unit file, logs, or HTTP responses.
- **HTTP password.** It is stable, stored separately from the key, and handed to authorized SSH users through the
  attach record.
- **Scope.** Agent tools run as the service account and can read whatever that account can. The vault protects data at
  rest, backups, other local users, and clients. It does not isolate tools.

### Setup runs as root

`install` works as root inside a data root that belongs to the service account. It prevents that account from
redirecting root's work:

- **Service account.** The account must not be root.
- **Data root location.** The data root's parent, and every directory above it, must be writable only by root. The
  data root itself must not be a symlink.
- **Taking the data root back.** Before working in it, `install` stops the service and makes the data root and every
  managed directory in it root-owned `0700`. It refuses any managed directory or database file that is a symlink or a
  hard link. When it finishes, it hands ownership back with `lchown`, which never follows links.
- **Service binary and recovery copy.** The binary the unit runs (`--forge-bin`, default: the running `forge`, resolved
  through links) must be a root-owned file in directories only root can write, since it receives the key and
  password. The `--recovery-file` directory must also be writable only by root.
- **Unit values.** Values written into the unit (account, server ID, paths, port) are limited to characters that can't
  split or reinterpret a unit line.
- **Credential files.** Credential blobs are kept `0600`. Files with secrets are written through the opened file,
  never by path.
- **Password check.** The server compares the HTTP password in constant time.

### Known limits

- **Other local users and the port.** The listener is a loopback TCP port, so while the service is down another local
  user could bind it and collect the password from a client that connects. The desktop checks the descriptor's server
  ID and mode, but only after it has sent credentials. Quick connect has the same limit. A Unix-socket listener with
  group permissions would remove it.
- **Credentials inside the service.** `$CREDENTIALS_DIRECTORY` is readable by the service account, and so by agent
  tools, as described under Scope.
- **`forge` commands run by tools.** Tools inherit the pinned `FORGE_DB` and persistent mode. A `forge` CLI command
  run by a tool passes the owner check and can open the database. `forge serve` still fails on the owner lock.

## Contracts

- **Descriptor.** `GET /global/server` (authenticated). Fields: `serverID`, `dataIdentity { databasePath, databaseUUID }`,
  `keyID`, `mode`, `keySource`, `listener`, `version`. It never contains key bytes or the password.
- **Attach record.** `{ "version": 1, "serverID", "url", "username", "password" }`, where `url` is the host loopback
  listener, at `/etc/turenos/attach.json` (`0640 root:turenos-operators`). Clients read this record, never a process
  environment.
- **Ownership.** The owner lock sits beside the database. The owner record inside the database refuses any other
  process on a persistent database, before migrations run. See
  [Secure storage](./secure-storage.md#database-identity-ownership-and-verification).

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

`install --apply` does the following:

1. Generates a 32-byte key and a key ID exactly once. It writes the recovery copy (`0400`), encrypts the key into
   `/etc/credstore.encrypted/forge-secret-vault-key` through `systemd-creds encrypt` on stdin, and writes the
   non-secret key ID to `/etc/credstore/forge-secret-vault-key-id`.
2. Generates the HTTP password and encrypts it as `forge-server-password`.
3. Creates the `/var/lib/turenos-server` data root (owned by the service user, `0700`) with pinned XDG directories and
   `FORGE_DB`, away from the default path that the legacy quick-connect shim uses.
4. Writes `/etc/turenos/attach.json` (`0640 root:turenos-operators`, creating the group if needed) and
   `/etc/systemd/system/turenos.service`, then runs `systemctl enable --now`.
5. Waits for `/global/server` and checks the server ID, key ID, and mode.

Move the recovery copy offline, then delete it from the host. Host-bound encryption (host key or TPM2) isn't a backup.
Add every user who may attach to `turenos-operators`, then reboot once and confirm that the service comes back with the
same key ID.

The unit (`forge persistent unit --user alice` prints it) runs
`forge serve --key-source systemd-credentials --hostname 127.0.0.1 --port 4097` with
`FORGE_SERVER_MODE=persistent`, `FORGE_SERVER_ID`, and `FORGE_SERVER_PASSWORD_CREDENTIAL`, loading the key through
`LoadCredentialEncrypted=`. No wrapper script exports anything.

### Existing data (import or restore)

A database that already holds secrets needs its **original** key. A replacement key is never created.

```sh
# Check, read-only, that the key opens every sealed store (safe while the old server still runs)
printf '%s\n%s\n' "$KEY_ID" "$KEY_BASE64" | forge persistent verify-key --db ~/.local/share/forge/forge.db

# Stop the quick-connect daemon and copy its database into a directory only root can write
sh ~/.forge/bin/forge-remote stop
sudo install -d -m 700 /root/turenos-import
sudo cp ~/.local/share/forge/forge.db /root/turenos-import/   # and forge.db-wal, if it exists
printf '%s\n%s\n' "$KEY_ID" "$KEY_BASE64" | sudo forge persistent install --user alice --apply \
  --key-stdin --import-db /root/turenos-import/forge.db
```

`--import-db` refuses a source in a directory another account can write, because SQLite running as root follows the
WAL, SHM, and lock file names beside a database and changes the ownership of what it opens. It verifies the key against
the source, then takes the source's owner lock, which refuses a server still running on it. It copies the database with `VACUUM INTO` into the pinned data root and leaves the original
untouched as rollback material. Finally it **promotes** the copy: the owner record becomes `persistent` for the new
server ID. Older quick-connect binaries don't take the owner lock, so always stop the daemon first. Because the
promoted data lives outside the default path, an older desktop can only start a separate, empty quick-connect server.
It can never open the promoted database.

To restore on a new host, import the original key and ID the same way. Never copy a TPM-bound or host-bound credential
blob to another machine.

### Operating

| Task | Command |
| --- | --- |
| Status and logs | `systemctl status turenos`, `journalctl -u turenos` |
| Stop or retire the service | `systemctl disable --now turenos`. Clients never stop a persistent server |
| Re-run or upgrade | `sudo forge persistent install --apply` with no other options reuses the installed unit's account, data root, port, and server ID, then restarts the service. It refuses to replace an existing key, to change the account or data root of an installed server, or to overwrite a unit for a different server |
| Check what a key opens | `forge persistent verify-key --db <path>` (key on stdin) |

### Failure behavior

A missing credential, wrong key bytes, several key IDs, a database owned by another server, or a key or password in the
environment all stop startup before the server accepts work.

If a newly installed service doesn't become healthy, `install` prints the last journal lines, then stops and disables
the service so it doesn't keep restarting. It doesn't touch a service that was already installed. Preflight refuses a
port another process holds (quick connect prefers 4096, so the default here is 4097) and a data root that belongs to
another account. The unit restarts the service on failure. Each restart
fails the same way until the operator fixes the cause.

## Clients

A desktop that adds this host over SSH detects the attach record before touching the shim, tunnels to the loopback
listener, and verifies the descriptor. It never sends its own key. Removing or disconnecting the client leaves the
server running. See [SSH remote servers](./ssh-remote.md#managed-persistent-servers).
