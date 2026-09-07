<p align="center">
  <img src="docs/assets/turen-logo.png" alt="TurenOS" width="128" height="128">
</p>

<h1 align="center">TurenOS</h1>

TurenOS is Turen Labs' batteries-included Desktop workbench for security engineers. It starts from the excellent [OpenCode](https://github.com/anomalyco/opencode) agent foundation and is being shaped into a focused environment for code review, application security, investigation, and remediation.

> [!IMPORTANT]
> TurenOS is under active development. Security-specific capabilities continue to evolve, so review the documented trust boundaries before using them in sensitive environments.

## Direction

TurenOS should make a useful security workflow available without spending the first hour wiring tools together:

- repository and dependency reconnaissance;
- Batou-powered code and application security analysis;
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
- a bundled native runtime used by Desktop locally and in managed WSL environments;
- cross-platform release packaging and upstream compatibility tracking.

TurenOS is not a sandbox. Agents can execute commands and modify files with your user privileges. Read [SECURITY.md](SECURITY.md) before using it on untrusted repositories.

## Documentation

Engineering documentation lives in [docs/](docs/README.md). Start with:

- [Claude Code provider](docs/claude-code.md) — using a local `claude auth login` subscription instead of an API key.
- [Architecture](docs/architecture.md) — package boundaries, runtime topology, and durable data flows.
- [Systems and subsystems](docs/systems.md) — responsibilities, ownership, and failure behavior across TurenOS.
- [Branding and compatibility](docs/branding.md) — why some `forge` identifiers remain stable.
- [Secure storage](docs/secure-storage.md) — how credentials are encrypted.
- [Memory](docs/memory.md) — durable project memory.
- [Automations](docs/automations.md) — durable in-app workflows with interval/cron schedules,
  per-step `when`/`onFailure` conditions, and local file-change/session-end event triggers.
- [Token efficiency](docs/token-efficiency.md) — measured context cost against Claude Code and Codex.

## Develop

TurenOS pins Bun 1.4.2.

```bash
bun install --frozen-lockfile
bun dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pinned-runner fallback, build commands, and checks.

## Repository map

- `packages/forge` — bundled TurenOS agent runtime, server, tools, and native sidecar build.
- `packages/core` — shared Effect services and domain logic.
- `packages/app` — web and desktop renderer.
- `packages/desktop` — TurenOS Electron host and packaging.
- `packages/ui` — shared UI system and TurenOS identity.
- `packages/sdk` and `packages/sdk-next` — client SDKs.

All TurenOS-owned workspace packages use the `@turenlabs/*` scope. Upstream provider IDs and durable migration keys remain unchanged where compatibility requires them. See [branding and compatibility](docs/branding.md) before changing a `forge` identifier.

## Hard fork provenance

TurenOS is an independently maintained hard fork of [OpenCode](https://github.com/anomalyco/opencode). The projects diverged after OpenCode commit [`3a1c6df9e24672f0761a6ced18e1315d89334baf`](https://github.com/anomalyco/opencode/commit/3a1c6df9e24672f0761a6ced18e1315d89334baf) on July 17, 2026. Changes after that fork point are TurenOS-specific unless otherwise attributed; this repository does not represent later OpenCode releases.

OpenCode and TurenOS are distributed under the MIT License. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for attribution.
