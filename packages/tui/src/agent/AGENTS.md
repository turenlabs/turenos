# Agent commands

`turen-tui <command>` runs without a terminal UI, for scripts and coding agents:
- `src/cli.ts` sends agent-command words here;
- `run.ts` dispatches the words in `words.ts`;
- `endpoint.ts` chooses the server (`--url`, `--server`, or discovery);
- `help.ts` holds the text `--help` prints.

Reference: `docs/systems/tui/agent-commands.md`.

## Conventions

- Output is a contract that scripts parse. Add JSON keys; don't rename or remove them.
- `--json` prints one document, and errors become `{"error": {"message", …}}` on stdout (`run.ts`).
- Exit codes are 0 done, 1 failed, 2 usage, 3 needs input, 4 timeout, 5 the turn failed or was interrupted (`wait.ts`). Fail by throwing `AgentError` (`errors.ts`) with its code, never with `process.exit`.
- A send whose delivery is uncertain reports its retry ID, so a retry cannot deliver twice.
- On a server on this computer, `sessions`, `pending` and `send --new` default to the folder the command runs in (`folder.ts`). `--dir` names another; `--everywhere` lists all.
- Check a change against a real server with `bun run sandbox exec <name> -- turen-tui …`. It runs in the sandbox project, with the sandbox's URL and password in its environment.

## Tests

- `test/agent-*.test.ts` drive the commands with `test/agent-fixture.ts`.
- `e2e/agent-cli.e2e.ts` runs them against a sandbox.
