# Source Provenance

The initial WebAssembly compatibility baseline was imported with full history
from `mauricelam/ghidra-decompiler` at commit
`894191f76199a14bf3d34f31e68a2f0c697f8bdd`.

That repository extracted Ghidra's standalone C++ decompiler and processor
definitions and added the memory-backed WebAssembly bridge in `wasm_wrapper.cc`.
The original Ghidra source and processor definitions are distributed under
Apache-2.0. The BFD-dependent source files are not linked into the WebAssembly
module; the build defines `GHIDRA_NO_BFD`.

The build is pinned to Emscripten 6.0.8 in `Makefile.wasm` and the GitHub
Actions workflow. Every generated package contains the toolchain version and a
SHA-256 manifest. Forge consumes the generated workspace artifact rather than
the upstream npm package.

The next upstream refresh will regenerate the source and selected processor
definitions directly from a pinned official NSA Ghidra release.
