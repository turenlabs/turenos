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
bun run license:check                  # third-party license inventory; `bun run license:generate` rewrites it
bun --cwd packages/desktop typecheck
bun --cwd packages/app typecheck
bun --cwd packages/forge typecheck
```

Run `bun typecheck` from a package folder; don't call `tsc` directly. To work on the web UI without Electron, start the
backend from `packages/forge` with `bun run --conditions=browser ./src/index.ts serve --port 4096`, then run
`bun dev -- --port 4444` in `packages/app` and open `http://localhost:4444`. After changing English UI strings,
`bun run translate:app all` (or one locale, such as `de`) translates the changed strings into the other locales with a
model; add `--check` or `--dry-run` to see the drift without writing.

If Electron exits silently when you run `bun dev` from a terminal inside another Electron app (VS Code, Cursor, the
TurenOS Desktop), the shell inherited `ELECTRON_RUN_AS_NODE=1`, which makes every `electron` binary run as plain
Node. Start it with `env -u ELECTRON_RUN_AS_NODE bun dev`.

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
- `tools/` — the bounded WebAssembly tool targets.
  Follow `tools/AGENTS.md`. Rebuild a target locally with
  `bun run build:wasm <target>`; on `main` pushes,
  `.github/workflows/build-<target>.yml` rebuilds on GitHub-hosted
  runners and opens a PR updating `packages/<target>-wasm`.
- `services/catalog` — the canonical built-in extension catalog: the data, skill,
  MCP, and tool manifests under `manifests/`. They compile into
  `packages/extensions` via `bun run generate`; see `services/catalog/README.md`.

Read the nearest `AGENTS.md` before editing a package. Run focused tests and `bun typecheck` from each package you changed before opening a pull request. Tests run from package folders such as `packages/forge`; the root `test` script only exits with "do not run tests from root".

## Documentation

Engineering docs live in [`docs/`](docs/README.md), organized by the method summarized in
[How these docs are organized](docs/README.md#how-these-docs-are-organized). Write and correct pages by reading the
code they describe; the checker below only catches broken links, missing paths and unindexed pages. After changing
docs, run:

```bash
bun .agents/skills/turen-documentation/scripts/check.ts docs
```

The method is the [`turen-documentation`](.agents/skills/turen-documentation/SKILL.md) skill in `.agents/skills/`.
Coding agents are told to read it by the root `AGENTS.md`; not every agent discovers `.agents/skills/` on its own
(TurenOS loads skill folders only when a `forge.json` lists them under `skills`). The `AGENTS.md` files are maintained
with the [`turen-context`](.agents/skills/turen-context/SKILL.md) skill; after editing one, run
`bun .agents/skills/turen-context/scripts/check.ts`.

Agent rules live only in `AGENTS.md` files, the format Codex, OpenCode, TurenOS and most other agents read. Claude
Code reads `CLAUDE.md` instead, so every `AGENTS.md` has a `CLAUDE.md` beside it holding a single `@AGENTS.md` import
line; don't add rules to those.

## Pull requests

- Branch from `main` and use a short branch name.
- Use conventional commit and PR titles such as `feat:`, `fix:`, `docs:`, or `chore:`.
- Explain the security boundary, data flow, and failure behavior for security-sensitive changes.
- Include a reproducible verification note and screenshots for visible UI changes.
- Keep upstream compatibility in mind, but do not reintroduce the upstream workspace package scope or imports.

Read [docs/architecture/README.md](docs/architecture/README.md) for the dependency graph and
[docs/architecture/branding.md](docs/architecture/branding.md) before changing product or compatibility names.
