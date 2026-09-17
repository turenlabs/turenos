# Contributing to TurenOS

Open an issue before beginning a large product or architecture change so the trust boundary and upstream impact are explicit.

## Development

Requirements:

- Bun 1.4.2, as pinned in `package.json`;
- Git;
- platform toolchains required by Electron or native dependencies.

```bash
bun install --frozen-lockfile
bun dev
```

If Bun is not installed globally, use the pinned runner through `npx`:

```bash
npx --yes bun@1.4.2 install --frozen-lockfile
npx --yes bun@1.4.2 run dev
```

Build the Desktop application:

```bash
bun --cwd packages/desktop build
```

Common checks:

```bash
bun run lint
bun --cwd packages/desktop typecheck
bun --cwd packages/app typecheck
bun --cwd packages/forge typecheck
```

The main packages are:

- `packages/forge` — TurenOS Desktop's bundled runtime, server, and tools;
- `packages/core` — shared services;
- `packages/app` and `packages/ui` — application UI;
- `packages/desktop` — Electron host and packaging.

## Repository layout

Three areas with different toolchains and CI paths:

- `packages/` — TurenOS itself: the Bun/Turbo workspace, including the
  checked-in `packages/*-wasm` runtime packages consumed via
  `@turenlabs/<target>-wasm` workspace dependencies. Never hand-edit a
  `*-wasm` package; it is generated (see below) and CI verifies its
  `SHA256SUMS` manifest.
- `tools/` — the bounded WebAssembly tool targets (formerly `wasm-tools`).
  Follow `tools/AGENTS.md`. Rebuild a target locally with
  `bun run build:wasm <target>`; on `dev` pushes the self-hosted
  `.github/workflows/build-<target>.yml` rebuilds and opens a PR updating
  `packages/<target>-wasm`.
- `services/catalog` — the canonical Turen Catalog: the built-in data, skill,
  MCP, and tool manifests under `manifests/`. They compile into
  `packages/extensions` via `bun run generate`; see `services/catalog/README.md`.

Read the nearest `AGENTS.md` before editing a package. Run focused tests and `bun typecheck` from each package you changed before opening a pull request. Do not run the root `test` script; the repository intentionally requires package-scoped test commands.

## Pull requests

- Branch from `dev` and use a short branch name.
- Use conventional commit and PR titles such as `feat:`, `fix:`, `docs:`, or `chore:`.
- Explain the security boundary, data flow, and failure behavior for security-sensitive changes.
- Include a reproducible verification note and screenshots for visible UI changes.
- Keep upstream compatibility in mind, but do not reintroduce the upstream workspace package scope or imports.

Read [docs/architecture.md](docs/architecture.md) for the dependency graph and
[docs/branding.md](docs/branding.md) before changing product or compatibility names.
