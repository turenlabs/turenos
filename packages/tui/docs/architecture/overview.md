# Architecture

Turen TUI owns terminal rendering and temporary interaction state; a remote TurenOS server owns sessions, persistent data, model execution, and tools.

## Components

```text
standalone CLI
  -> runTui -> mountApp
       -> server picker + target resolution (servers.ts)
       -> one mountDashboard per connected server
  -> connection and provider adapters
  -> HTTP(S) TurenOS server (directly, or through a private SSH tunnel)
```

The standalone [src/cli.ts](../../src/cli.ts) parses arguments and [src/tui-auth.ts](../../src/tui-auth.ts) resolves credentials for an explicit URL. [src/index.ts](../../src/index.ts) exports `runTui`, `mountApp`, and `mountDashboard`. `runTui` requires interactive stdin/stdout, starts OpenTUI, and hands the renderer to `mountApp`. `mountApp` owns the server picker and the dashboard for the connected server. It resolves a target to an endpoint and mounts the new dashboard before disposing the old one, so a failed switch leaves the current dashboard untouched. `dispose()` removes the dashboard's key and resize listeners, timers, live stream, connection, and renderables without destroying the renderer. No server is bundled. The optional private server is the installed `forge` CLI, started only when you choose it and stopped when you quit.

| Files under `src/`                                        | Responsibility                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `index.ts`, `state.ts`                                    | Dashboard lifecycle, polling, selection, and process-local state.                  |
| `layout.ts`, `chrome.ts`, `theme.ts`, `activity.ts`       | Layout, labels, colors, and reduced-motion activity.                               |
| `dialogs.ts`, `keys.ts`                                   | Modal focus, editor input, and exact-modifier shortcuts.                           |
| `suggest.ts`                                              | Shared editor-completion popup: bounded rows and generation-guarded inventory.     |
| `slash.ts`                                                | Directory-scoped suggestions and shared keyboard/mouse command admission.          |
| `mentions.ts`, `prompt-files.ts`                          | `@` file search over that popup, and mention-to-attachment parsing.                |
| `conversation.ts`, `messages.ts`, `markdown.ts`           | Latest/history views, reading position, sanitized content, and rendering.          |
| `live-events.ts`, `live-projection.ts`, `live-session.ts` | Bounded live SSE transport, text/tool projection, reconnect and rendering cadence. |
| `launch.ts`, `requests.ts`                                | Launch/reply drafts, permissions, questions, and interruption.                     |
| `menus.ts`, `session-actions.ts`                          | Search scopes, paging, tasks, rename, archive/restore, and parent navigation.      |
| `models.ts`, `model-variants.ts`, `model-connections.ts`  | Model/variant selection and provider setup UI.                                     |
| `goal-controls.ts`                                        | Read-only goal overview and revision-guarded execution confirmations.              |
| `harness.ts`                                              | Read-only session-harness overview and state-checked proposal/snapshot changes.    |
| `servers.ts`                                              | Server targets: local discovery, saved servers, SSH tunnels, the private server.   |
| `server-picker.ts`, `secret-field.ts`                     | Full-screen server chooser and the masked password field it shares.                |
| `panel.ts`, `picker.ts`                                   | Wide split view (chooser plus content) and the list dialogs settings are built on. |
| `changes.ts`, `files.ts`                                  | Review panel (git, branch, last-turn diffs) and read-only file browser.            |
| `attach.ts`, `terminals.ts`                               | Interactive PTY attach over the ticketed WebSocket; terminal create/rename/close.  |
| `queue.ts`, `swarm.ts`, `inspect.ts`, `context-meter.ts`  | Queued inputs, swarm room, tools and trace views, and the context-window meter.    |
| `automations.ts`                                          | Automation create, edit, pause/resume, run now, runs, and delete.                  |
| `settings.ts`, `extensions.ts`, `memories.ts`, `intel.ts` | Settings sections, the Extend catalog, the memory manager, and threat intel.       |
| `api.ts`                                                  | Bounded JSON requests for server routes the generated client does not cover.       |
| `diff.ts`                                                 | Bounded, sanitized display lines for a staged revert's per-file patches.           |
| `editor.ts`                                               | `$EDITOR` resolution, private draft-file lifecycle, and the child process.         |
| `server.ts`, `providers.ts`, `response-validation.ts`     | Remote adapters, request constraints, and response validation.                     |

