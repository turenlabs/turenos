# Monodis target

Rules for `tools/monodis`, on top of the shared rules in `tools/AGENTS.md`.

- Build `tools/monodis` with Emscripten 6.0.8 from the pinned Mono commit;
  keep the four patches in `patches/` (`0001` through `0004`) small, ordered, and re-applicable by
  `script/import-upstream.sh`.
- Keep the module offline and single-input: assembly resolution hooks
  resolve nothing, and referenced assemblies (including mscorlib) stay
  unavailable. Never silently skip method bodies; degradation must render
  as explicit warnings or markers in the output.
- Preserve the narrow `init_monodis` / `monodis_disassemble` / `free_string`
  ABI, the 32 MiB input and 4 MiB output bounds, and the `Error: ...`
  fail-closed contract.
- Ship `NOTICE` attribution plus `LICENSE-MONO` and `PATENTS-MONO`; no GPL
  build-time or C# class-library code may enter the link closure.
