# TUI usage

Run the TurenOS terminal client in an interactive terminal against a TurenOS server. Sessions, tools, and model execution stay on that server; this client never executes server tools locally.

## Connect and switch servers

Install dependencies with Bun (the version pinned in the root `package.json`), then run from the repository root:

```sh
bun install --frozen-lockfile
bun run tui                                   # TurenOS on this computer
bun run tui -- --server lab                   # a saved server
bun run tui -- --dir /srv/project https://turen.example
```

`bun run tui` runs `bun --cwd packages/tui start`, so `bun --cwd packages/tui start -- <options>` is equivalent, as is `bun src/cli.ts <options>` from `packages/tui`. The `turen-tui` bin in `packages/tui/package.json` points at `src/cli.ts`.

Without a URL, the TUI opens the first TurenOS it finds on this computer:

1. **The TurenOS app.** While it runs, TurenOS Desktop publishes its local server's address and password in `attach.json`, a `0600` file in its user-data directory, and removes it on quit. On macOS that is `~/Library/Application Support/com.turenlabs.forge/attach.json`. Beta and Dev builds use the `.beta` and `.dev` directories and are listed separately. A Desktop build that does not publish the file is still detected through its single-instance lock. The picker then says it is running and asks you to update it.
2. **This host's quick-connect server.** This is the `~/.forge/run` server TurenOS Desktop started over SSH. It lets you run the TUI on the remote host itself.
3. **This host's persistent server.** On Linux, this is `/etc/turenos/attach.json`, which needs membership in `turenos-operators`.
4. **A headless server on port 4096.** This is offered only when `FORGE_SERVER_PASSWORD` is set, for a `forge serve --port 4096` you started yourself. It is not offered in shells that TurenOS started (`FORGE_CLIENT=desktop`): there the variable holds TurenOS's own server password, and that server is not on port 4096.

If none is running, the server picker opens instead. Press `s`, click the server name in the header, or use `/servers` to open it at any time:

| Key            | Picker action                                                              |
| -------------- | -------------------------------------------------------------------------- |
| `Up` / `Down`  | Choose a server (`j` / `k` also work).                                     |
| `Enter`        | Connect. The current dashboard stays until the new server has answered.    |
| `a`            | Add an `https://` URL or an SSH `user@host[:port]`, with an optional name. |
| `d`            | Remove a saved server (press twice). Discovered servers cannot be removed. |
| `r`            | Rescan. The list also refreshes every three seconds.                       |
| `Esc` / `s`    | Return to the current dashboard unchanged.                                 |
| `q` / `Ctrl+C` | Quit. With unsent drafts, press twice.                                     |

Switching replaces the dashboard, and unsent drafts do not follow you to another server. The picker counts them first, and `Enter` must be pressed again to switch. `--dir` applies only to the first server.

**Private server.** When the TurenOS app is not running, **Start a private server** runs `forge serve` from the installed CLI: `TURENOS_FORGE`, `forge` on `PATH`, `~/.forge/bin/forge`, or the TurenOS app's bundled `forge-cli`. It binds `127.0.0.1` with a generated password and stops when you quit. It opens the same local data as TurenOS, so it needs the key that protects your stored credentials in `FORGE_SECRET_VAULT_KEY_ID` and `FORGE_SECRET_VAULT_KEY`. It refuses to start while TurenOS or TurenOS Beta is running over that data, because two servers over one database could run the same session twice. With `XDG_DATA_HOME` or `FORGE_DB` pointing at other data, it starts anyway.

**SSH servers** work the way TurenOS Desktop's quick connect does. The TUI runs one `ssh … sh -s` to read the host's persistent-server record or `forge-remote status`, then forwards the server to a private socket behind a loopback port for this client. SSH runs with `BatchMode=yes`, so use a key or agent, and accept a new host key once with `ssh user@host` in a terminal. If no server is running, the TUI starts it only when `FORGE_SECRET_VAULT_KEY_ID` and `FORGE_SECRET_VAULT_KEY` are set; the key is sent on stdin, never in arguments. A host TurenOS was never installed on must be added once in TurenOS Desktop. The SSH servers saved in TurenOS Desktop appear under **From TurenOS Desktop** while you are connected to the app.

**URL servers** ask for a password the first time the server rejects the connection. The password is kept only until you quit. Saved servers live in `$XDG_CONFIG_HOME/turen-tui/servers.json` (`~/.config/turen-tui/servers.json` by default), written `0600`. The file never holds a password; a URL server may name an environment variable to read one from:

```json
{
  "version": 1,
  "servers": [
    { "name": "lab", "ssh": "dad@10.0.0.4:22", "identityFile": "~/.ssh/lab" },
    { "name": "team", "url": "https://turen.example", "username": "forge", "passwordEnv": "TEAM_TURENOS_PASSWORD" }
  ]
}
```

The CLI (`packages/tui/src/cli.ts`) accepts `bun run tui -- [options] [url]`:

