# TurenOS terminal client

`@turenlabs/tui` is a keyboard-first terminal client for a running TurenOS server, built on OpenTUI. It renders locally; sessions, tools and model execution stay on the server, so work started here continues in TurenOS Desktop and the reverse.

From the repository root:

```sh
turen-pkg npm install --frozen-lockfile
bun run tui                          # TurenOS on this computer, or the server picker
bun run tui -- https://turen.example
```

It needs Bun and the installed `node_modules`; there is no compiled binary or bundled server. Scripts and coding agents use the same binary without a terminal: `turen-tui sessions --json`, `turen-tui send --new "…" --wait` and the other commands in `turen-tui --help`.

Run tests, typecheck and the build from this folder (`bun run test`, `bun typecheck`, `bun run build`). `bun run sandbox start <name>` starts a throwaway server with a scripted model to try the TUI against, and `bun run test:e2e` runs the end-to-end scenarios on it.

- [System overview](../../docs/systems/tui/README.md): module map, transport, live stream, server discovery and remote compatibility.
- [Usage](../../docs/systems/tui/usage.md): connecting, keys and commands.
- [Agent commands](../../docs/systems/tui/agent-commands.md): the non-interactive commands, output and exit codes.
- [GUI parity](../../docs/systems/tui/gui-parity.md): desktop features and their TUI keys.
- [Development](../../docs/development/tui.md): tests, the sandbox, end-to-end scenarios, size limits and the PTY audit.

MIT licensed. The client derives from the TurenOS terminal client, which derives from OpenCode; see the repository `LICENSE` and `NOTICE`.
