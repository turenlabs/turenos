# Static unpack target

Rules for `tools/static-unpack`, on top of the shared rules in `tools/AGENTS.md`.

- Build official unmodified UPX 5.2.0 at commit
  `034b6d0d81c53998c07ad6f34bfead6f5c5445ce` as a separate Emscripten
  program. It is GPL-2.0-or-later and every distributed package must contain
  `upx-5.2.0-source.tar.gz`; Forge's license audit enforces this.
- Keep MPRESS code separate and derived from MIT RetDec 5.0 commit
  `53e55b4b26e9b843787f0e06d867441e32b1604e`.
- MPRESS output is analysis-grade: it restores decompressed PE32 section data
  and OEP but does not rebuild imports. Preserve `runnable: false` and
  `importsRebuilt: false` until differential tests prove otherwise.
- Never execute analyzed binaries. Standard UPX processing runs the trusted
  UPX program against input bytes in an isolated MEMFS worker.
