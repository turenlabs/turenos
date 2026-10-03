# Turen TUI

An independent Bun terminal client for an existing TurenOS server. It runs the terminal UI locally; sessions, tools, and model execution stay on the server.

Use **Bun 1.4.2**, as pinned in [package.json](package.json), from this repository root. If another Bun version is installed globally, `npm exec` keeps setup and launch on the pinned version:

```sh
npm exec --yes --package=bun@1.4.2 -- bun install --frozen-lockfile
npm exec --yes --package=bun@1.4.2 -- bun run start -- --help
npm exec --yes --package=bun@1.4.2 -- bun run start -- https://turen.example
```

Replace the example origin with your server. See [usage](docs/guides/usage.md) for authentication and keyboard controls.

Without a URL, the TUI opens TurenOS on this computer: the running TurenOS app, which publishes its connection in `attach.json`, or else this host's quick-connect or persistent server. Press `s` at any time to switch servers. The picker lists servers on this computer, servers you saved (an `https://` URL or an SSH `user@host`), and the SSH servers saved in TurenOS Desktop. When TurenOS isn't running, it can also start a private `forge serve` that stops when you quit. SSH servers are reached through a private tunnel, the same way TurenOS Desktop reaches them. See [switching servers](docs/guides/usage.md#connect-and-switch-servers).

```sh
npm exec --yes --package=bun@1.4.2 -- bun run start                   # TurenOS on this computer
npm exec --yes --package=bun@1.4.2 -- bun run start -- --server lab   # a saved server
```

Sessions run through the server's own agents and session harness, whichever client started them, so you can switch between this TUI and TurenOS Desktop on the same work. The TUI covers most desktop features: review changes (`d`), browse files (`e`), attach to server terminals (`T`, or the Terminals tab), manage automations, the swarm room (`w`), queued messages (`u`), Settings for providers, usage, extensions, memories, and permissions (`,`), threat intel (`I`), and the session harness (`H`), whose reviewer proposals you can approve, reject, reload, or roll back after confirming. [GUI parity](docs/reference/gui-parity.md) lists each desktop feature and what stays desktop-only.

This is a source CLI: keep Bun and the intact `node_modules` installation available. There is no standalone compiled binary build or bundled server. It does not replace an existing installed `turen-tui` helper.

`bun run build` also produces `dist/cli.js`, a Bun JavaScript bundle with external dependencies. See [rebuild instructions](docs/guides/development.md#rebuild). In the conversation, `/` opens command entry; `Ctrl+X` opens the subagent browser from the dashboard. Startup prefers a loaded main session over active subagents.

In any editor, `@` searches the server's files and attaches the one you choose (`@src/auth.ts#20-45` attaches just those lines), and a message starting with `!` runs one shell command on the server. `F2` (or `/editor`) composes the draft in `$EDITOR`. The server opens mentioned files, so these work unchanged against a remote server. See [usage](docs/guides/usage.md#mention-files-and-run-commands).

- [Documentation](docs/README.md)
- [Development](docs/guides/development.md)
- [Architecture](docs/architecture/overview.md)
- [Source provenance](docs/reference/provenance.md)
- [Private GitHub repository](https://github.com/jlmiles4/turen-tui) (access required)

MIT licensed. Derived from TurenOS by Turen Labs and OpenCode by its contributors; see [LICENSE](LICENSE), [NOTICE](NOTICE), and the [attribution details](docs/reference/provenance.md#attribution).
