# TurenOS terminal client

The TUI (`packages/tui`, `@turenlabs/tui`) is a keyboard-first terminal client for a running TurenOS server, written in TypeScript on Bun and OpenTUI. It renders locally and keeps only process-local interaction state (drafts, reading positions, preferences); sessions, tools, model execution and persistent data stay on the server, so work started here continues in TurenOS Desktop and the reverse. It is a source CLI: it needs Bun and the installed `node_modules`, including OpenTUI's native modules. There is no compiled binary and no bundled server.

[Usage](./usage.md) covers keys, connecting and commands, [GUI parity](./gui-parity.md) maps desktop features to TUI keys, and [TUI development](../../development/tui.md) covers tests and the PTY audit.

## Process shape

```text
src/cli.ts -> runTui (src/index.ts) -> mountApp (src/dashboard/app.ts)
                                         |-- server picker + target resolution (src/servers/)
                                         `-- one mountDashboard per connected server
dashboard -> Connection (src/server/) -> HTTP(S) TurenOS server, directly or through a private SSH tunnel
```

`src/cli.ts` parses arguments and `src/tui-auth.ts` resolves credentials for an explicit URL. `runTui` requires an interactive stdin and stdout, starts the OpenTUI renderer and hands it to `mountApp`. `mountApp` owns the server picker and the dashboard for the connected server. It resolves a target to an endpoint and mounts the new dashboard before disposing the old one, so a failed switch leaves the current dashboard untouched. `dispose()` removes the dashboard's key and resize listeners, timers, live stream, connection and renderables without destroying the renderer. The package depends on the workspace `@turenlabs/client` (the generated Promise client) and on no other TurenOS runtime package.

## Module map

Every feature folder under `packages/tui/src/` has a façade module beside it (`harness.ts` for `harness/`, `index.ts` for `dashboard/`) that exposes the feature's controls; the folder holds the implementation. Files stay under 400 lines and functions under 60, enforced by the root lint job.

| Area                | Paths under `src/`                                                                        | Responsibility                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Entry               | `cli.ts`, `tui-auth.ts`, `index.ts`, `terminal-exit.ts`                                   | Argument parsing, credential resolution, `runTui`, and restoring terminal input state on exit.                                             |
| Dashboard           | `dashboard/`, `state.ts`                                                                  | `mountApp` and `mountDashboard`, key routing, pointer handling, commands, refresh polling, and the process-local `DashboardState`.         |
| Layout and chrome   | `layout/`, `chrome.ts`, `theme.ts`, `activity.ts`, `logo.ts`, `context-meter.ts`          | Sidebar, transcript pane, footer and resize handling; labels, colors, reduced-motion activity indicator and the context-window meter.      |
| Input and dialogs   | `dialogs/`, `keys.ts`, `secret-field.ts`, `panel.ts`, `picker.ts`, `copy.ts`, `editor.ts` | Modal focus, exact-modifier shortcuts, masked password field, split-pane and list dialogs, selection copy, and `$VISUAL`/`$EDITOR` drafts. |
| Completion          | `suggest/`, `slash/`, `mentions/`, `prompt-files.ts`                                      | The shared editor-completion popup, directory-scoped slash commands, `@` file mentions and mention-to-attachment parsing.                  |
| Conversation        | `conversation/`, `messages.ts`, `markdown/`, `session-list.ts`                            | Latest and history views, reading position, sanitized message content, Markdown rendering and the session list.                            |
| Live stream         | `live-events/`, `live-projection/`, `live-session/`                                       | The bounded SSE transport, projection of text and tool events onto the transcript, reconnect and paint cadence.                            |
| Submissions         | `launch/`, `requests/`, `queue/`, `rewind/`, `diff.ts`                                    | New-session launch, reply drafts, permissions and questions, queued inputs, undo and redo with the staged file patches.                    |
| Session actions     | `session-actions/`, `session-controls/`, `menus/`                                         | Rename, archive, delete, tasks and parent navigation; agent and compaction controls; the finder, help, folders and information menus.      |
| Models              | `models/`, `model-variants/`, `model-connections/`                                        | Model and variant selection and provider setup flows.                                                                                      |
| Goals and harness   | `goal-controls/`, `harness/`                                                              | Read-only goal and session-harness overviews with revision-guarded confirmations.                                                          |
| Servers             | `servers/`, `server-picker/`, `server/`, `working-folders/`                               | Target discovery, saved servers, SSH tunnels and the private server; the picker UI; the `Connection`; folders shared with Desktop.         |
| Remote adapters     | `api.ts`, `providers/`, `response-validation/`                                            | Bounded JSON requests for routes the generated client lacks, legacy provider routes, and runtime validation of every displayed field.      |
| Panels              | `changes/`, `files/`, `attach/`, `terminals/`, `automations/`, `swarm/`, `inspect/`       | Review panel, file browser, PTY attach and terminals, automations, swarm room, and tool and trace views.                                   |
| Settings and Extend | `settings/`, `extensions/`, `memories/`, `intel/`                                         | Settings sections, the extension catalog, the memory manager and threat intel.                                                             |

## Transport

`src/server/transport.ts` supplies the fetch used by the generated client. It refuses redirects, applies a ten-second deadline per request (130 seconds for `POST /api/session/:id/shell`, which the server runs for up to 120 seconds, and ten minutes for compaction, which has no request ID to retry under) and rejects response bodies over 8 MiB or 8,192 chunks before any parsing. A `401` or `403` becomes an `UnauthorizedError`, which the snapshot treats as a failure rather than an empty inventory. `src/api.ts` applies the same limits (no redirects, 8 MiB, ten-second default deadline) to routes the generated client does not cover, and `src/providers/request.ts` does so for the legacy provider routes, with a five-minute deadline for OAuth completion.

`src/response-validation/` rejects excessive JSON complexity and validates the fields the UI consumes, including identities and directory boundaries; generated types alone are not runtime validation. One unusable item does not reject its page: an invalid, duplicate or unaddressable (a name containing `/`, `\` or whitespace) command is dropped from the inventory, displayed text over 1 MiB is cut and ends with `[truncated: N characters omitted]`, and an assistant message or tool result keeps its first 128 parts followed by an omission marker. Identity, directory and control-character checks stay strict. Display helpers strip unsafe terminal controls.

Credentials use HTTP Basic. Secret-bearing connections require HTTPS, or HTTP to numeric loopback (`127.0.0.1`, `[::1]`); provider secret operations apply the same rule even when the server needs no password. Loopback requests add `NO_PROXY` entries so shell proxy settings cannot divert them.

The server's snapshot (`src/server/snapshot.ts`) reads the location, 100 recent sessions, active sessions (fetched with at most eight concurrent requests when missing from the recent page; one deleted in the meantime is skipped), automations, and `GET /api/pty` for the server location plus each open working folder (at most eight directories, deduplicated by terminal ID). A `404` from the terminal route sets `terminalsAvailable = false` instead of showing an empty inventory. `src/dashboard/refresh.ts` schedules the next snapshot two seconds after the previous one finishes, as reconciliation beside the live stream.

## Live stream

`src/live-events/stream.ts` reads `GET /api/event` with a streaming fetch, because buffering to EOF would defeat live delivery. It refuses redirects, requires a `text/event-stream` content type, allows ten seconds for response headers and 45 seconds of idle time between chunks, and limits one pending frame to 1 MiB. A frame over that limit, with invalid UTF-8, or that is not a valid event envelope is dropped whole and reading continues. The stream has no lifetime byte cap. Aborting releases the reader and timers.

`src/live-projection/` projects text, reasoning and tool events for the selected session onto the transcript. Events for other sessions are dropped, duplicate event IDs are ignored, and a full completion value is authoritative. There is no fragment offset or replay guarantee, so a delta without a known base is dropped until a snapshot or completion arrives. The server bounds each subscriber's queue and drops events for a slow reader, so the client tracks the durable `seq` of each session (`src/live-session/sequence.ts`); a jump refetches that session's transcript, although streamed deltas themselves cannot be recovered. The final `step.ended` of a turn clears the session's running marker at once, and the next snapshot reconciles it. `src/live-session/schedule.ts` batches paints at 50 ms and coalesces snapshot refreshes. A transcript load requested while one for the same view is in flight runs once more after it instead of discarding it (`src/conversation/load.ts`). The `server.connected` event triggers a catch-up snapshot after the subscription is installed; a dropped stream reconnects with bounded backoff.

## Server discovery and switching

`src/servers/` turns a target into an endpoint of `{url, username, password}` and proves it with an authenticated `GET /global/health` (`src/servers/verify.ts`) before any dashboard is built on it. A `401` or `403` closes the endpoint and reports the rejected credentials.

| Local record               | Written by                                  | Accepted when                                                                                                                             |
| -------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop `attach.json`      | TurenOS Desktop, in its user-data directory | Owned by this user, not writable by others, its `pid` is alive, and the file was written after that process started.                      |
| `~/.forge/run/server.*`    | The quick-connect shim                      | Owned by this user, not writable by others, its pid is alive, and `server.pid` and `server.auth` were written after that process started. |
| `/etc/turenos/attach.json` | The persistent-server installer (Linux)     | Root-owned and not writable by others.                                                                                                    |

A record must point at `http://127.0.0.1:<port>` with no path. Pids are reused, so a record last written before its pid started (read from `/proc` on Linux and `ps` on macOS; `src/servers/freshness.ts`) is stale and ignored rather than trusted with its password. When a record names a `serverID` and the server publishes `GET /global/server`, the two must match. Chromium's `SingletonLock` only detects a running desktop that publishes no record, so the picker can tell the user to update it; it never yields credentials. A headless server on port 4096 is offered only when `FORGE_SERVER_PASSWORD` is set and `FORGE_CLIENT` is not `desktop`.

