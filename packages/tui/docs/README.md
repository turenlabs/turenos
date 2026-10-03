# Turen TUI

Turen TUI is a local terminal interface to TurenOS servers. It opens the TurenOS app on this computer by default, and `s` switches to this host's other servers, saved URL or SSH servers, or the SSH servers saved in TurenOS Desktop. This documentation belongs to the independent Bun repository, not a Python client or the TurenOS monorepo.

The client covers most of what TurenOS Desktop does with a server, so you can use either client on the same sessions: review changes (`d`), browse files (`e`), attach to terminals (`T`, tab `2`), manage automations (tab `3`), the swarm room (`w`), settings with providers, extensions, and memories (`,`), threat intel (`I`), the session harness (`H`), and goals (`/goal`). [GUI parity](reference/gui-parity.md) maps each desktop feature to its TUI key and lists what stays desktop-only.

The conversation pane supports `/` command entry, and `Ctrl+X` opens the dashboard's subagent browser. Startup prefers a loaded main session. A dependency-external JavaScript bundle is available through `bun run build`; see [rebuilding](guides/development.md#rebuild).

## Quick start

With the [pinned Bun version](../package.json) installed, run from this repository root:

```sh
bun install --frozen-lockfile
bun run start
bun run start -- https://turen.example
```

Without a URL, the client connects to TurenOS on this computer or opens the server picker. [Usage](guides/usage.md#connect-and-switch-servers) covers discovery, saved servers, credentials, server directories, and interaction. Runtime dependencies must remain installed; there is no compiled single-file distribution.

## Documentation

- [Usage](guides/usage.md): connecting and switching servers, drafts, navigation, the session harness, goals, model variants, and provider setup.
- [Development](guides/development.md): root-level checks and optional synthetic PTY verification.
- [Architecture](architecture/overview.md): module responsibilities, transport boundaries, and remote compatibility.
- [GUI parity](reference/gui-parity.md): each desktop feature, where it is in the TUI, and what stays desktop-only.
- [Provenance](reference/provenance.md): working-tree extraction, the vendor patch, and licensing.

## Repository layout

```text
src/          Terminal client and standalone CLI
test/         Bun tests with synthetic HTTP and renderer fixtures
vendor/client/ Local Promise HTTP client package
script/       Optional visual-audit runner
.github/      Linux CI workflow
docs/         Maintained guides, architecture, and provenance
```

See [initial verification](guides/development.md#initial-verification) for the checks run on this independent checkout and [verification boundaries](guides/development.md#verification-boundaries) for their scope.