The original TUI modules were copied from the source working tree; standalone startup and subsequent client improvements are maintained independently. See [provenance](../reference/provenance.md).

## State and requests

[server.ts](../../src/server.ts) builds a snapshot from location, recent sessions, active sessions, terminal inventory, and automations. Active sessions missing from the recent page are fetched separately with bounded concurrency. [index.ts](../../src/index.ts) schedules another refresh two seconds after the previous update finishes as reconciliation and fallback.

The server scopes terminals to a location, and the global activity route no longer exists. `Connection.snapshot()` therefore reads `GET /api/pty` for the server location and each open working folder (at most eight, deduplicated by terminal ID), plus the loop list route for automations. Each terminal response must echo the requested directory. A `404` terminal response is represented as `terminalsAvailable = false` so a server without the route produces an explicit message instead of looking like an empty inventory. Automation details fetch at most ten recent runs after rendering the schedule overview; a run-history failure does not erase that overview.

[attach.ts](../../src/attach.ts) joins the terminal to a server PTY the way the desktop's terminal pane does. It mints a single-use ticket with `POST /api/pty/:id/connect-token` (Basic auth plus `x-forge-ticket: 1`, scoped to the PTY's location), then opens `ws(s)://…/api/pty/:id/connect?location[directory]=…&ticket=…`. Output arrives as text frames, first the retained buffer and then live output; one binary frame (a zero byte and `{"cursor":N}`) marks where the replay ended. Keystrokes are decoded as streaming UTF-8 and sent as text, because the server silently drops invalid UTF-8 binary. There is no resize message on the socket: size changes go through `PUT /api/pty/:id`. Close code `1000` or `4404` means the PTY ended; any other close reconnects with a fresh ticket from the last cursor, at most five times. `Ctrl+]` (`0x1d`) detaches without sending itself. [terminals.ts](../../src/terminals.ts) suspends the renderer, puts stdin in raw mode for the attach, and always resumes the renderer afterwards, the same handoff `$EDITOR` uses.

[api.ts](../../src/api.ts) covers routes the desktop still reaches through its legacy SDK: `DELETE /session/:id`, `/session/:id/todo` and `/diff`, `/vcs/diff`, `/file` and `/file/content`, `/extension`, `/experimental/tool` and `/worktree`, `/provider/usage`, `DELETE /auth/:id` and `/provider/:id`, `POST /global/dispose`, and `/global/permission-checks`. It applies the same limits as the main transport (no redirects, 8 MiB bodies, the JSON-complexity scanner) and reports the server's own error message. Each view validates the fields it displays before rendering them.

A new worktree is not usable when `POST /experimental/worktree` returns: the server runs `git worktree add --no-checkout`, then checks it out and loads it in the background, and reports `worktree.ready` or `worktree.failed` on `GET /global/event`. `Connection.worktree()` opens that stream (reusing the SSE reader in [live-events.ts](../../src/live-events.ts)) before the request, and the launch creates the session only after the ready event for that directory. The worktree name is fixed per draft, so a retry after an uncertain request lists the project's worktrees and reuses the one that request made; it counts as ready once it holds more than its `.git` file.

The native `GET /api/event` SSE channel provides live-only text/reasoning fragments and tool lifecycle/progress events. Its `server.connected` readiness event triggers a catch-up snapshot after subscription is installed. The client filters events to the selected session, batches paints at 50 ms, coalesces snapshot refreshes, and reconnects with bounded backoff. The per-session `/event` route is durable-only and is not a substitute for this channel. Projections retain bounded active parts, avoid duplicate event IDs and lagging-snapshot text regression, and treat full completion values as authoritative. There is no fragment offset or replay guarantee: deltas without a known base are dropped pending a snapshot/full completion instead of guessed into the transcript.

Session details include messages, tasks, permissions, questions, and pending inputs. Search and detail views discard stale asynchronous results rather than navigating a newer selection. Forms capture their request recipient so a dashboard refresh cannot retarget a pending action.

File mentions are resolved by the server, not this client. `@` queries `GET /api/fs/find` for the editor's directory, and submission turns each mention into a native `prompt.files` entry whose `file://` URI carries any `?start=&end=` line range; the server opens and slices the file at materialization time. The client never reads a mentioned path, which is what lets `@` address a remote server's files. `prompt-files.ts` is a pure parser with no renderer dependency, so the transport layer can build the same payload for launches and replies. A prompt without mentions keeps its original body, so ordinary messages and their retries stay byte-identical to what earlier servers already accept. Search results are validated as relative paths inside the requested location: an absolute, drive-qualified, or `..` path is rejected rather than attached. A `404` from the search route leaves the mention typed by hand and still attached.