**Private server.** The picker can start `forge serve --hostname 127.0.0.1 --port 0` with a random password; its child process is killed when the client quits. When the desktop's data directory is shared with the CLI (no `FORGE_DB`, default `XDG_DATA_HOME`), it is refused while TurenOS or TurenOS Beta runs, because session drains are process-local.

**SSH.** The path mirrors TurenOS Desktop's quick-connect (`src/servers/ssh.ts`):

1. One `BatchMode=yes` `ssh ... sh -s` probe reads the persistent attach record, then runs `forge-remote status`. Output is parsed from anchored `FORGE_ATTACH` and `FORGE_REMOTE` lines, so a login banner cannot fake a result.
2. `ssh -N -L <private socket>:127.0.0.1:<port>` forwards the server to a socket in a `mkdtemp` directory, and a loopback TCP proxy owned by this process forwards to that socket.
3. `forge-remote ensure` runs only when `FORGE_SECRET_VAULT_KEY_ID` and `FORGE_SECRET_VAULT_KEY` are set, and the key goes on stdin, never in arguments.

Destinations, users, ports and identity files are validated so they cannot smuggle ssh options. The desktop's saved SSH list comes from `GET /global/storage` on the desktop's own server and holds no secrets. Saved servers live in `$XDG_CONFIG_HOME/turen-tui/servers.json` (default `~/.config/turen-tui/servers.json`), written `0600` through a temporary file and a rename, and never contain passwords. Passwords typed into the picker stay in process memory.

