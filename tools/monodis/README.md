# monodis WebAssembly

This target packages Mono's `monodis` CIL disassembler (`mono/dis/`) as a
Node-compatible WebAssembly module behind a narrow memory-backed ABI. The
analyzed assembly is input data and is never executed.

Status: **spike complete.** The full Mono subset (`eglib + utils + metadata
+ sgen + zlib + culture`) links under Emscripten 6.0.8 and disassembles CIL
images offline. Only the supplied bytes are read: corlib/assembly
resolution hooks resolve nothing, and referenced assemblies are unavailable
by design. See `PROVENANCE.md` for the verified fidelity notes.

## Layout

```text
tools/monodis/
  Makefile.wasm            Emscripten build (pinned EMSDK 6.0.8)
  wasm/wasm_wrapper.c      Narrow C ABI: init / disassemble / free_string
  wasm/config.h            Hand-written Emscripten config (replaces autoconf)
  patches/                 Turen-maintained upstream patches (see PROVENANCE.md)
  script/import-upstream.sh  Sparse-checkout of the pinned Mono subset
  script/pack-forge.mjs    Forge workspace artifact packer
  test/verify.mjs          WASM smoke test (runs the real module)
  upstream/                Pinned Mono sources (gitignored, imported)
```

## Build

Install Emscripten 6.0.8, import the pinned upstream subset, then run from
this directory:

```sh
./script/import-upstream.sh
npm run build
npm test
npm run pack:forge
```

The Forge-ready workspace package is written to `artifact/monodis-wasm`.

## ABI

The module exports a Ghidra-style narrow ABI (no CLI, no paths, no threads):

```c
void  _init_monodis(void);
char *_monodis_disassemble(const uint8_t *bytes, int len, const char *options_json);
void  _free_string(char *pointer);
```

- Input is bounded to 32 MiB; output text is truncated at 4 MiB with a
  marker. Failures return a short `Error: ...` string, never a throw.
- `options_json` selects one table dump (`--typedef`, `--method`, ...) or the
  default round-trippable IL disassembly. Unknown options fail closed.
- No filesystem or network access. Corlib/assembly resolution hooks resolve
  nothing (refonly); only the supplied bytes are read.

## License

Mono's runtime and `mono/dis/` are MIT-licensed; see `NOTICE` for attribution
and the Microsoft Patent Promise for Mono, which must ship with the artifact.
No GPL build-time or C# class-library code is linked into this module.
