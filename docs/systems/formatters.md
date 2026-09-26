# Formatters

The legacy `packages/forge` runtime can run a project's own code formatter on each file its `edit`, `write`, and
`apply_patch` tools change. Formatting is off unless `formatter` is set in [configuration](./configuration.md), and the
Session V2 tools in `packages/core` never format files.

## How it works

1. `Format.Service` (`packages/forge/src/format/index.ts`) builds per-instance state. When `formatter` is unset or
   `false`, every formatter is disabled.
2. With `formatter: true`, every built-in formatter in `packages/forge/src/format/formatter.ts` is registered. A record
   registers them all and then removes each entry whose value is `{ "disabled": true }`. Disabling either `ruff` or `uv`
   disables both, because they share a backend.
3. After a successful write, the tool calls `format.file(path)`. The service selects registered formatters whose
   extensions match the file and asks each whether it applies to this project. For example, `prettier` runs only when a
   `package.json` between the instance directory and the worktree root lists it as a dependency and the binary
   resolves.
4. Each applicable formatter runs as a child process in the instance directory, with `$FILE` replaced by the path and
   stdin, stdout, and stderr ignored. A spawn failure or non-zero exit is logged, and the edit still succeeds.

The built-in IDs are `gofmt`, `mix`, `prettier`, `oxfmt`, `biome`, `zig`, `clang-format`, `ktlint`, `ruff`, `air`,
`uv`, `rubocop`, `standardrb`, `htmlbeautifier`, `dart`, `ocamlformat`, `terraform`, `latexindent`, `gleam`, `shfmt`,
`nixfmt`, `rustfmt`, `pint`, `ormolu`, `cljfmt`, and `dfmt`. `oxfmt` is gated by `FORGE_EXPERIMENTAL_OXFMT`, which
falls back to the umbrella `FORGE_EXPERIMENTAL` flag. That flag defaults to true
(`packages/forge/src/effect/runtime-flags.ts`), so `oxfmt` is available by default; set
`FORGE_EXPERIMENTAL_OXFMT=false` to turn it off.

`GET /formatter` on the instance API returns each registered formatter with its extensions and whether it is enabled
for the current project.

## Configuration

```json
{
  "formatter": {
    "prettier": { "disabled": true }
  }
}
```

An entry accepts only `disabled`, and only for a built-in ID. An unknown ID or any other field fails schema decoding,
and a document that fails to decode is ignored in full. Custom formatter commands are not supported.

## Verification

```sh
cd packages/forge
bun test test/format
```

## Limits

- Only the legacy runtime's file tools format. Session V2 edits are written as the model produced them.
- Formatter output and errors are discarded; a failed format leaves the unformatted file in place.
- Prettier, oxfmt, and Biome come from TurenOS's managed npm cache (`<cache>/packages/`), installed from npm on first use if missing (`Npm.which` in `packages/core/src/npm.ts`). Other formatters are found with the executable lookup in `packages/core/src/util/which.ts`: `PATH`, the managed tool bin directory, `~/.local/bin`, then `~/bin`. All run with the host user's authority.

## Source

- [`packages/forge/src/format/index.ts`](../../packages/forge/src/format/index.ts)
- [`packages/forge/src/format/formatter.ts`](../../packages/forge/src/format/formatter.ts)
- [`packages/forge/src/effect/runtime-flags.ts`](../../packages/forge/src/effect/runtime-flags.ts)
- [`packages/core/src/config/builtin-toggle.ts`](../../packages/core/src/config/builtin-toggle.ts)
- [`packages/core/src/v1/config/formatter.ts`](../../packages/core/src/v1/config/formatter.ts)
- Tests: [`packages/forge/test/format/`](../../packages/forge/test/format/)
