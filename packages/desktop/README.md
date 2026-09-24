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

This package has no `build` or `package` scripts. Stage the sidecar, build the
JS assets, then bundle them as an application; the result is in `dist/`.

```bash
bun ./scripts/prebuild.ts
bunx electron-vite build
bunx electron-builder --config electron-builder.config.ts --publish never
```

For an unsigned local dev app, see "Dev Builds" in the root `AGENTS.md`.

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