| Argument                | Purpose                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| `url`                   | Server origin, with no path prefix, embedded credentials, query, or fragment. |
| `--server <name>`       | Open a saved server by name.                                                  |
| `--dir <directory>`     | Absolute directory **on the server**, not a local checkout to upload.         |
| `--username <username>` | Server HTTP Basic authentication username.                                    |
| `--discover-auth`       | Explicitly opt in to local server-credential discovery.                       |
| `-h`, `--help`          | Show available options without opening the UI.                                |
| `-v`, `--version`       | Show the client version without opening the UI.                               |

URL precedence is the positional URL, then `TURENOS_SERVER_URL`, then local discovery. `--discover-auth` without a URL keeps its original `http://127.0.0.1:4096` target. `--server` cannot be combined with a URL. Username precedence is `--username`, then `FORGE_SERVER_USERNAME`, then a discovered username, then `forge`. Discovered servers publish their own username. Omitting `--dir` leaves location selection to the server.

Provide the server password through `FORGE_SERVER_PASSWORD` in the process environment, not a CLI password argument or URL. An explicitly empty value disables authentication and discovery. Use a trusted environment/secret mechanism rather than putting a real password in shell history.

`--discover-auth` is off by default. On Linux, only for `http://127.0.0.1:4096` and only when `FORGE_SERVER_PASSWORD` is unset, it may read the same user's `turenos.service` process environment. This requires trust in the local listener: matching process ownership does not prove that the listener belongs to that service. Discovery does not inspect a remote server or start/restart the service. See `packages/tui/src/tui-auth.ts` for the boundary.

Server credentials require HTTPS, except HTTP to numeric loopback `127.0.0.1` or `[::1]`, such as an already established SSH tunnel. `localhost`, private LAN addresses, and other loopback addresses do not receive this authenticated-HTTP exception. Unauthenticated HTTP is permitted, but does not protect session content. Prefer HTTPS for remote use. Redirects are refused rather than forwarding credentials.

The CLI needs Bun and the complete installed `node_modules` tree, including OpenTUI's native dependencies. No compiled binary build or server is bundled. Running these commands does not change an installed helper or restart an existing server.

## Send and retain drafts

Press `n` for a new session or to resume its draft, or `f` for a reply to the selected session.

`Ctrl+N` opens the same New session view with a multicolored retro pixel-art TurenOS logo. Larger terminals show a shaded wordmark and pilot emblem; small terminals, expanded settings, and retry screens use a compact wordmark. The task editor receives focus immediately, with no splash delay or extra confirmation.

With the conversation focused, `Enter` opens the primary action: reply, review a pending request, or reconnect. From the session list, the first `Enter` focuses the conversation. In an empty message editor, `Up` recalls the latest loaded user prompt for this session; it never submits it and does not replace text you have already typed.

- `Enter` sends **when the message editor has focus**. `Ctrl+S` also submits.
- `Shift+Enter` or `Alt+Enter` inserts a newline. Terminal key encoding must distinguish the modifier.
- `Tab` reveals launch settings and moves between fields; `Shift+Tab` moves backward.
- `Esc` keeps a message draft; `F4` discards the local draft. Neither action stops server work.
- In a reply, `Ctrl+T` selects Steer or Queue before the first submission. The server controls delivery timing.
- After an ambiguous network failure (no answer, a timeout, a 5xx or a 409), retry the original submission. Its identifiers and delivery mode are retained. For an attempted launch, `Ctrl+O` inspects its session before retrying.
- A submission the server definitely refused (any other 4xx) admitted nothing, so the draft unlocks for editing and keeps its ID for the next send. A draft that fails a local check (length, a mention, a command lookup) is never locked.

Press `F2`, or type `/editor`, to compose the message in `$EDITOR` (`$VISUAL` takes precedence). The TUI releases the terminal while the editor runs and takes it back when it exits; saving returns the text to your draft. Quitting without saving, or exiting non-zero such as `:cq` in vim, leaves the draft unchanged. GUI editors must block, for example `EDITOR='code --wait'`. Your draft is written to a private file that is removed afterwards even if the editor fails, and nothing is sent. A draft whose submission is already locked for retry cannot be rewritten this way: retry it, or press `F4` to discard it first.

Drafts and reading positions live only in this TUI process. There is **no disk draft persistence**; quitting loses unsent drafts. A request already sent may have reached the server even if no acknowledgement arrived. Discarding or quitting is not cancellation; use the explicit interrupt action when needed.

Message-editor shortcuts take precedence over dashboard navigation. Press `Esc` before using `Ctrl+K` to switch sessions; inside a message editor it deletes to the end of the line. Question panels are different: `Ctrl+K` opens the session picker directly, including while entering a custom answer.

Task-owned subagent sessions cannot accept direct replies. When ownership is known, `f` offers **Open main session and reply** (or parent when the root is unknown). Click it or press `Enter` to open that session's reply editor; this sends nothing. If the server reports ownership after a send attempt, the child draft stays saved and retries do not resend it. Press `Esc`, then `f` to see the saved text and explicitly open the main/parent session. Child draft text is never silently moved to another recipient; any existing main-session draft is reopened separately. A `parentID` alone does not establish task ownership.

Reply editors size themselves from wrapped display rows, between three and six rows. Long paragraphs can scroll inside the editor, while Send and draft controls remain visible. Terminal resizing preserves the editable text and focus. Transcript and form content reserve the scrollbar column so it does not hide the final character of a line.

