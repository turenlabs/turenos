# Provenance

This repository starts from a **current-working-tree snapshot**, not an upstream release or a clean archive of the source repository's HEAD.

## Extraction boundary

At extraction on **2026-09-10**, the TurenOS source checkout had base HEAD `ac677c7341407375795a8a515db278bc2bd5495b` and package version `1.0.14`. The checkout was dirty, including an untracked `packages/tui/` tree and modified generated client files. That commit identifies the base only: `git archive` of it does **not** reproduce the extracted TUI or working-tree client changes.

| Source location within TurenOS             | Destination in this repository                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `packages/tui/src/`                        | `src/`: the 20 TUI modules listed in [architecture](../architecture/overview.md#components).  |
| `packages/tui/test/`                       | `test/`: copied TUI tests and synthetic fixtures.                                             |
| `packages/tui/script/visual-audit.py`      | `script/visual-audit.py`: adapted to standalone paths and rejects output inside the checkout. |
| `packages/client/src/generated/`           | `vendor/client/`: the four Promise-client files below.                                        |
| `packages/forge/src/cli/cmd/tui-auth.ts`   | `src/tui-auth.ts`: retained authentication logic with a local, non-Effect `CliError`.         |
| `packages/forge/test/cli/tui-auth.test.ts` | `test/tui-auth.test.ts`: authentication tests with a standalone import path.                  |

The standalone CLI, root package configuration, local vendor package manifest, CI, and these docs belong to the independent extraction. It is not the similarly named Python repository. It does not include server implementations, Desktop, the web client, or changes to an installed helper or running server.

Original TurenOS server-integration tests remain upstream. Copying client tests does not make that upstream integration coverage a standalone verification result. See [verification boundaries](../guides/development.md#verification-boundaries); no test count or full visual-matrix result is inferred from the snapshot.

## Vendored client

The copied generated Promise-client files are:

- [client.ts](../../vendor/client/client.ts)
- [client-error.ts](../../vendor/client/client-error.ts)
- [index.ts](../../vendor/client/index.ts)
- [types.ts](../../vendor/client/types.ts)

The only permitted deviation from the four copied generated files is removal of the unused **global** `events.subscribe` surface:

1. Remove the `events.subscribe` method and its now-empty `events` group in `client.ts`.
2. Remove `EventsSubscribeOutput` from that file's type import.
3. Remove the `EventsSubscribeOutput = ForgeEventEncoded` alias in `types.ts`.
4. Remove the now-unused `ForgeEventEncoded` type import from `@turenlabs/protocol/groups/event`.

The TUI uses its own global event-stream transport and polls for reconciliation rather than calling that generated global subscription. Keeping its type dependency would pull the monorepo Protocol/Effect Schema dependency chain into the standalone package. All other generated SDK types and methods are retained unmodified, including session-scoped event methods; this is not an endpoint-by-endpoint rewrite or removal of all SSE support. `index.ts` and `client-error.ts` require no patch.

[vendor/client/package.json](../../vendor/client/package.json) is a new local package manifest, not a fifth generated client file. The root dependency is `"@turenlabs/client": "file:./vendor/client"`; there are no monorepo workspace dependencies. Legacy provider and session PATCH adapters remain in the TUI source, as described under [remote compatibility](../architecture/overview.md#remote-compatibility).

When syncing, identify the source base **and** any working-tree delta, copy from the actual intended snapshot, compare all four generated files, and keep the patch limited to the four removals above. Record any new deviation explicitly rather than presenting it as an unchanged upstream client. Do not use the base commit alone as proof of byte-for-byte reproducibility.

## Client sync on 2026-09-14

The standalone package and vendored client are version `1.0.19`. The four generated files were copied from the local TurenOS health-fix worktree based on `f03aed1239cc95b477aca7c3cf14c6a452a07c0a`, after regenerating the client with the restored `/api/activity` endpoint. This includes an uncommitted server/protocol activity-route change; the base commit alone does not reproduce this client snapshot. The four removals described above remain the only deviations from that generated snapshot.

## Client sync on 2026-09-28

The standalone package and vendored client are version `1.0.32`. The four generated files were copied from TurenOS `origin/main` at `59fdb011` (`chore: release 1.0.32`) and were byte-identical to that commit's `packages/client/src/generated/`. The four removals described above remain the only deviations. The upstream changes since the previous sync:

- **`activity.list` removed.** `activity.list` (`GET /api/activity`) is gone from the client and the server. The terminal inventory now reads the location-scoped `ptys.list` (`GET /api/pty`).
- **New task fields.** Task records gained a `queued` status and an optional `wave`. The client accepts `queued` and counts it as active.
- **New message sources.** `subagent_settle`, `subagent_advisory`, and `swarm_room` were already in the previous snapshot's types, but the response validator rejected them. It now accepts them, and they are labelled by origin rather than as user messages.

## Attribution

The upstream TurenOS `NOTICE` credits:

> TurenOS
> Copyright (c) 2026 Turen Labs
>
> TurenOS is an independently maintained hard fork of OpenCode.
> Copyright (c) 2025 opencode contributors.

It identifies the OpenCode fork point as [`3a1c6df9e24672f0761a6ced18e1315d89334baf`](https://github.com/anomalyco/opencode/commit/3a1c6df9e24672f0761a6ced18e1315d89334baf) and states:

> OpenCode is licensed under the MIT License. The complete license text is in
> LICENSE. TurenOS modifications are distributed under the same license unless a
> file states otherwise.

Preserve this repository's [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE) when redistributing the extracted source. The upstream notice also covers components outside this extraction, such as the web UI's Thinking Orbs-derived component; it is not a statement that those components are bundled here.

OpenTUI and other package-managed dependencies retain their own licenses and notices. Preserve applicable native-library license, author, and patent notices when redistributing dependencies or any future binaries. This repository currently provides no standalone compiled binary build.