## Harness panel

`src/harness/` follows the same read, confirm, act split as goals for the server's session harness, the surface Desktop's Harness panel shows.

- **Overview.** Opening the harness is GET-only. It lists the offered changes: approve and apply, apply, reject, reload, and roll back to the previous version.
- **Confirmation.** Each change needs its own `Ctrl+S` confirmation, which shows the proposal's changes, tools, guidance and validation.
- **Before sending.** The client rereads the harness and sends nothing unless the proposal is still actionable and the snapshot version is unchanged.
- **Retries.** After an uncertain result, a retry only rereads state and reports the observed outcome; it never repeats the write. A definite rejection (a 4xx other than 408 or 409) is an ordinary failure that can be retried, and a proposal already approved resumes with apply only.
- **Task-owned sessions.** A child session owned by a task cannot be changed directly; the dialog points at the owning session.

`src/goal-controls/` applies the same pattern to goals: it captures the session and goal revision, rereads both before any mutation, and carries `expectedRevision` on edit, status and clear so a conflict requires reopening.

## Remote compatibility

The client needs the current `/api/` contracts for location, agents, sessions, messages, tasks, pending input, permissions, questions, loops, terminals (`/api/pty`) and the session harness, plus `GET /global/health` to verify a server. It deliberately keeps these compatibility routes:

