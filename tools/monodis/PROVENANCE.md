# Source Provenance

Upstream: `https://github.com/mono/mono` at commit
`0f53e9e151d92944cacab3e24ac359410c606df6` (main, 2026-09-08).

`script/import-upstream.sh` sparse-checkouts only the compiled subset into
the gitignored `upstream/` directory:

- `mono/dis` (6 C files: `main.c`, `get.c`, `dump.c`, `dis-cil.c`,
  `util.c`, `declsec.c`) — the monodis tool itself.
- `mono/metadata` (132 C files), `mono/utils` (111 C files),
  `mono/eglib` (38 C files, unix subset), `mono/sgen` (25 C files),
  `mono/zlib` (11 C files) — the link closure from `mono/dis/Makefile.am`,
  minus LLVM flags and the Boehm-GC alternative.

What is deliberately excluded:

- Real glib: `mono/eglib` replaces it. No glib headers or libraries.
- Autoconf: `wasm/config.h` is a hand-written Emscripten config.
- LLVM link flags, BFD, MSVC-only paths, win32/aix eglib variants.
- GPL build-time code (`mcs/jay`, gettext m4, benchmarks) and GPL
  C# class libraries (`mcs/class/...SharpZipLib`): not in the native
  link closure. A file-level header scan of the compiled subset is
  required at import time to confirm this for the pinned commit.

## Spike status

The Emscripten spike is complete: the full subset links under EMSDK 6.0.8
(`dist/monodis.wasm`, ~1.7 MiB) and disassembles CIL images offline through
the `init_monodis` / `monodis_disassemble` / `free_string` ABI. Verified
facts, reproduced against the pinned commit:

1. Runtime boot is the `mono/dis/main.c` single-file init
   (`mono_counters_init`, `mono_tls_init_runtime_keys`,
   `mono_w32handle_init`, `mono_thread_info_runtime_init`) plus assembly
   load/search/preload hooks that resolve nothing, then
   `mono_init_metadata_only` (patch 0002): no JIT, no threads, no network.
2. Input arrives as staged MEMFS bytes; `FILE *output` is captured with
   `open_memstream` and truncated at 4 MiB with a marker.
3. Malformed input fails closed: empty/truncated/random/foreign bytes return
   `Error: ...` with exit 0. A 24-step truncation sweep of a valid image and
   a 17-case options matrix (table dumps, unknown tables, invalid JSON, flag
   combinations) all exit 0 with no aborts.
4. `test/verify.mjs` runs the real module (`npm test`).

## Turen patches

Applied by `script/import-upstream.sh` to the pinned commit, in order:

- `0001-expose-disassemble-file.patch`: de-static `disassemble_file` so the
  wrapper drives disassembly without the CLI entry point.
- `0002-metadata-only-init.patch`: metadata-only runtime init for WASM.
- `0003-offline-generic-fallback.patch`: continue without referenced
  assemblies instead of aborting; heap-allocate `MonoError` type-load names
  (stack literals crash `mono_error_cleanup` under Emscripten).
- `0004-decode-warning.patch`: emit a `// WARNING: method body not decoded`
  comment instead of silently skipping bodies whose locals reference
  unavailable assemblies.

## Offline fidelity notes

Only the supplied bytes are read; referenced assemblies (including mscorlib)
are unavailable by design. Compared against native `monodis` on five CIL
fixtures (hello, methods, generics, arrays, complex nested/generic/event):

- Typeref rendering differs cosmetically (`[mscorlib]System.Object::.ctor()`
  without the `class` prefix, unquoted `.ctor`).
- Unresolvable references render as explicit `<BROKEN CLASS ...>` /
  `Could not decode ...` markers, and skipped method bodies carry the 0004
  warning with the resolution reason. No code is dropped silently.
- Method bodies whose locals need unavailable assemblies (arrays of any
  element type, framework-typed locals) are not decoded. Bundling a
  reference mscorlib is a possible follow-up; it is out of scope for the
  offline single-input boundary.

## Build pinning

- Emscripten 6.0.8 in `Makefile.wasm` and the GitHub Actions workflow,
  matching `tools/ghidra-decompiler`.
- Every generated package records the toolchain version and a SHA-256
  manifest. Forge consumes the generated workspace artifact.
