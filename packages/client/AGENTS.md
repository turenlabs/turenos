# Client

`@turenlabs/client` holds two things:
- the generated Promise and Effect clients;
- the rule modules the desktop app and the terminal client (`packages/tui`) share.

Each rule module is its own export: `@turenlabs/client/team`, `models`, `context`, `paths`, `path-key`, `working-folders`, `automation-schedule` and `unsafe-text`. `session-title`, `turn-interruption` and `provider-url` are re-exported from Schema.

## Conventions

- Rule modules import nothing from `effect`, Protocol, Core or Server, because the terminal client depends on none of them. `test/import-boundaries.test.ts` bundles each export and fails on such an import.
- When a second client needs a rule, move it here and have both import it. Don't copy it.
- Run this package's tests from `packages/client` with `bun run test`.
