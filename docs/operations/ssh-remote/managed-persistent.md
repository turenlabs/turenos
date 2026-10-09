# Managed persistent servers

How the desktop attaches to a host that runs a [persistent server](../persistent-server.md) instead of starting its own
quick-connect server there.

A promoted host owns its vault key and runs the server under its service manager. The desktop must neither start it nor
send it a key. That is why `connectSshRemote` checks for one **before** it writes the shim or runs `ensure`:

1. It sends [`REMOTE_ATTACH_PROBE_SCRIPT`](../../../packages/desktop/src/main/ssh/persistent.ts) over the control
   master on stdin. The script contains no secrets. It reports whether `/etc/turenos/attach.json` (Linux system
   service, `0640 root:turenos-operators`) exists and is readable. A `/etc/turenos` this user cannot search reports
   unreadable, never missing.
2. `classifyAttach` turns the report into one of three results:

   | Result                | Meaning                                                                                                         | Action                                                |
   | --------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
   | `attach-existing`     | A valid version 2 attach record names `/run/turenos/server.sock`                                                | Tunnel to it. No shim write, no `ensure`, no key sent |
   | `start-quick-connect` | No record, and the target was never persistent                                                                  | The quick-connect path                                |
   | `conflict`            | Record unreadable or malformed, a saved persistent target has no record, or the record names a different server | Fail closed with an actionable message                |

3. For `attach-existing`, SSH forwards a private local Unix socket to the remote Unix socket.
   The reserved desktop loopback TCP listener proxies the local socket.
   The desktop reads the authenticated `GET /global/server` descriptor.
   It keeps the connection only if `serverID` matches the record and `mode` is `persistent`.
   A rejected request fails at once rather than waiting out the health timeout.

The version 2 record contains `serverID`, `socketPath`, `username`, and `password`, not `url`.
Only `/run/turenos/server.sock` is accepted. Version 1 TCP records are rejected.
The remote persistent service has no TCP listener. Quick connect keeps its existing transport.
Basic auth remains defense in depth. A copied password cannot bypass remote Unix socket permissions.

The probe runs for every SSH user, so a promoted host offers no quick connect: members of `turenos-operators` attach to
the shared server, and every other user gets the unreadable conflict. The probe reuses the SSH control master.
An existing login keeps its original groups. After a group change, close the old SSH login and start a new one.
The master can also expire after `ControlPersist` (10 minutes) without active channels.
To revoke access, remove group membership and disconnect existing SSH channels and sessions.
Group removal alone does not close existing connections. See
[Persistent server known limits](../persistent-server.md#known-limits).

## After the first attach

The first successful attach saves `persistent: { serverID }` on the `SshServerConfig`. The password is never saved in
desktop storage; it is re-read from the attach record on every connect. After that:

- **Disconnect.** On a persistent target, the Stop menu item reads "Disconnect". It closes only this client's tunnel
  and sends nothing to the host. The ssh master may be shared with other clients of the same host, so it is left to
  expire through `ControlPersist`.
- **Remove.** Removing the target deletes the saved entry and disconnects. Neither action runs `forge-remote stop`.
- **Stop server.** Stopping or retiring the service is an operator action on the host (`systemctl stop turenos`).
- **Updates.** Install and update actions are hidden, and the SSH user's forge version isn't probed, because the host's
  service setup owns the binary. The version shown beside the target is the service's own, from its descriptor; when
  it differs from the desktop's, the row says so and the fix is `sudo forge persistent install --apply` on the host
  with the new binary.

Desktop shutdown (`stopAll`) disconnects only.

## Source

- [`packages/desktop/src/main/ssh/persistent.ts`](../../../packages/desktop/src/main/ssh/persistent.ts): the attach
  probe, attach record parsing, `classifyAttach`, and the descriptor check.
- [`packages/desktop/src/main/ssh/connection.ts`](../../../packages/desktop/src/main/ssh/connection.ts): where
  `connectSshRemote` runs the probe before the quick-connect path.
- [`packages/desktop/src/main/ssh/servers.ts`](../../../packages/desktop/src/main/ssh/servers.ts): saving the
  persistent target, Disconnect, and Remove.
- [`packages/desktop/src/main/ssh/persistent.test.ts`](../../../packages/desktop/src/main/ssh/persistent.test.ts): runs
  the real probe script and attaches through a fake `ssh` without sending the vault key.