The mention grammar has a bare and a quoted form because real paths contain spaces, brackets, and `#`, each of which ends a bare mention. `mentionText` is the single decision point: completion inserts the form that parses back to the offered path, results it cannot represent are filtered out of the picker, and the caret stays inside a quoted folder so its next segment keeps searching. Without that, completing `src/lib[2].ts` would attach `src/lib` — a different existing file. Searches are debounced 250 ms and superseded queries are aborted, so a recursive server search does not run per keystroke.

A message beginning with `!` admits one `POST /api/session/:sessionID/shell` command instead of a prompt, reusing the draft's message ID so an ambiguous failure retries the same submission. The transcript already renders the resulting `shell` message; this is command submission and output display, not an attached or interactive PTY.

Initial dashboard selection prefers a loaded main session without `parentID`; this is a navigation preference, not proof of task ownership. If recent and active metadata contain only children, `snapshot()` also reads a bounded unarchived roots page. Explicit child selection is retained. `Ctrl+X` reuses the root-wide Tasks browser. Conversation `/` opens the existing reply editor without replacing saved text; for a known task-owned child it opens local actions instead. The owning-session action captures its target, fetches it, and opens its reply editor after refresh only if that target is still selected and no other modal is open. Child drafts are not transferred. Composer submissions consult the slash controller before marking the dialog busy, so mouse Send and modified submit keys cannot bypass local actions. Attempted submissions remain locked to their original retry route.

Transcript scrolling commits prepend-height anchors before applying streamed tail growth. Loading position synchronizes layout synchronously (`syncLayout()`) and immediately projects cached live turns, eliminating message flashing and layout jumps upon session switch. Pending older-page responses preserve a subsequent return-to-bottom intent. Docked reply paging expands only cached history, without fetching older pages. Width reflow uses the native text buffer's logical line and display-column mapping for the visible text node; it does not implement its own word wrapping. Destroyed/replaced nodes fall back to existing scroll behavior. Reply sizing uses `lineInfo.lineSources.length`, because the editor's `virtualLineCount` can be viewport-limited.

Terminal hardware cursor management hides the cursor by default across all panes and dialogs (only active when text input fields or textareas are focused). History pagination reading positions are isolated from live streams to prevent cursor movement or terminal visual artifacts.

Launches retain session and message identifiers across ambiguous failures. Replies retain a message identifier, recipient, submitted text, and delivery mode. Retrying an attempted submission requires the original fields; server-side admission semantics determine deduplication. Drafts, reading positions, and UI preferences are process-local, with no disk draft persistence. Discarding them cannot retract a request already received by the server.

[diff.ts](../../src/diff.ts) renders the staged revert the rewind controls already receive. `revert.files[]` arrives with each file's status, added/removed counts, and full patch, and `response-validation.ts` already bounds and validates them; before this the payload was consumed only as a boolean and an identity string, so **Conversation + files** — which restores server files immediately — was confirmed without disclosing what it touched. The module is a pure parser with no renderer dependency: it returns tone-tagged display lines that [rewind.ts](../../src/rewind.ts) turns into one `StyledText`. Patch text is untrusted and only loosely bounded at the transport (2,048 files of 8 MiB each pass validation), so rendering caps files, lines per file, and total lines, marks every truncation explicitly, and routes all text through `display()`. `+++`/`---` headers are classified before the single-character prefixes so a header is never colored as an addition. Disclosure is read-only and issues no request; it does not widen what confirmation itself does.

[editor.ts](../../src/editor.ts) hands one draft to `$VISUAL`/`$EDITOR` and reads back what was saved. The renderer owns the screen and raw stdin, so `dialogs.compose()` resolves the editor command _before_ taking the terminal — nothing is suspended when there is nothing to launch — then suspends the renderer around a `stdio: "inherit"` child and always resumes it, including when the editor fails. The command string is split into argv rather than handed to a shell, so the draft's path is never shell-interpreted. The draft is operator text: it lives in a `mkdtemp` directory as a `0600` file and is removed in a `finally`, even on a non-zero exit. A non-zero exit or an unsaved file keeps the original draft rather than storing a partial edit. Composing is refused while a submission is locked for retry, because retrying requires the original text. The terminal handoff itself is native OpenTUI `suspend()`/`resume()`; file lifecycle, argv parsing, bounds, and the lock are unit-tested, but the handoff needs a real PTY to verify.

