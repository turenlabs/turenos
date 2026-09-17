# stng-core WASM

Portable, sequential string-analysis subset derived from stng 1.9.0.

The initial artifact provides bounded ASCII/UTF-8 and UTF-16LE extraction,
security-oriented classification, Base64/hex/URL decoding, custom XOR and
bounded automatic single-byte XOR. It intentionally excludes filesystem,
cache, Rizin/radare2, CLI, Rayon, jemalloc and host process integration.
