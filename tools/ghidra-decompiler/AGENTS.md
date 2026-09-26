# Ghidra decompiler target

Rules for `tools/ghidra-decompiler`, on top of the shared rules in `tools/AGENTS.md`.

- Build from `tools/ghidra-decompiler` with Emscripten 6.0.8.
- Keep BFD-dependent code excluded. Do not introduce the GPL BFD path into the
  distributed module.
- The analyzed program is input data and must never be executed.
- Preserve the memory-backed wrapper ABI and processor asset layout expected
  by Forge unless the Forge consumer is migrated in the same change.
- Verify decompilation through the packaged module and regenerate its checksum
  manifest before distribution.

```sh
cd tools/ghidra-decompiler
npm run build
npm test
npm run pack:forge
```