[goal-controls.ts](../../src/goal-controls.ts) separates GET-only inspection from explicit mutation confirmation. It captures session identity (including the staged revert boundary) and the goal ID/revision, then rereads both session and goal before mutation. Edit/status/clear carry `expectedRevision`; conflicts require reopening rather than overwriting. Set freezes goal/message IDs, objective, agent, and model for conservative retries after unchanged preflight. Other attempted mutations retry with GET-only reconciliation. Non-clear acknowledgements are checked against the intended session, goal, objective, status, and revision. Set/Resume/active Edit request execution; Pause/Clear stop work through the goal API, without a separate interrupt request. Set also commits staged undo. Ordinary reply drafts are not repurposed as goal objectives.

[harness.ts](../../src/harness.ts) follows the same split for the server's session harness (`/api/session/:id/harness`), the surface TurenOS Desktop's Harness panel shows:

- **Overview.** The overview is GET-only. It lists the offered changes: approve-and-apply or apply, reject, reload, and rollback to the previous version.
- **Confirmation.** Each change needs its own `Ctrl+S` confirmation. That dialog shows the proposal's changes, tools, guidance, and validation.
- **Before sending.** The client rereads the harness and sends nothing unless the proposal is still actionable or the snapshot version is unchanged.
- **Approval.** The server approves and applies in two steps. An already approved proposal is only applied, so an interrupted approval can finish.
- **Retries.** After an uncertain result, retries only reread state and report the observed outcome; they never repeat the write.
- **Validation.** `response-validation.ts` checks the harness fields the view renders. Patches and tool sources are never displayed.

[model-variants.ts](../../src/model-variants.ts) consumes advertised variant names from the directory-scoped provider catalog, not provider configuration bodies or a hard-coded effort scale. Session selection captures the model identity, uses `switchModel` with the same provider/model and chosen variant (omitted for Model default), and verifies through a fresh session GET. An attempted switch is never automatically repeated; retries inspect the frozen choice. A current unadvertised variant is retain-only. The launch picker instead updates process-local draft state; changing its model clears the variant, and attempted launches keep the original selection. [index.ts](../../src/index.ts) routes `/effort` and `/variant` to that draft picker when available and `/goal` only to created sessions.

Assistant metadata and distinct content parts are separated into Markdown blocks, so a reasoning paragraph or model label cannot absorb the answer's opening list. `markdown.ts` also normalizes ordered lists (handling both `1.` and `1)` markers) into single logical lines without separating list markers from text, while preserving fenced code blocks. It also corrects OpenTUI 0.5.10's leading margin on the first list-item body without changing later paragraph spacing. That small correction relies on native list-container IDs and should be rechecked on an OpenTUI upgrade; authored text, link filtering, and rich-rendering budgets remain unchanged.

## Transport boundary

[vendor/client](../../vendor/client/) provides the generated Promise client. [server.ts](../../src/server.ts) supplies a bounded transport; [providers.ts](../../src/providers.ts) handles legacy provider routes separately. Both refuse redirects and bound decoded response bodies to 8 MiB and 8,192 chunks before parsing. Normal requests have a ten-second deadline; provider OAuth completion allows five minutes.

[live-events.ts](../../src/live-events.ts) uses a separate streaming fetch because buffering SSE to EOF would prevent live delivery. It preserves authentication and redirect refusal, applies a ten-second header deadline and 45-second chunk-idle deadline, limits each pending SSE frame to 1 MiB, and uses the shared JSON-complexity scanner. The stream has no lifetime byte cap. Abort releases the reader and timers; it never logs credentials or fetches URLs supplied by events.

[response-validation.ts](../../src/response-validation.ts) rejects excessive JSON complexity and validates fields consumed by the UI, including response identities and relevant directory boundaries. Display helpers remove unsafe terminal controls. Generated TypeScript types alone are not runtime validation, and the retained SDK surface is not a promise that every method is used or validated by this TUI.

