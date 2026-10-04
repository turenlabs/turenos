# TUI agent commands

`turen-tui` also runs as a set of non-interactive commands for scripts and coding agents: list sessions, read transcripts, send messages, wait for turns, answer permissions and questions, and stop work. They need no terminal, print stable labelled text or one JSON document, and return exit codes a caller can branch on. They use the same server targeting, credential rules, transport limits and validation as the dashboard.

## Commands

The first argument picks a command; anything else (a URL, an option or nothing) opens the dashboard as before. Each command takes `--help`.

| Command                                                                    | Does                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions [--dir D] [--limit N] [--all]`                                   | Recent sessions with id, state (`running`, `needs-input` or `idle`), updated time, directory, parent and title. `--limit` 1-100, default 30; `--all` includes archived sessions.                                                        |
| `show <session> [--limit N] [--all] [--raw]`                               | The transcript, then pending requests with the commands that resolve them. `--limit` 1-30 (the server's page size); `--all` follows history to the start, oldest first, up to 2,000 messages.                                           |
| `send <session> [text \| -] [--queue] [--wait]`                            | Reply to a session. The text is the argument, or stdin for `-` or no argument. A leading `/` runs a server command and a leading `!` a shell command, as in the dashboard; neither takes `--queue`. Delivery is steer unless `--queue`. |
| `send --new [text \| -] [--dir D] [--model P/M] [--agent A] [--variant V]` | Start a session. `--dir` defaults to the server's directory.                                                                                                                                                                            |
| `wait <session> [--timeout S]`                                             | Block until the session is idle (prints its last reply) or needs input.                                                                                                                                                                 |
| `pending [<session>]`                                                      | Pending permissions and questions for one session, or for every running session.                                                                                                                                                        |
| `approve <session> <permission-id> [--always]`                             | Allow once; `--always` also saves the rule the request offers.                                                                                                                                                                          |
| `reject <session> <permission-id>`                                         | Reject a permission request.                                                                                                                                                                                                            |
| `answer <session> <question-id> --choice <label>...`                       | Answer one question by label (repeat for several options), `--answers '[["Red"],["Yes"]]'` for several questions, or `--reject`. A label outside the options is accepted only when the question allows custom answers.                  |
| `stop <session> [--tasks]`                                                 | Interrupt the session; `--tasks` also cancels its active subagent tasks.                                                                                                                                                                |

Every command takes `--url <origin>`, `--server <name>`, `--username <name>`, `--discover-auth` and `--json`. The server is `--url`, then `TURENOS_SERVER_URL`, then the local TurenOS; an explicit URL or saved server never falls back to discovery. The password comes only from `FORGE_SERVER_PASSWORD` or a record the local server publishes; there is no password flag.

```sh
turen-tui send --new "fix the failing test" --dir /srv/app --wait
turen-tui pending
turen-tui approve ses_abc per_123 && turen-tui wait ses_abc
turen-tui show ses_abc --all --json
```

## Waiting

`send --wait` and `wait` block until the session is idle and has a reply after the sent message, or until it needs input. The live event stream only wakes the wait early; every pass re-reads the session's state, at most a second apart, because the server may drop events for a slow reader. The default timeout is 600 seconds, and `--timeout 0` waits without limit.

When a permission or question is pending, the output lists each request with the exact command that resolves it, for example:

```text
permission per_123 · session ses_abc · bash · echo sandbox-marker && ls
  approve: turen-tui approve ses_abc per_123
  reject:  turen-tui reject ses_abc per_123
```

## Output and exit codes

Text output is plain: labelled lines, no colour, spinners or boxes, with server text stripped of terminal controls. `--json` prints exactly one document on stdout (`{"sessions": [...]}`, `{"session", "state", "messages", "pending"}`, `{"ok": true, ...}`); an error prints one line on stderr and, with `--json`, `{"error": {"message", "retry"?}}` on stdout.

| Exit | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 0    | Done                                                                  |
| 1    | Failed: a server or transport error, a refusal, or an unknown outcome |
| 2    | Usage error                                                           |
| 3    | The session needs input                                               |
| 4    | The wait timed out                                                    |

## Retries

Every write carries a client-generated ID (`msg_…`, and `ses_…` for `send --new`), or the caller's `--id` and `--session-id`. When a send fails after the request may have reached the server, the command exits 1 with `Outcome unknown`, prints the ID, and says to retry with `--id`: the server drops a message whose ID it already has, so the retry cannot send it twice. A definite refusal (a 4xx other than 408 or 409) says that nothing was sent. Length, mention, command and shell checks all run before anything is sent.

## Limits

- A child session owned by a subagent task refuses direct replies, as in the dashboard, and the command names the owning session when it can.
- `--allow-outside` lets `@file` mentions outside the session directory attach; the dashboard asks for a second send instead.
- `show --all` makes one request per 30 messages.

## Source

- `packages/tui/src/cli.ts`, `packages/tui/src/agent.ts`
- `packages/tui/src/agent/run.ts`, `packages/tui/src/agent/endpoint.ts`, `packages/tui/src/agent/help.ts`
- `packages/tui/src/agent/send.ts`, `packages/tui/src/agent/delivery.ts`, `packages/tui/src/agent/wait.ts`
- `packages/tui/src/agent/requests.ts`, `packages/tui/src/agent/answer.ts`, `packages/tui/src/agent/stop.ts`
- `packages/tui/src/server/launch.ts`