## Mention files and run commands

Type `@` in any message or task editor to search the server's files. `Up`/`Down` choose a result, `Tab` or `Enter` completes it, and `Esc` closes the list without changing your draft. Completing a folder keeps the list open so you can search its next segment; completing a file ends the mention and leaves a trailing space.

Add a line range with `#`: `@src/auth.ts#20` attaches one line and `@src/auth.ts#20-45` attaches that inclusive range. A range suffix addresses a file you already chose, so it stops the search rather than offering to replace the path.

A space, bracket, quote, or trailing `#number` ends a bare mention, so paths containing them use a quoted form: `@"src/app/(auth)/page.tsx"`, with any range after the closing quote as `@"my notes.md"#3-9`. Completion writes whichever form parses back to the exact path it offered, and a path it cannot represent is not offered at all — so completing a result never attaches a shorter, different file.

Mentions are sent as the server's native file parts, not as text pasted into your prompt. **The server opens the file**; this client never reads it, so `@` works the same against a remote server as a local one. Relative paths resolve against the session's directory on the server, and a mention whose path is malformed or whose range is invalid (`@a.ts#5-`) stays ordinary prompt text instead of silently attaching something else. A line under the editor lists what the message will attach. A path outside the session's folder (absolute, `..` or `~`) is flagged there, and the first send stops to say so; send again to attach it anyway, or edit the mention. A message with no mention is sent exactly as before.

`@` needs the server's file-search route. An older server without it reports `File search unavailable`; you can still type a path yourself, and it is still attached. Search results that are absolute or that escape the requested directory are rejected rather than attached.

Start a message with `!` to run a shell command on the server, such as `!git status`. The command runs in the session, and its output arrives as a transcript message. This is a single command submission, not an interactive shell: there is no keyboard input, attach, or kill control. For an interactive shell, press `T` for the session's shared terminal or open one on the [Terminals tab](#terminal-and-automation-tabs). Like slash commands, `!` does not support Queue — press `Ctrl+T` to choose Steer first. An ambiguous failure retries the original command with its original message ID.

## Copy and mouse

Drag to select transcript text, then use `Ctrl+Y` or right-click to request a terminal clipboard copy.

Press `F6` to release mouse capture and use your terminal's native text selection and right-click menu; press `F6` again to restore TUI clicking and wheel scrolling. Many terminals also allow holding Shift while dragging/right-clicking to bypass application mouse reporting. `Ctrl+P` exposes **Copy selected text** and **Toggle terminal mouse selection**. `Ctrl+C` still quits the TUI; it is not the copy shortcut.

## Navigate

In a known task-owned child's conversation, `/` opens a local command palette instead of the blocked reply editor. `/help`, `/sessions`, and `/subagents` remain available; `/main` offers the explicit owning-session reply action. Server commands still require a writable session.

With the conversation pane focused, press `/` to open reply command entry directly. An existing reply draft is reopened unchanged, never replaced with `/`. In a new-session or reply editor, type `/` to discover commands. `Up`/`Down` chooses a suggestion and `Tab` completes it. `Enter` on a partial name completes it; `Enter` on an exact name runs the local action or submits the server command. `Ctrl+S`, `Ctrl+Enter`, and the Send button use the same command handling. Submission waits while suggestions are loading; press submit again when ready. Add arguments after a server command name as ordinary text.

TUI actions include `/help`, `/new`, `/sessions`, `/model`, `/agent`, `/compact`, `/undo`, `/redo`, `/history`, `/tasks`, `/rename`, `/editor`, `/stop`, `/kill`, and `/commands`. Actions reuse the existing UI, including interruption and compaction confirmation. `/agent` changes the current session's agent for subsequent turns; in a new-session draft it opens that draft's agent setting instead. `/compact` requests server-side context summarization after `Ctrl+S` confirmation and never automatically interrupts busy work. Server-defined commands come from the selected server directory and execute through its command API; templates are not expanded locally. Unknown slash names and absolute paths remain ordinary prompt text when command discovery succeeds. Command admission does not support Queue: use `Ctrl+T` to select Steer first. Ambiguous retries preserve the original command, arguments, and request ID.

`/undo` stages a rewind from the previous user prompt; `/redo` advances the staged boundary or clears it. Read the pinned warning, type `undo` or `redo`, and confirm with `Ctrl+S`. Confirmation first stops active work in that session. Undo defaults to **Conversation only**; **Conversation + files** restores affected server files immediately. Redo can also restore files from an existing file undo. Conversation-only undo refuses to silently clear an existing file undo.

When a rewind has staged file changes, the confirmation names them before you confirm: a `Staged file changes` line counts the files and total added/removed lines, and `Ctrl+D` opens the staged patch in place. Each file shows `A`/`M`/`D`, its path, and its own counts; added and removed lines are colored. Opening and closing the patch is read-only and sends nothing. The patch comes from the server's staged revert, so a server that reports only a combined diff says so instead of inventing per-file detail. Long patches and large file sets are shortened with an explicit marker rather than rendered in full.

