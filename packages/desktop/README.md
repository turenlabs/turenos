# TurenOS Desktop

The TurenOS Desktop app, built with Electron. Desktop owns the OS-facing shell
and supervises a bundled `packages/forge` runtime as an authenticated local
sidecar; the renderer communicates through the preload bridge and typed HTTP
client.

## Development

```bash
bun install
bun dev
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```

## Beta Rebuild And Restart

From the repository root, rebuild, reinstall, refresh the standalone CLIs, and
restart the signed Apple Silicon beta app with:

```bash
bun ./script/beta-rebuild.ts
```

The helper records the revision and dirty state, refuses to replace a running
beta process, preserves the previous bundle under `/tmp`, verifies `app.asar`
and CLI hashes, checks the installed signature, and probes the authenticated
sidecar with an ephemeral beta-only password.

See [the architecture guide](../../docs/architecture.md) for the full Desktop,
renderer, sidecar, and WSL topology.
