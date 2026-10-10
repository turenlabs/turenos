# TUI development

How to test and verify `packages/tui`, the OpenTUI terminal client described in [the TUI system page](../systems/tui/README.md). Run package commands from `packages/tui`; the repository root refuses to run tests.

## Checks

```sh
cd packages/tui
bun run test        # bun test --timeout 30000
bun typecheck       # tsgo --noEmit --checkers 1
bun run build       # writes dist/cli.js, ignored by git
```

A focused run needs the script's timeout too: `bun test test/conversation-scroll.test.ts test/dashboard.test.ts --timeout 30000`. From the repository root, `bun run lint` enforces the size limits below, and `bun run tui` starts the client.

The tests (`packages/tui/test/`) drive the real client against synthetic HTTP fixtures and OpenTUI test renderers (`test/support.ts` holds the shared server, event-stream and cleanup helpers). They cover transport validation, retry behavior, keyboard and modal interaction, session browsing and mutations, provider flows, models, Markdown and activity display. They do not test against a production server.

## Size limits

`packages/tui/src/**/*.ts` stays under 400 lines per file and 60 lines per function (blank lines and comments not counted), as errors in the root `.oxlintrc.json`. The limits keep each feature in small modules a reader can hold at once: a folder per feature with a façade module beside it that exposes the feature's controls. Split a file that approaches the limit by feature rather than raising it.

## Fixture rules

- Use synthetic data only: no production transcripts, credentials, shell history or machine installation records in fixtures, tests or docs.
- Never restart a live server or a running client to test the client. Tests and the PTY audit start their own loopback servers.
- Keep generated evidence (PNGs, logs, `evidence.json`) outside the repository.
- Keyboard fixtures use `mockInput.pressEnter()`, `pressArrow(direction, modifiers)` and `pressKey("ESCAPE")`. Confirm key delivery, and wait for the expected frame after a modal transition, before typing again.
- While a session is in view with the conversation focused, its reply editor has the keyboard (footer `Typing`), including at startup below 90 columns. Press Escape and wait for the frame to leave `Typing` before a single-letter shortcut.
- OpenTUI's test renderer destroys itself on `Ctrl+C` unless it is created with `exitOnCtrlC: false`, as the client's own renderer is; `terminal(width, height, true)` in `test/support.ts` does that.
- A Bun run that only prints usage or package scripts is not a passing test run, even with exit status zero.

Input and layout changes need both renderer tests and a real PTY. Preserve exact shortcut modifiers, captured request recipients, retry identifiers, transport limits, secret handling and focus when dialogs close or asynchronous responses arrive. Test reading positions during prepend-plus-stream updates, width reflow and docked replies, not only while following the tail. Exercise controls at the 58-column minimum (58x31 is a phone over SSH) and at 80x24, as well as larger sizes.

## Testing a feature

The checks build on each other, from fastest to most real:

1. **Renderer test** (`test/`, runs in CI): the behavior against a synthetic fixture, including the failure paths a real server rarely produces.
2. **Sandbox check**: the same feature against a real server from this checkout, driven by hand or by an agent (below). It catches contract drift that fixtures can't, such as a field the server names differently.
3. **End-to-end scenario** (`e2e/`): when the feature crosses the server boundary, keep the sandbox check as a scenario so it stays checked.
4. **PTY audit**: for layout and terminal-mode changes, at every size it covers.

## Sandbox

`packages/tui/script/sandbox.ts` (`bun run sandbox`) starts a throwaway TurenOS server from this checkout's `packages/forge` source, with a scripted OpenAI-compatible model, isolated data and a seeded git project, and runs the TUI against it. People run the TUI in their own terminal; agents and tests run it in a tmux server private to the sandbox and read the screen as plain text.

```sh
cd packages/tui
bun run sandbox start demo      # under a minute (gives up after 3); prints the URL, the project folder and the model's trigger words
bun run sandbox tui demo        # people: the TUI in this terminal, connected to the sandbox; options for it follow --
bun run sandbox stop demo       # stops the processes it started and deletes the run directory; --keep leaves it for the logs
```

An agent, or a script, drives the TUI in the background instead:

```sh
bun run sandbox launch demo --size 80x24      # default 120x36; --cli dist/cli.js runs a build; options for the TUI follow --
bun run sandbox wait demo "Connected"         # polls the screen; --regex, --timeout <ms> (default 15 s)
bun run sandbox keys demo n                   # tmux key names: Enter Escape C-s Up PageDown F2 BTab; also S-Enter, M-Enter, C-Enter
bun run sandbox type demo "please run the marker"
bun run sandbox type demo -- "- a list item"    # text after -- may start with -
bun run sandbox keys demo Enter
bun run sandbox screen demo                   # plain text, as an agent reads it; --color keeps the SGR codes
bun run sandbox idle demo                     # waits until the server reports no running session; --timeout <ms> (default 60 s)
bun run sandbox attach demo                   # a person watches or takes over; detach with Ctrl+B d
```