| Route                                                                                                                                                                              | Use                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /provider`, `GET /provider/auth`                                                                                                                                              | Directory-scoped model catalog and authentication methods.                               |
| `PUT /auth/:providerID`                                                                                                                                                            | Save a server-global provider API key.                                                   |
| `POST /provider/:providerID/oauth/authorize`, `POST /provider/:providerID/oauth/callback`                                                                                          | Server-mediated OAuth.                                                                   |
| `GET /global/config`, `PATCH /global/config`                                                                                                                                       | Custom-provider preflight and global configuration write.                                |
| `PATCH /session/:sessionID`                                                                                                                                                        | Rename, or archive and restore, a session.                                               |
| `src/api.ts` routes such as `/file`, `/file/content`, `/vcs/diff`, `/extension`, `/provider/usage`, `/global/permission-checks`, `/experimental/tool` and `/experimental/worktree` | Review, file browser, extensions, usage, permission checks, tool list and new worktrees. |

The session `PATCH` acknowledgement is validated as a legacy response and the client then fetches the session through `/api/session/:sessionID`. Provider configuration and key storage are separate writes, so a custom-provider save is not atomic. Legacy provider writes do not establish which credential the server will use at run time: inspect the server's active integration and configuration rather than assuming another save selects the intended key.

A missing terminal route leaves sessions usable and reports the terminal inventory as unavailable, and a missing harness route only makes the harness view say so. There is no compatibility guarantee for older servers, OpenCode servers or every route the generated client contains.

## Limits

- Drafts, reading positions and UI preferences are process-local; nothing is persisted to disk, and discarding a draft cannot retract a request the server already received.
- Replies, launches and goal or harness changes keep their message IDs, recipients and frozen choices across ambiguous failures, so a retry cannot retarget another session.
- File mentions are resolved by the server: `@` queries `GET /api/fs/find`, and submission sends a native `prompt.files` entry with a `file://` URI. The client never reads a mentioned path.
- It covers most desktop features but not all; [GUI parity](./gui-parity.md) lists what stays desktop-only.
- Tests and the PTY audit run against synthetic fixtures on Linux. No other platform is verified.

## Origin

The code started in the standalone `turen-tui` repository, which derived from the TurenOS terminal client, which derives from OpenCode. The repository `NOTICE` and `LICENSE` carry the attribution. OpenTUI and other dependencies keep their own licenses, and the native-library license, author and patent notices must be preserved when redistributing dependencies or any future binary.

## Source

- `packages/tui/src/cli.ts`, `packages/tui/src/tui-auth.ts`, `packages/tui/src/index.ts`
- `packages/tui/src/dashboard/app.ts`, `packages/tui/src/dashboard/refresh.ts`
- `packages/tui/src/server/transport.ts`, `packages/tui/src/server/snapshot.ts`, `packages/tui/src/api.ts`
- `packages/tui/src/providers/request.ts`, `packages/tui/src/response-validation.ts`
- `packages/tui/src/live-events/stream.ts`, `packages/tui/src/live-projection.ts`, `packages/tui/src/live-session/schedule.ts`
- `packages/tui/src/servers/discovery.ts`, `packages/tui/src/servers/records.ts`, `packages/tui/src/servers/resolve.ts`
- `packages/tui/src/servers/ssh.ts`, `packages/tui/src/servers/headless.ts`, `packages/tui/src/servers/saved.ts`, `packages/tui/src/servers/verify.ts`
- `packages/tui/src/harness.ts`, `packages/tui/src/harness/confirm.ts`, `packages/tui/src/goal-controls.ts`
- `packages/tui/src/server/queries.ts`, `packages/tui/src/prompt-files.ts`
- `packages/tui/package.json`
