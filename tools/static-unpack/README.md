# Static Unpack WASM

Two separately licensed static unpacking engines:

- Official unmodified UPX 5.2.0 compiled with Emscripten. The package includes
  complete corresponding source and is GPL-2.0-or-later.
- An MIT RetDec-derived MPRESS PE32 LZMAT/LZMA reconstructor for static
  analysis. It restores decompressed section bytes and OEP but does not rebuild
  imports and therefore reports `runnable: false`.

Both engines process bytes in isolated workers. Analyzed executables are never
executed.
