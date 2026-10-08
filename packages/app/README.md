# TurenOS renderer

The `@turenlabs/app` package is the Solid renderer for TurenOS Desktop and
browser-style local development. It owns application views, reactive server
synchronization, session timelines, settings, WSL controls, and the interactive
system map. It does not own session execution or unrestricted OS capabilities.

## Development

From the repository root:

```bash
bun install --frozen-lockfile
bun --cwd packages/app dev
```

The Vite renderer is available at `http://localhost:3000`. Desktop development
starts the Electron host and its local sidecar with `bun dev` from the root.

## Build and checks

```bash
bun --cwd packages/app build
bun --cwd packages/app typecheck
bun --cwd packages/app test:unit
bun --cwd packages/app test:browser
```

## Renderer boundaries

- `src/context/server-sync.tsx` creates per-server SDK views and applies live
  event streams to reactive stores.
- `src/pages/session.tsx` and `src/pages/session/` present projected Session
  state; they do not run provider turns.
- `src/pages/system-map.tsx` is the source-linked interactive runtime atlas.
- Desktop-only capabilities are exposed through the typed preload bridge in
  `packages/desktop`, never through renderer Node access.
- Generated client types remain compatibility-oriented (`ForgeClient` and the
  `forge` package path); they are not display branding.

See [`../../docs/architecture/README.md`](../../docs/architecture/README.md) for the full
process and package topology.
