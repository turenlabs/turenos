# Debug Symbols WASM

`inspect(bytes, options_json)` reads bounded object symbols, debug-section
inventory, and PDB public symbols. It optionally demangles Rust, Itanium C++,
and MSVC names. It accepts bytes only and never resolves source paths, loads a
debugger, or executes code.

Hard limits are 64 MiB input, 4,096 records, and 4 KiB per symbol/section name.
Source-path values are omitted by default.