Server authentication uses HTTP Basic credentials. Secret-bearing connections require HTTPS or HTTP to `127.0.0.1` / `[::1]`; provider secret operations enforce this even without server authentication. Loopback requests add proxy-bypass entries. See [usage](../guides/usage.md#connect-and-switch-servers) for the CLI boundary.

### Server discovery and switching

[servers.ts](../../src/servers.ts) turns a target into an endpoint of `{url, username, password}`. It proves the endpoint with an authenticated `GET /global/health` before any dashboard is built on it.

**Local records.** Local servers are found only through records their owners publish:

| Record                     | Written by                                  | Accepted when                                                       |
| -------------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| Desktop `attach.json`      | TurenOS Desktop, in its user-data directory | Owned by this user, not writable by others, and its `pid` is alive. |
| `~/.forge/run/server.*`    | The quick-connect shim                      | Owned by this user, not writable by others, and its pid is alive.   |
| `/etc/turenos/attach.json` | The persistent-server installer             | Root-owned and not writable by others.                              |

A record must point at `http://127.0.0.1:<port>` with no path. Chromium's `SingletonLock` (`host-pid`) only detects a running desktop that publishes no record; it never yields credentials.

**Private server.** The private server is refused while TurenOS or TurenOS Beta holds `forge.db` in the same data directory, because session drains are process-local. Its child process is killed when the client exits.

**SSH.** The SSH path mirrors TurenOS Desktop's quick-connect:

1. One `BatchMode=yes` `ssh … sh -s` probe reads the persistent attach record, then runs `forge-remote status`. Output is parsed from anchored `FORGE_ATTACH` / `FORGE_REMOTE` lines, so a login banner cannot fake a result.
2. `ssh -N -L <private socket>:127.0.0.1:<port>` forwards the server to a socket in a `mkdtemp` directory. A loopback TCP proxy owned by this process forwards to that socket.
3. `ensure` runs only with `FORGE_SECRET_VAULT_KEY_*` set, and sends the key on stdin, never in arguments.

**Validation and imports.** Destinations, users, ports, and identity files are validated so they cannot smuggle ssh options. The desktop's saved SSH list comes from `GET /global/storage` (`desktop/store/product-state-v1`, `ssh-servers`) on the desktop's own server; that list holds no secrets.

**Persistence.** Saved servers are written `0600` through a temporary file and a rename, and never include passwords. Passwords typed into the picker live in process memory only.

## Remote compatibility

The client needs the current `/api/` contracts used for location, agents, sessions, messages, tasks, pending input, permissions, questions, loops, terminals (`/api/pty`), and the session harness, plus `GET /global/health` to verify a server before switching to it. It also deliberately retains these shipped compatibility routes:

| Route                                                                                     | Use                                                        |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /provider`, `GET /provider/auth`                                                     | Directory-scoped model catalog and authentication methods. |
| `PUT /auth/:providerID`                                                                   | Save a server-global provider API key.                     |
| `POST /provider/:providerID/oauth/authorize`, `POST /provider/:providerID/oauth/callback` | Server-mediated OAuth.                                     |
| `GET /global/config`, `PATCH /global/config`                                              | Custom-provider preflight and global configuration write.  |
| `PATCH /session/:sessionID?directory=...`                                                 | Rename or archive/restore a session.                       |

The session PATCH acknowledgement is validated as a legacy response, then the client fetches the current session through `/api/session/:sessionID`. It is not cast into a current session object. Provider configuration and key storage are separate writes; preflight does not make them atomic or prevent another client from racing them.

**Credential precedence risk:** legacy provider writes do not establish which credential the current server runner will select. In the [source snapshot](../reference/provenance.md#extraction-boundary), upstream `Credential.list` prefers native V2 stored credentials over the V1 projection for the same integration. `Integration.connection.active` selects a stored connection before environment fallback. Those server implementations are not bundled here, and deployed versions may differ. A catalog refresh is not a provider-key test; inspect the server's active integration and configuration rather than assuming another legacy save will select the intended key.

A missing terminal route can leave sessions usable while reporting inventory unavailable, and a missing harness route only makes the harness view report it unavailable; other optional inventory failures are also shown separately. Authentication failure is not treated as an empty inventory. There is no blanket compatibility guarantee for older servers, OpenCode servers, or every endpoint retained in the vendor package.

## Non-goals

The client does not bundle a server, replace an installed helper, or provide disk-backed drafts. It covers most desktop features but not all; [GUI parity](../reference/gui-parity.md) lists what stays desktop-only. A source CLI and Linux checks are not a standalone compiled binary distribution or a verified full platform matrix. See [development](../guides/development.md#verification-boundaries).
