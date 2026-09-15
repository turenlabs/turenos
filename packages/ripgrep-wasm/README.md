# @turenlabs/ripgrep-wasm

Vendored WebAssembly build of the ripgrep engine used by `@turenlabs/core`'s
`Ripgrep.Service` as a drop-in replacement for spawning the `rg` binary.

The module is not a reimplementation: it compiles the actual libripgrep crates
(`ignore`, `grep-regex`, `grep-searcher`, `grep-matcher`, `globset`) to
`wasm32-unknown-unknown`. Search semantics (gitignore precedence, `.ignore` /
`.rgignore`, overrides, binary detection, submatch spans, offsets) are the
binary's own algorithms.

The crate source and the oracle/fuzz harness (scripted fake filesystems for
cycle/depth/hostile-host cases, parallel benchmarks vs `rg`) live in
`workbench/ripgrep-wasm/`. This package vendors the built artifact so JS builds
don't need a Rust toolchain.

## Rebuild

```bash
bun run --cwd packages/ripgrep-wasm build
```

or directly:

```bash
cd workbench/ripgrep-wasm/crate
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/rgwasm.wasm ../../packages/ripgrep-wasm/dist/
```

Requires the `wasm32-unknown-unknown` rustup target.

## Host ABI

The module is runtime-agnostic (Bun/Node/Electron). Filesystem access goes
through `host.*` imports implemented by
`packages/core/src/ripgrep/wasm/host.ts`: batched `fs_readdir`, batched
`fs_read_files`, fd streaming fallback (`fs_open`/`fs_read`/`fs_close`),
`fs_stat_kind`/`fs_devino` for `--follow` resolution and loop detection, and
`fs_cancelled` polled at traversal/batch boundaries (driven by a
`SharedArrayBuffer` flag in worker mode).

Exports: `grep`, `grep_many`, `collect`, `collect_shards`, `filter_paths`,
`line_count`, plus `alloc`/`dealloc` and result accessors
(`result_ptr`/`result_len`/`result_flags`, `err_ptr`/`err_len`).
Return codes: 0 ok, 1 missing root, 2 bad pattern (message in the error
buffer), 3 cancelled. `result_flags` bit0 marks partial results (rg exit-2
equivalent).

See `workbench/ripgrep-wasm/README.md` for the architecture and benchmark data.