Recent view hides staged-away turns; History still shows them with a warning. A new reply commits the staged boundary, so the editor labels that consequence. Undo restores the original prompt as a text-only draft only if no ordinary draft would be overwritten; redo removes only that untouched restored draft. Inspection is bounded to 300 recent messages. After an ambiguous write, retries only inspect server state, never repeat file operations; a lost file-restoration acknowledgement requires inspecting the session/files before trying again. Live revert events and reconnects rebuild cached transcript windows so committed-away messages cannot linger.

Additional TUI actions are `/goal` for the [session goal overview](#session-goals), `/subagents` as an alias for `/tasks`, `/info` or `/details` for session metadata (model variant, parent session ID, timestamps, token breakdown, and cost), `/folders` to browse working folders, `/servers` for the [server picker](#connect-and-switch-servers), `/harness` for the [session harness](#session-harness), and `/effort` or `/variant` for [model variant selection](#models-and-providers). The views that match the desktop's panels have commands too: `/changes`, `/files`, `/terminal`, `/queued`, `/room`, `/tools`, `/trace`, `/settings`, `/extensions`, `/memories`, `/intel`, `/delete`, and `/stop-all`; see [Session views](#session-views) and [Settings and intel](#settings-and-intel). Skills from enabled extensions appear in the list as `/<skill>`, marked **Skill**, and run as commands, as in the desktop. With the sidebar focused, `/` remains the session finder; in other tabs it filters items. `Ctrl+K` opens the session finder from either dashboard pane, and `Ctrl+P` remains the action palette.

Dashboard shortcuts apply when no form or search is open:

| Key                         | Action                                                                            |
| --------------------------- | --------------------------------------------------------------------------------- |
| `Ctrl+P` / `?`              | Commands / keyboard help.                                                         |
| `s`                         | Server picker: switch between this computer, saved, and Desktop SSH servers.      |
| `H`                         | Session harness: tools, guidance, reviewer runs and proposals.                    |
| `d` / `e`                   | Changes (uncommitted, branch, last turn) / Files of the selected session.         |
| `T`                         | The session's shared terminal, full-screen; `Ctrl+]` detaches.                    |
| `u` / `w`                   | Queued messages (send now, edit, discard) / swarm room.                           |
| `,` / `I`                   | Settings / Intel (advisories, known-exploited CVEs, news).                        |
| `Ctrl+K`                    | Session picker from either dashboard pane (or inside question modals).            |
| `/`                         | Command entry in the conversation; finder/filter in the sidebar or other tabs.    |
| `Ctrl+X` / `t`              | Subagent browser: root-wide recent and active tasks; Enter opens a child.         |
| `Alt+Left` / `Alt+Right`    | Previous / next loaded session in history.                                        |
| `1` / `2` / `3`             | Sessions / terminals / automations; `a` adds and `d` removes on the last two.     |
| `Up` / `Down`, `Enter`      | Select an item; Enter focuses the conversation, then opens its primary action.    |
| `Tab` / `Shift+Tab`         | Switch panes (or navigate fields in dialog modals).                               |
| `b` / `Ctrl+B`              | Toggle sidebar. With tmux's default prefix, send `Ctrl+B` twice.                  |
| `PgUp` / `PgDn`             | Scroll conversation; when docked, reads history behind the composer.              |
| `j` / `k`                   | Scroll conversation down/up (or move selection down/up in session list).          |
| `Home` / `End`              | Jump to beginning / end of conversation (or first / last session in list).        |
| `h`, `[` / `]`              | Toggle History/Live transcript, then older/newer history page.                    |
| `i` / `r`                   | Details / refresh session and server inventories.                                 |
| `m`                         | Choose the selected session's model (Ctrl+L in new session launch).               |
| `p` / `o` / `x`             | Permission / question / interrupt confirmation.                                   |
| `Ctrl+S` / `Ctrl+Enter`     | Submit / send from composer or any active modal.                                  |
| `Shift+Enter` / `Alt+Enter` | Insert a newline in message editor without submitting.                            |
| `Up` (empty editor)         | Recall latest prompt into message editor.                                         |
| `@`                         | Search the server's files; Tab/Enter completes, Esc closes the list.              |
| `!` (start of a message)    | Run one shell command on the server and show its output in the transcript.        |
| `Ctrl+D` (undo / redo)      | Show or hide the staged patch before confirming a rewind.                         |
| `F2` (message editor)       | Compose the draft in `$EDITOR`; the TUI resumes when the editor exits.            |
| `F4`                        | Discard local draft in composer modals.                                           |
| `Ctrl+Y`                    | Copy selected text via OSC 52 terminal clipboard.                                 |
| `F6`                        | Toggle mouse capture (switch between TUI clicking and native terminal selection). |
| `q` / `Ctrl+C`              | Quit dashboard / cancel current form; repeat to confirm quitting with drafts.     |

In the **session picker**, `F2` cycles Recent, All sessions, and Archived. An empty Recent search shows main sessions only, with compact, disambiguated project headings. Typing searches all loaded metadata, including children by title, path, agent, or ID. All sessions searches unarchived titles on the server, while Archived searches archived titles. The label "All sessions" is not an archive-inclusive search. `F3` loads older remote results, `Shift+F3` newer results, and `F3` retries a failed search. `Ctrl+O` opens a session by its exact ID. These keys are context-specific: `F2` in the model picker opens provider setup instead.

Startup prefers a main session (one without a `parentID`) from the loaded snapshot, rather than letting an active subagent take precedence. Active main sessions still rank first. If the recent/active snapshot contains only children, the client also requests up to 100 unarchived root sessions so an older main thread can be selected. If no root is available, the first available session is shown for inspection. Explicitly opening a child is respected across refreshes; use `Ctrl+X` or `t` to browse its root-wide tasks, or `f` to open its owning session and reply.

The right pane groups session titles by their server project directory. Its highlighted line is the selected session; `*` marks running work. Clicking the selected row while a form is open keeps input focus in that form. Refreshing unchanged selection no longer scrolls the sidebar back to that row; explicit navigation still reveals the selected item. The finder also groups results by directory, shows one line per session, and marks the current session. Project headings are not selectable. Recent search still matches title, directory, agent, and session ID without displaying all that metadata on every row.

The main pane starts with the selected session's **latest six messages**, including tool results. Scroll up with the wheel, `Page Up`, or focused `Up`/`k` to reveal earlier prompts and replies without switching modes. Reaching the top loads more history and keeps your reading position. It follows new output while you are at the bottom; scrolling up pauses following. `End` in the conversation returns to the bottom. `h` opens the expanded history view, where `[` and `]` browse the complete session page by page; `h` returns to the recent transcript. Recent scrollback is bounded; a notice directs you to expanded history when its limit is reached.

The recent transcript streams text, reasoning, and tool activity through the server's live event channel, including while composing a reply. `Live` in the footer means the channel is connected; `Polling` means snapshots are providing updates while the client reconnects or the server lacks live-event support. Snapshot refreshes reconcile completed output; fragments missed before a usable snapshot or during disconnection are not replayable and catch up from snapshots/full completion events. History pages stay stationary. An open Tasks picker refreshes statuses and membership without clearing its filter or moving its selection.

New pending questions open automatically inside the selected session's frame, with the transcript still visible above them, when no active message editor, search, other dialog, or pending permission is blocking them. Escape dismisses the question without answering; the same request does not reopen on every refresh. Press `o` to reopen it manually. Questions resolved elsewhere close when refreshed. These are requests for the selected session, not an aggregate of all descendant sessions.

`Ctrl+K` temporarily opens the session picker without sending an answer. Cancelling the picker or returning to the request's session resumes the question, including selections, review/rejection state, custom text, and its cursor. Switching is blocked while an answer/rejection is being submitted. The last 16 question drafts are retained only in this client process; changed question content resets an old draft, and resolved requests discard it.

The question picker shows one question at a time. Use Up/Down to highlight, Enter to choose a single answer, and Space to toggle multiple answers. Left/Right navigates questions while retaining choices. Select **Type your own answer** when available; Enter saves the text, including commas, and Ctrl+B returns to choices. Review all answers before Enter, Ctrl+S, or the Submit button sends them. Opening, highlighting, and choosing an answer alone sends nothing.

Tool-result JSON and subagent board updates are formatted for reading by default. Use `Ctrl+P` and **Show raw responses** to inspect their original bounded text, or **Show formatted responses** to switch back. Authored messages, including explicitly requested JSON answers, are not rewritten. Terminal controls are always removed, including in raw mode.

Use `Ctrl+P` for rename, archive/restore, delete, or parent-session navigation. Archive/restore requires typing the named action and confirming with `Ctrl+S`; archiving does not interrupt running work. **Delete session** (or `/delete`) requires typing `delete`: the server stops the session's work, then removes it and all of its subagent sessions, and this cannot be undone. **Stop all agents** (or `/stop-all`) is the desktop's kill switch: after typing `stop all`, it interrupts every running session on the server, including other clients' work. `t` shows root-wide recent and active delegated tasks; `Enter` opens a child session. Older task pages are not loaded by that picker.

`Ctrl+C` first closes a form and keeps a message draft. Press it again within three seconds to quit and lose local drafts. From the dashboard, quitting with saved drafts also asks for a second `q` or `Ctrl+C`. During a pending request, the first `Ctrl+C` warns instead of immediately abandoning its result; a second press quits, but remote work may continue. `PgUp`/`PgDn` scroll by approximately one visible page, not a fixed line count.

Permissions initially select Reject; choose deliberately and confirm with `Ctrl+S`. When the server names a rule it can save for the request, **Allow always** also appears and lists the patterns it would allow from now on; saved rules can be reviewed and removed in [Settings](#settings-and-intel). In questions, Ctrl+R opens rejection confirmation; Ctrl+S confirms it, while Enter alone does not reject. Interrupt requires typing `stop` and confirming with `Ctrl+S`. `/kill` interrupts the session and cancels its active subagent tasks; it requires typing `kill` and confirming with `Ctrl+S`. Tasks that finished in the meantime are counted as not listed; if a cancel fails, the dialog stays open with the counts (`N cancelled, M failed, K not listed`) and `Ctrl+S` retries. Only the first 50 tasks are checked, and the message says when there were more. Closing a request dialog does not answer it.

## Terminal and automation tabs

Press `2` or choose **Terminal processes** in `Ctrl+P` to see the server's terminals. Terminals belong to a location on the server, so the client reads `GET /api/pty` for the server's default location and each open working folder (at most eight). It does not enumerate the local machine's processes. The sidebar shows each terminal's status and title, with its PID and working directory below; selecting one shows its command, exit code when it has ended, and ID.

| Key     | Terminals tab                                                                               |
| ------- | ------------------------------------------------------------------------------------------- |
| `Enter` | Attach full-screen to a running terminal. `Ctrl+]` detaches; the process keeps running.     |
| `a`     | Open a new terminal (your default shell on the server) in a folder you choose, then attach. |
| `R`     | Rename the selected terminal.                                                               |
| `d`     | Close the selected terminal after `Ctrl+S`; a running process ends with it.                 |

Attaching hands the whole terminal to the server's shell, the way the desktop's terminal pane does: its output replays, your keystrokes go to it, and its size follows this window. A dropped connection reconnects from where it left off, and keys typed while it reconnects are sent once it does (up to 64 KiB). A terminal that ended while disconnected returns you to the dashboard as exited. When the shell exits or the terminal is closed elsewhere, the dashboard returns. `T` in a session attaches to that session's **shared terminal**, which the agent's terminal tool also uses, and creates it on first use.

A server that returns `404` for the terminal route shows an explicit unavailable message while keeping sessions and agent launch available. Other inventory errors remain visible; press `r` to retry.

Press `3` or choose **Automations** to see the server's automations: scheduled agent prompts. Rows show status, name, schedule, and directory, and a selected automation shows its next run, prompt, and recent runs.

| Key     | Automations tab                                                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `Enter` | Manage: **Run now**, **Pause** or **Resume**, **Runs** (open a run's session, or `Ctrl+D` twice to cancel a running one), **Edit**, **Delete**. |
| `a`     | New automation: name, prompt, schedule, and folder.                                                                                             |
| `E`     | Edit the name, prompt, and schedule.                                                                                                            |
| `d`     | Delete after `Ctrl+S`; sessions it already started are kept.                                                                                    |

Schedules are written as `every 30m`, `every 2h`, `every 1d`, or a five-field cron expression such as `0 9 * * 1-5`, which runs in this computer's time zone. Workflow steps and file-change or session-end triggers are shown but edited in the desktop. If the automation route or run history fails, the overview remains visible and the detail view reports the failed portion so `r` can retry.

## Session views

These open over the dashboard for the selected session and match the desktop's session panels. `Esc` returns.

- **Changes** (`d`, `/changes`): the review panel. `m` switches between the working tree's uncommitted changes, the branch against its base, and what the agent's last turn changed. The left list has one file per line with its `+`/`-` counts; the right pane shows its colored patch. `@` adds `@path` for the file to your reply and opens the reply editor.
- **Files** (`e`, `/files`): browse the session's folder on the server. `Enter` opens a folder, `←` or `Backspace` goes up, and a selected file shows read-only with line numbers. `@` mentions it in your reply.
- **Queued messages** (`u`, `/queued`): messages the server admitted but the agent has not read yet. The action row shows `u 2 queued` when there are any. `Enter` sends the selected one now instead of waiting, `Ctrl+E` takes it back into the reply editor to change it (a message over the editor's 32,000 characters, or one that would replace another reply draft, stays queued), and `Ctrl+D` twice discards it. A message the agent already read is reported rather than removed.
- **Tasks and to-dos** (`t`): the agent's to-do list sits above its delegated tasks, and the action row counts done to-dos, for example `t Tasks · 3/7 to-dos`.
- **Swarm room** (`w`, `/room`): for a session coordinating subagents, the plan's lanes and who holds them, and the shared entry stream. `Tab` moves to the post box; `Enter` posts as a human member.
- **Tools** (`/tools`): what the session's agent can call with its current model: built-in and MCP tools, each MCP server's status, and tools excluded with the reason.
- **Trace** (`/trace`): the session's durable event log, 200 events a page. `[` and `]` page older and newer; the right pane shows the selected event's data.

The action row also shows how full the context window is, as the desktop's title row does: `Context 45% · 90k/200k` is the latest request's prompt and response against the model's published window. A model without a published window shows only the token count.

New sessions can start in their own git worktree: in the new-session settings (`Tab`), set **Workspace** to **New git worktree**. When you send, the server creates the worktree and checks it out in the background; the TUI waits until the server reports it ready (up to five minutes) before starting the session there, as the desktop does. If the checkout fails, the error is shown and `Ctrl+S` tries a new worktree. A retry after an uncertain request reuses the worktree that request made instead of creating another.

## Settings and intel

Press `,` or use `/settings` for the server's settings. Changes here apply to every client of the server unless a section says otherwise.

| Section          | What you can do                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Providers        | Connect a provider (the same setup as `F2` in the model picker), **Disconnect** (delete its credential), or **Remove** (also delete its configuration). Each change refreshes the server's provider clients, as the desktop does.                                         |
| Usage and limits | Turns, tokens, and cost per provider for the last seven days, and plan quota windows with their reset times.                                                                                                                                                              |
| Extensions       | Skills, MCP servers, and data sources. `Enter` turns one on or off, `s` enters a secret (hidden while typed, never shown again), `c` a setting, and `o` starts an MCP sign-in, which the server opens in a browser on its own computer. Managed extensions are read-only. |
| Memories         | Wings and rooms of notes agents recall. `a` adds, `E` edits, `Ctrl+D` twice deletes. An edit is refused if the memory changed since you opened it.                                                                                                                        |
| Agents           | Each agent's default model, used when a session does not choose one.                                                                                                                                                                                                      |
| Permissions      | Turn permission checks on or off, and remove rules saved by **Allow always**.                                                                                                                                                                                             |
| Servers          | The server picker (`s`).                                                                                                                                                                                                                                                  |
| Appearance       | Reduced motion and raw or formatted responses; this client only.                                                                                                                                                                                                          |

Press `I` or use `/intel` for the threat intelligence the desktop shows on Home: security advisories, CISA's known-exploited vulnerabilities (KEV), and security news that the server polls from its feeds. `m` switches lists, `[` and `]` page, `p` polls the feeds now, and `f` turns feeds on or off.

## Session harness

Every session runs through the server's session harness, whichever client started it. The harness is the set of tools and standing guidance added to the agent, and an automatic reviewer can propose changes to it. Press `H`, use `/harness`, or choose **Session harness** in `Ctrl+P` to see the selected session's harness, as TurenOS Desktop's Harness panel shows it:

- the active snapshot's version, source, and validation
- its harness tools (read-only or disabled) and guidance
- proposals by status
- the latest reviewer runs and their outcomes

Opening it and `Ctrl+R` refresh are read-only. `Up`/`Down` and `Enter` choose a change, which opens its own confirmation showing the proposal's changes, tools, guidance, and validation. `Ctrl+S` confirms and `Esc` goes back without sending anything.

| Change            | Effect after confirmation                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Approve and apply | Approves a pending proposal, then applies it as a new snapshot the agent uses from its next turn. |
| Apply             | Applies an already approved proposal, for example after an interrupted approval.                  |
| Reject            | Rejects the proposal; the active snapshot is unchanged.                                           |
| Reload            | Reloads the current snapshot from its declared sources.                                           |
| Roll back         | Restores the previous snapshot version.                                                           |

Before sending, the client rereads the harness. It sends nothing if the proposal or snapshot changed since you reviewed it. After an uncertain result, retrying only rereads the harness and reports what it observes; it never repeats the change. Task-owned subagent sessions are read-only here. A server without the harness routes reports **Harness unavailable**.

## Session goals

Use `/goal` in a created session, or **Session goal** in `Ctrl+P`. An unsubmitted new-session draft cannot have a goal. Opening the overview and using `Ctrl+R` to refresh are read-only: they show the objective, status, revision, tokens, and usage time. `Up`/`Down` and `Enter` choose an action but do not mutate the goal. Task-owned sessions permit inspection only; use their owning session for control.

Each action opens a separate confirmation. `Ctrl+S` confirms; `Esc` returns without submitting. In Set/Edit, `Enter` inserts a newline, unlike the ordinary message editor. Objectives must contain 1–4,000 characters after trimming. Clear requires typing `clear` exactly before `Ctrl+S`; `Enter` alone never confirms.

| Action | Effect after confirmation                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Set    | Available with no goal or a completed goal. Creates an active goal and starts execution using the captured session agent/model. **Also commits any staged undo.** |
| Edit   | Changes the objective. Editing an active goal starts execution; editing a stopped goal does not start it.                                                         |
| Pause  | Stops active work and pauses the goal.                                                                                                                            |
| Resume | Makes a stopped, unfinished goal active and starts execution.                                                                                                     |
| Clear  | Stops active work and removes the goal.                                                                                                                           |

Goal controls leave ordinary reply drafts unchanged. Before writing, the client rechecks the captured session identity and goal revision; a changed revision is not overwritten. Close, inspect, and confirm again after a conflict. After an uncertain Set result, retries retain the original goal/message IDs and objective and only resend after an unchanged-state preflight. After an uncertain Edit/Pause/Resume/Clear result, retries only read server state and never repeat the write. An observed desired state is reported as such, not as proof that the original request was acknowledged.

## Models and providers

Press `m` for session model selection, or `Ctrl+L` in a new-session draft. Selecting a draft model does not send the task. Session model changes apply to subsequent turns, not the in-flight response. Reselecting the same model preserves its latest server variant; switching models uses the new model's default variant.

Use `/effort` or `/variant`, or **Choose model effort / variant** in `Ctrl+P`, to select **Model default** or a variant name advertised by the server for the current model. Names are not a fixed effort scale and arbitrary names cannot be entered. `Up`/`Down` chooses, `Enter` or `Ctrl+S` selects, `Ctrl+R` reloads, and `Esc` returns. A known model is required. A no-longer-advertised current variant is marked **current only**: it can be left unchanged on that session, not newly applied elsewhere.

Session variant changes send no prompt and affect subsequent turns. Model default clears the explicit variant. The client checks the captured session/model identity, then verifies the selected variant from a fresh session read. After an uncertain switch result, the choice stays frozen and retries only read state, never repeat the switch. Task-owned sessions cannot be changed directly.

In a new-session draft, `/effort` and `/variant` change only the local launch selection; choose an explicit `provider/model` first. Selecting a variant does not create a session or send the task. Changing the draft model, by typing or browsing, resets its variant to the model default. Once a launch has been attempted, its model and variant stay locked with the original submission for retries.

To disconnect or remove a provider, or to see usage and plan limits, use [Settings](#settings-and-intel). In the model picker, `F2` opens provider setup and `Ctrl+R` refreshes the catalog. Supported flows include API keys, server-advertised OAuth, and custom OpenAI-compatible providers. OAuth instructions may be opened on another device; the TUI does not launch a browser. Remote loopback callbacks may require SSH forwarding.

Provider credentials and custom-provider configuration are **server-global**, not private to the selected session or directory. Secret entry is hidden, and `Ctrl+U` clears it. Provider secret operations require HTTPS or the same numeric-loopback exception even when the server itself needs no password.

A saved key and refreshed catalog do not prove that the key was accepted by the model provider or chosen by the server's execution path. The server may prefer native V2 stored credentials over legacy credentials saved through these routes. Check the server's active integration and configuration before replacing more credentials; this client does not resolve that precedence. Custom configuration and its optional key are separate writes, so refresh before retrying a partial or unconfirmed save. See [remote compatibility](./README.md#remote-compatibility).

## Finder layout

The sidebar's **Find a session** action opens the same grouped search and Recent/All/Archived scopes as `Ctrl+K`, inside a widened right-hand pane on desktop. Small terminals give it the full workspace area. `Ctrl+K` uses a larger centered finder, with selected-session details on spacious screens. Up/Down selects, Page Up/Down pages, and Ctrl+Home/End moves to the first/last result without leaving the search field.

## Shared working folders

Click **Working folders** in the desktop sidebar, or select it through `Ctrl+P`, to manage directories shared with the GUI on this server. Choose or type an absolute server directory; Ctrl+S opens it. Ctrl+R switches to close mode, and Ctrl+S confirms that close. Enter alone does neither. Opening a folder sets the default directory for a new launch when there is no existing launch draft. Closing only changes folder visibility, not session data or execution.

Both clients use the server's revision-checked shared storage. GUI updates poll every three seconds; the TUI reads during its normal two-second reconciliation. The initial GUI list seeds missing shared state. Selection and expansion remain local, and GUI workspace grouping preserves external worktree paths. Folders without recent sessions remain discoverable. A currently viewed session stays accessible with a `(closed)` group label if its folder closes elsewhere. Ctrl+K can still find sessions outside open folders.

This requires the standard server's `/global/storage` capability. Read failures retain the last known list and show a warning on Working folders; failed TUI writes stay in the dialog for explicit retry. Pending GUI changes retry while that GUI window remains open. Older or route-only servers without shared storage cannot synchronize the list.

## Display and recovery

With no session selected and no search filter active, the compact Turen welcome state shows connection status plus New session, Ctrl+K picker, and Help shortcuts. Available sessions still open directly; there is no splash delay or extra confirmation before entering a session.

Normal TUI exit briefly keeps terminal input owned while late terminal replies settle, then lets the native renderer restore the shell screen, cursor, mouse reporting, and terminal modes. The quiet period is 150 ms and the total wait is capped at 600 ms; this is bounded recovery, not a guarantee against arbitrarily delayed terminal input. It does not clear shell history or stop server work.

Scrolling up pauses tail-following even while text streams in or a reply is open. Loading earlier messages must not turn subsequent tail growth into a scroll jump. `End` in the conversation returns to following, including when an older-page request is still pending. Width changes retain the currently read text using native wrapped-line positions; the reply editor retains its own text and caret separately.

Session loading stabilizes scroll positioning synchronously before rendering new turns (`syncLayout()`), and immediately projects cached live turns when available. This prevents the visual flashing and layout jumping that occurred when opening sessions with substantial scrollback.

Numbered markdown lists (supporting both dot `1.` and paren `1)` list markers) are normalized to keep the numbering and following text on single logical lines rather than splitting markers across lines, while preserving fenced code blocks and indentations intact.

The terminal hardware cursor is hidden by default across all dashboard views, conversation panes, and overlays, becoming visible only inside active text inputs and editors. Paged history reading positions are completely decoupled from live event streams, ensuring cursor states and terminal artifacts do not leak during transcript navigation.

The layout requires at least 60 columns by 24 rows. Enlarge the terminal if the size notice appears. Activity uses a compact dotted orb alongside its status label: Unicode Braille cells display orbiting particles on one line. Use a terminal font with Braille glyph support. Enable reduced motion through `Ctrl+P` or set `TURENOS_REDUCED_MOTION=1` before startup; this freezes the orb without hiding its labels.

The client polls for updates and marks retained data stale when disconnected. Press `i` for connection details and `r` to refresh. Authentication errors require checking the server credentials; unsupported routes or invalid response shapes require checking server compatibility, not bypassing validation.

The TUI covers most of what the desktop app does with a server; [GUI parity](./gui-parity.md) lists each desktop feature, where it is in the TUI, and what is left to the desktop. See [TUI development](../../development/tui.md) for verification scope.
