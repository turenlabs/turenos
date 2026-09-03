# Goblin WASM

Bounded WebAssembly wrapper around Goblin 0.10.6 for PE, ELF, Mach-O, TE,
COFF, and Unix archive inspection.

The wrapper accepts bytes and returns versioned JSON. It does not read paths,
extract archive members, execute code, or expose Goblin's writing APIs.

The trusted self-hosted workflow builds from commit
`cec6e6eba5bdcec78ec79edc80b3a1f44856039a`, runs the real WASM compatibility
test, records provenance and checksums, and emits `@turenlabs/goblin-wasm`.
