# JWT Audit Constraints

Keep this target offline and verification-only. Never sign tokens, accept
private keys, discover keys from token headers, or fetch JWKS URLs.
Use the original compact signing bytes, not reserialized JSON.
Keep caller algorithm pinning separate from untrusted `alg` metadata.
Keep signature validity separate from required issuer, audience, and time
checks. Never describe verification as authorization or key ownership.

Build with Rust 1.97.1 and wasm-pack 0.15.0. Do not enable RustCrypto `std`
features that introduce `getrandom`. Run the actual packaged WASM tests
against Node crypto and preserve dependency licenses in the package.
