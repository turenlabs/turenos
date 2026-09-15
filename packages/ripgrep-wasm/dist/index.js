// Resolve the .wasm artifact relative to this module: the package exists so
// import.meta.resolve("@turenlabs/ripgrep-wasm") lands here and callers take
// dirname + "rgwasm.wasm". Keep the specifier bare (no dot-slash prefix): the
// desktop packager scans bundled output for relative wasm literals and expects
// those inside app.asar, while this artifact ships unpacked as a resource.
export const wasmPath = new URL("rgwasm.wasm", import.meta.url)
