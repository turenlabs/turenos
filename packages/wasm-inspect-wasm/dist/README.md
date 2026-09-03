# Wasm Inspector

This package statically validates and summarizes WebAssembly core modules and
components. It accepts bytes only and never instantiates, interprets, or calls
the inspected module.

The input limit is 16 MiB. Section reports are capped at 4,096 entries and the
JSON result is capped at 4 MiB with an explicit truncation flag.
