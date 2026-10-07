# TUI and Desktop parity

The TurenOS terminal client and TurenOS Desktop are two clients of the same server: sessions, agents, the session harness, tools, and settings live on the server, so work started in one client can be continued in the other. This page maps the desktop's features to the TUI as of TurenOS 1.0.32. Keys are dashboard keys; every feature is also in `Ctrl+P`.

## Sessions and conversation

| Desktop                                             | TUI                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| Transcript with live streaming, history paging      | Main pane; `h`, `[`, `]` for history                                    |
| Composer: steer or queue, slash commands, `@` files | Reply editor open under the transcript; `Ctrl+T`, `/`, `@`              |
| Skills from extensions in the slash list            | `/` lists them, marked **Skill**                                        |
| Shell mode (`!`)                                    | `!` at the start of a message                                           |
| Queued follow-up dock: send now, edit               | `u` (also discard)                                                      |
| Agent, model, and effort pickers                    | `/agent`, `m`, `/effort`                                                |
| Permission dock: deny, allow once, allow always     | Opens itself; `1`, `2`, `3` answer; `p` reopens it                      |
| Question dock                                       | `o` (opens automatically)                                               |
| Goal dock                                           | `/goal`                                                                 |
| Harness panel                                       | `H`                                                                     |
| To-do dock and subagent list                        | `t`                                                                     |
| Swarm room: lanes, entries, human posts             | `w`                                                                     |
| Context usage meter                                 | Action row: `Context 45% · 90k/200k`                                    |
| Review panel: git, branch, last turn                | `d`                                                                     |
| File tree and file viewer                           | `e`                                                                     |
| Shared session terminal and private terminals       | `T`; Terminals tab `2` (`Enter` attach, `a` new, `R` rename, `d` close) |
| Activity tab: tools and MCP servers                 | `/tools`                                                                |
| Traces: a session's event history                   | `/trace`                                                                |
| Undo, redo, compact                                 | `/undo`, `/redo`, `/rewind`, `/compact`                                 |
| Rename, archive, restore, delete                    | `/rename`; `Ctrl+P`; `/delete`                                          |
| Kill switch (stop all agents)                       | `/stop-all`                                                             |
| New session in a new worktree                       | New session settings: **Workspace**                                     |

## Home, navigation, and settings

| Desktop                                                 | TUI                                          |
| ------------------------------------------------------- | -------------------------------------------- |
| Session list, search, archived sessions                 | Sidebar, `Ctrl+K` (Recent, All, Archived)    |
| Open project folders                                    | Working folders (shared with the desktop)    |
| Automations: create, edit, pause, run now, runs, delete | Automations tab `3`                          |
| Intel: advisories, KEV, news, feeds                     | `I`                                          |
| Providers: connect, disconnect, remove                  | `,` → Providers; `F2` in the model picker    |
| Usage and limits                                        | `,` → Usage and limits                       |
| Extend: skills, MCP, data; secrets, settings, sign-in   | `,` → Extensions                             |
| Memories                                                | `,` → Memories                               |
| Agents' default models                                  | `,` → Agents                                 |
| Permission checks                                       | `,` → Permissions (also removes saved rules) |
| Servers: local app, SSH, URLs                           | `s`                                          |

## Left to the desktop

These stay desktop-only, mostly because they depend on a graphical surface or on the desktop app itself:

- **Whiteboard**, **Browser** (the security proxy), and the **Lobby** beta.
- **Pinned sessions and tabs**, **project names and icons**, and **Git init** for a folder without a repository.
- **Line comments** from the review panel and file viewer; in the TUI, mention the file with `@` instead.
- **Attachments from this computer**, such as pasted images. `@` attaches files that are on the server.
- **Automation workflows and event triggers**; the TUI edits the name, prompt, and schedule, and shows the rest.
- **Cross-session trace search and playback**; `/trace` pages one session's events.
- **MCP runtime backend** (Docker or local) and adding or resetting Intel feeds; the TUI turns feeds on or off.
- **WSL servers**, updates, release notes, themes, fonts, sounds, and notifications.