`settle` waits until the screen stops changing, `resize <W>x<H>` resizes the terminal, `close` ends the TUI (relaunch with `launch`), `exited` prints `exited` once the TUI process has ended (the pane keeps its last output) and `running` before that, and `list` shows the sandboxes. `api <name> <METHOD> <path> [json]` sends an authenticated request to the sandbox server, for seeding state or checking what the server holds. `exec <name> -- <command>` runs a command in the sandbox project with the sandbox's environment, `TURENOS_SERVER_URL` and `FORGE_SERVER_PASSWORD` set and `turen-tui` on `PATH` for this checkout, for example `bun run sandbox exec demo -- turen-tui sessions --json`. Like an agent in its own project, its listings and new sessions use the sandbox project (see [agent commands](../systems/tui/agent-commands.md)). After `keys` sends Escape it pauses 120 ms, because Escape followed at once by another byte reads as Alt+key. When the TUI shows a session with the conversation focused, its reply editor has the keyboard (the footer reads `Typing`): `type` goes into it, and single-letter shortcuts need `keys Escape` first. In the e2e driver, `compose()` opens the reply editor only when it is not already open.

### Scripted model

The latest user message chooses the reply: the first row of the table below whose word the message contains (the three factory rows come first, because a factory prompt carries the outcome and room text, which may hold any other word), not the first word in the message (`write and run` runs, because `run` comes first). Anything else gets a short reply that lists the words. A message that begins with `<` is a server notice (a child's result, room updates) and gets `Noted.`, so a quoted trigger word cannot loop. A Team task's prompt is matched only from its `User message:` up to the room history marked as untrusted context, so a teammate's mission ("Write summaries") or an earlier `Factory run …` line does not fire a tool on every task.

| Word                                          | Reply                                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Return only FactoryPlan JSON`                | Exactly a Team factory plan: the `Selected IDs: [...]` of the prompt, one short assignment each                         |
| `Return only FactoryCheck JSON`               | Exactly `{"status":"accepted","summary":"Sandbox check accepted the outputs."}`                                         |
| `Reply with one short line about the outcome` | One line, `Sandbox worker line: the outcome is covered.`; the plan's assignment text, which would otherwise match `run` |
| `run`                                         | A `bash` call, `echo sandbox-marker && ls`; permission checks make it ask first                                         |
| `ask twice`                                   | Two questions, the second multiple choice                                                                               |
| `ask me`                                      | One single-choice question (Red or Blue)                                                                                |
| `write`                                       | A `write` call creating `notes.md`                                                                                      |
| `edit`                                        | An `edit` call changing `42` to `43` in `answer.ts`                                                                     |
| `read`                                        | A `read` call on `README.md`                                                                                            |
| `todo`                                        | A `todowrite` call with three to-dos in three states                                                                    |
| `delegate`                                    | A `spawn_agent` call; the child session answers plainly                                                                 |
| `slow`                                        | About 40 s of streamed words, for interrupting                                                                          |
| `long`                                        | Sixty varied paragraphs, for scrolling and history                                                                      |
| `markdown`                                    | Headings, lists, code, a table, a link and a quote                                                                      |
| `think`                                       | Reasoning before the answer                                                                                             |
| `fail`                                        | HTTP 401, which the server does not retry                                                                               |
| `flaky`                                       | HTTP 503 five times, then a reply; the server retries on its own                                                        |

After a tool result the model replies `Done: the <tool> tool returned:` with the result, so a scenario finishes in one turn. If the server did not offer the scenario's tool to the agent, the reply says `The server did not offer the <tool> tool to this agent, so nothing ran.` Titles come from the first words of the first message.

### Isolation

- Everything lives in `$XDG_RUNTIME_DIR/turen-tui-sandbox/<name>` (`TUREN_SANDBOX_ROOT` overrides; it must be outside the repository): home, XDG directories, the project, logs (`server.log`, `model.log`, `tui.log`) and `sandbox.json`. The tmux socket sits there too, so the path stays short; tmux refuses socket paths of 104 bytes or more.
- The server, the model and the TUI get an environment built from an allowlist (`PATH`, `LANG`, `LC_ALL`, `USER`, `LOGNAME`, `SHELL`, `TZ`, plus `TURENOS_REDUCED_MOTION` when set), so the owner's API keys, server URLs and `TMUX` never reach them. `tui <name>` adds your terminal's `TERM` and `COLORTERM` so colours match it (`xterm-256color` and an empty `COLORTERM` when yours are unset), and `launch` sets `TERM=xterm-256color`, `COLORTERM=truecolor` and `LANG=C.UTF-8` in the private tmux. The server runs with `FORGE_DISABLE_MODELS_FETCH`, `FORGE_DISABLE_AUTOUPDATE` and `FORGE_DISABLE_CLAUDE_CODE`, and a throwaway vault key.
- The sandbox password is random per start and kept in a `0600` file in the run directory, which the TUI's shell reads, so it never appears in an argument list. The run directory is deleted on `stop`.
- Where `systemd-run --user` works, the server and the model run in their own scope capped at 3 GB (`--memory-max <size>`, or `0` for no cap).
- Permission checks are turned on (`PUT /global/permission-checks`) and the config sets `bash` to ask, unless `start` gets `--no-permissions`.
- The server listens on a free loopback port the script picks itself. The server's own `--port 0` means "4096 first", the desktop's default port, so the sandbox never passes it.
- The TUI always gets the sandbox URL. Its server picker still discovers what this machine publishes, such as `/etc/turenos/attach.json`, and lists a headless server on port 4096 because `FORGE_SERVER_PASSWORD` is set; that entry is never the sandbox itself. Never select those from a sandbox.

## End-to-end tests

`packages/tui/e2e/*.e2e.ts` drive the TUI from `src` against a sandbox per file, through the same driver (`e2e/support.ts`). Bun skips them in `bun run test`, so CI does not run them; they need tmux and take a few minutes:

```sh
cd packages/tui
bun run test:e2e                              # every scenario file
bun test ./e2e/requests.e2e.ts --timeout 120000
```

The files cover the conversation (streaming, Markdown, reasoning, scrolling, recall), requests (permissions, questions, stopping, provider errors and retries), panels (Changes, Files, Tasks, subagents), the Terminals, Automations and Team tabs (two teammates, a configured factory and a run that reads `succeeded` with the check summary), the 60x24 layout with resizing and quitting, and the agent commands with the dashboard watching. Tests in a file share one sandbox and run in order. Assert on what the screen says and, where the server is the truth, on `api()` and `idle()`; a scenario that waits for text should wait for the specific line, not sleep.

## PTY audit

`packages/tui/script/visual-audit.py` runs the current source, or the built `dist/cli.js` with `--built`, in isolated tmux PTYs against a synthetic HTTP fixture server and reconstructs PNGs of the terminal cells with Pillow. It needs Bun, tmux, Python 3 with Pillow, and DejaVu Sans Mono (regular, bold, oblique, bold-oblique). It is not part of CI and never installs those tools.

```sh
cd packages/tui
bun run build
python3 script/visual-audit.py /run/user/1000/tva --built
python3 script/visual-audit.py /run/user/1000/tva --built --sizes 60x24 120x36
```

- The output directory must be outside the repository and short: the runner places its tmux socket there and refuses a path of 104 bytes or more. It uses its own socket (`tmux -S`), never the default tmux server.
- The default run covers 160x48, 120x36, 90x28, 80x24, 60x24 and 58x31 (a phone over SSH) plus a 59x23 resize-shield case. `--exit-only` and `--lifecycle-only` run the exit-restoration and close/reopen/resize subsets.
- The fixture server answers `GET /global/health` as a server the client verifies, and every request lands in `evidence.json`. A request outside the allowed set fails the `safety` check.
- Its keystrokes follow the docked reply editor, as a person's do: a shortcut scenario presses `Escape` first, an editor action opens the editor with `f`, and the exit scenarios cover an unsent draft and a running turn (`Ctrl+C` stops the turn first, `q` warns). The fixture answers `404` for a session it does not serve.
- Exit status 1 means a check failed; `summary.md` and `evidence.json` at the output root describe the latest run. The runner hashes `src/**/*.ts` at the start and end and fails if source changed during capture.
- The PNGs are reconstructions of tmux cells, not screenshots of a GUI terminal, and a pass is not a visual review. Open a few and look.
- Remove the output directory and the package's `dist` build output afterwards.

## Source

- `packages/tui/package.json`
- `packages/tui/test/support.ts`
- `packages/tui/script/sandbox.ts`, `packages/tui/script/sandbox/server.ts`, `packages/tui/script/sandbox/terminal.ts`, `packages/tui/script/sandbox/scenarios.ts`
- `packages/tui/e2e/support.ts`
- `packages/tui/script/visual-audit.py`
- `.oxlintrc.json`
