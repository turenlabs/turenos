<p align="center">
  <img src="docs/assets/turen-logo.png" alt="TurenOS" width="128" height="128">
</p>

<h1 align="center">TurenOS</h1>

TurenOS is Turen Labs' batteries-included security engineering workbench: the user-facing web UI and its Desktop application. It starts from the excellent [OpenCode](https://github.com/anomalyco/opencode) agent foundation and is being shaped into a focused environment for code review, application security, investigation, and remediation.

> [!IMPORTANT]
> TurenOS is under active development. Security-specific capabilities continue to evolve, so review the documented trust boundaries before using them in sensitive environments.

## Direction

**TurenOS is the product; `forge` is its backend CLI utility.** Users work in the TurenOS UI.
The `forge` executable supports headless server operation, remote hosts over SSH, managed WSL
backends, and backend administration. It is not a separate user-facing agent product.
Desktop runs its local server directly in an Electron utility process; a separate CLI installation
is not required. Existing CLI commands remain available, but their presence does not define a
parallel CLI product direction. See [Architecture](docs/architecture/README.md#system-shape) for the runtime
boundaries and [Branding](docs/architecture/branding.md) for retained compatibility names.

TurenOS should make a useful security workflow available without spending the first hour wiring tools together:

- repository and dependency reconnaissance;
- [Batou](docs/systems/batou.md)-powered code and application security analysis;
- secret, SAST, dependency, and supply-chain checks behind one agent workflow;
- evidence-preserving findings with file, line, command, and artifact provenance;
- review and remediation loops that can prove a fix rather than merely suggest one;
- explicit execution policies, isolated runners, audit logs, and safe defaults for risky tools.

The first milestone is a stable, continuously mergeable TurenOS distribution. Security capabilities should be added as modular batteries rather than buried in an unmaintainable fork.

## What works now

- model-agnostic TurenOS Desktop client with a bundled local agent server;
- local Claude Code provider (`claude-code/fable`, `sonnet`, `opus`, and `haiku`) using an existing `claude auth login` subscription instead of an Anthropic API key;
- deep links (`forge://`), config (`forge.json`), and data paths (`.forge`) — retained as load-bearing compatibility identifiers for existing installs;
- MCP, LSP, permission, session, and tool infrastructure inherited from [OpenCode](https://github.com/anomalyco/opencode);
- signed TurenOS Desktop builds for macOS, Linux, and Windows;
- a bundled `forge` utility (shipped in Desktop as the `forge-cli` binary) for backend operations, with managed SSH and WSL server support;
- cross-platform release packaging and upstream compatibility tracking.

TurenOS is not a sandbox. Agents can execute commands and modify files with your user privileges. Read [SECURITY.md](SECURITY.md) before using it on untrusted repositories.

## Documentation

Engineering documentation lives in [docs/](docs/README.md). Start with:

- [Claude Code provider](docs/providers/claude-code/README.md) — using a local `claude auth login` subscription instead of an API key.
- [Local models](docs/providers/local-models.md) — running Bonsai 2 locally and connecting its OpenAI-compatible endpoint.
- [Architecture](docs/architecture/README.md) — package boundaries and runtime topology, with linked pages on data flow, persistence, and trust boundaries.
- [Systems and subsystems](docs/systems/README.md) — responsibilities, ownership, and failure behavior across TurenOS.
- [Branding and compatibility](docs/architecture/branding.md) — why some `forge` identifiers remain stable.
- [Secure storage](docs/systems/secure-storage.md) — how credentials are encrypted.
- [Memory](docs/systems/memory.md) — durable project memory.
- [Automations](docs/systems/automations/README.md) — durable in-app workflows with interval/cron schedules,
  per-step `when`/`onFailure` conditions, and local file-change/session-end event triggers.
- [Token efficiency](docs/experimental/token-efficiency/README.md) — measured context cost against Claude Code and Codex.

## Monorepo

This repository is the TurenOS monorepo. Three areas ship together:

- **`packages/`** — TurenOS itself: a Bun + Turbo workspace covering the agent runtime, server, renderer, Electron host, SDKs, and the checked-in `packages/*-wasm` artifacts the runtime consumes.
- **`tools/`** — the built-in WebAssembly security tools. Each `tools/<target>` is a self-contained, reproducible bounded-WASM build with pinned upstreams and provenance. See [tools/README.md](tools/README.md) and [tools/AGENTS.md](tools/AGENTS.md).
- **`services/catalog/`** — the canonical built-in extension catalog: data sources, skills, MCP server definitions, and tool manifests under `manifests/`. They compile into `packages/extensions` at build time; there is no remote catalog. See [services/catalog/README.md](services/catalog/README.md).

`command-guard/` sits beside them as a standalone command-risk CLI for scripts and CI hooks. It is versioned on its own and TurenOS does not use it at runtime.

## Develop

TurenOS pins Bun 1.4.2.

```bash
bun install --frozen-lockfile
bun dev                 # TurenOS Desktop
```

Common tasks:

```bash
bun run lint            # repo-wide lint (warnings allowed, errors fail)
bun run verify:wasm     # validate packages/*-wasm checksum manifests

# Rebuild a WASM tool into packages/<target>-wasm (needs its toolchain;
# see script/build-wasm.ts --list):
bun run build:wasm <target>

# After editing a catalog manifest under services/catalog/manifests:
cd packages/extensions
bun run generate        # rewrite src/generated.ts
bun run check           # verify generated output is current
```

Normal builds do not need WASM toolchains — `packages/*-wasm` artifacts are checked in. Pushes to `main` that change `tools/<target>` trigger the `build-<target>` workflow on GitHub-hosted runners, which rebuilds and opens a PR updating the packaged artifact; that workflow verifies the new checksums, and every other PR runs `bun run verify:wasm` in the `pr` workflow. PRs touching only `tools/`, `services/`, or `docs/` skip the `test` workflow, which is also where the generated extension catalog is checked, so run `bun run check` in `packages/extensions` yourself after a catalog-only change.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pinned-runner fallback, build commands, and checks.

## Repository map

- `packages/forge` — bundled TurenOS agent runtime, server, tools, and native sidecar build.
- `packages/core` — shared Effect services and domain logic.
- `packages/app` — web and desktop renderer.
- `packages/desktop` — TurenOS Electron host and packaging.
- `packages/ui` — shared UI system and TurenOS identity.
- `packages/sdk` and `packages/sdk-next` — client SDKs.
- `packages/extensions` — the compiled extension catalog consumed by the server (`src/generated.ts` is generated; do not edit).
- `packages/*-wasm` — checked-in, checksum-verified WASM tool packages produced from `tools/`.
- `tools/` — WASM tool sources and build recipes; CI packs output into `packages/*-wasm`.
- `services/catalog` — catalog manifest sources; the authoring guide is in [docs/](docs/systems/developer-catalog-runtime/authoring.md).
- `command-guard` — standalone command-risk CLI; not part of the TurenOS runtime.

Every TurenOS-owned workspace package uses the `@turenlabs/*` scope; the private root `package.json` is named `forge`. Upstream provider IDs and durable migration keys remain unchanged where compatibility requires them. See [branding and compatibility](docs/architecture/branding.md) before changing a `forge` identifier.

## Hard fork provenance

TurenOS is an independently maintained hard fork of [OpenCode](https://github.com/anomalyco/opencode). The projects diverged after OpenCode commit [`3a1c6df9e24672f0761a6ced18e1315d89334baf`](https://github.com/anomalyco/opencode/commit/3a1c6df9e24672f0761a6ced18e1315d89334baf) on July 17, 2026. Changes after that fork point are TurenOS-specific unless otherwise attributed; this repository does not represent later OpenCode releases.

OpenCode and TurenOS are distributed under the MIT License. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for attribution.
