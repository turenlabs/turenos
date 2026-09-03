# TurenOS runtime

This package is TurenOS's bundled server and CLI composition layer. It wires
the Core services, Protocol/API routes, provider integrations, tools, MCP,
security integrations, LSP, VCS, and native runtime assets into a runnable
headless process.

The package path, package name, and executable remain `packages/forge`,
`@turenlabs/forge`, and `forge` for compatibility with existing installs,
scripts, and consumers. The product name is TurenOS; see
[`../../docs/branding.md`](../../docs/branding.md) before changing one of
these identifiers.

## Development

From this package directory:

```bash
bun run dev
bun run typecheck
```

Build the standalone runtime from the repository root with the package's
build script:

```bash
bun run --cwd packages/forge build
```

The Desktop host uses the resulting runtime as a supervised local sidecar.
The same server can run headlessly for CLI, API, WSL, and automation flows.

## Boundaries

- Core owns durable state, Session V2 execution, tools, permissions, and
  location-scoped services.
- Protocol and Server own typed request/response contracts and handlers.
- This package owns product composition, CLI commands, legacy compatibility,
  security integrations, MCP, and process startup.
- Desktop owns the OS-facing shell and sidecar lifecycle; it does not move
  session execution into the renderer.

See [`../../docs/architecture.md`](../../docs/architecture.md) and
[`../../docs/systems.md`](../../docs/systems.md) for the runtime graphs and
subsystem catalog.
