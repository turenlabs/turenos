# Ghidra Decompiler WebAssembly

This target builds Ghidra's standalone C++ decompiler as a Node-compatible
WebAssembly module. The memory-backed bridge accepts binary bytes and selected
processor specifications without launching Ghidra, Java, or the analyzed
program.

## Build

Install Emscripten 6.0.8, then run from this directory:

```sh
npm run build
npm test
npm run pack:forge
```

The Forge-ready workspace package is written to
`artifact/ghidra-decompiler-wasm`.

The build excludes the BFD-dependent source path with `GHIDRA_NO_BFD`, embeds
processor `.sla`, `.pspec`, and `.cspec` data, records the Emscripten version,
and emits a SHA-256 manifest. See `PROVENANCE.md` for source history and the
planned direct official-Ghidra refresh.

`wasm_examples/` contains a browser example. Forge uses the tested worker API
instead of the example page.
