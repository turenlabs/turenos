# Development

Guides for changing TurenOS code: testing patterns, fixtures, and code conventions. Build, run, lint, and release commands
live in [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and the operator procedures in [operations](../operations/README.md).

- [Security MCP integration conventions](./security-integrations.md): the contract, handlers, output, caching, and
  scanner rules for integrations in `packages/forge/src/security/`.
- [Forge test fixtures](./forge-tests.md): temporary directories, Effect test helpers, and waiting on concurrent work in
  `packages/forge` tests.
- [Desktop sidecar profiler](./desktop-profiler.md): recording a V8 CPU profile of the local sidecar in dev-channel
  Desktop builds.

The Effect patterns used in `packages/forge` are specified beside that package, in
[`packages/forge/specs/effect/`](../../packages/forge/specs/effect/): the [Effect guide](../../packages/forge/specs/effect/guide.md),
[migration patterns](../../packages/forge/specs/effect/migration.md), [typed errors](../../packages/forge/specs/effect/errors.md),
[schemas](../../packages/forge/specs/effect/schema.md), [HTTP routes](../../packages/forge/specs/effect/routes.md), and
[instance context](../../packages/forge/specs/effect/instance-context.md).
