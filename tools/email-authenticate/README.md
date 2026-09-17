# Offline Email Authentication

This package provides bounded DKIM, SPF, and DMARC verification for Turen
agents. It accepts RFC 5322 bytes, explicit SMTP envelope values, and a
versioned DNS snapshot. It never performs DNS, network, filesystem, or message
delivery operations.

The vendored `mail-auth` 0.12.1 source is built with a Turen `dns-offline`
feature. All resolver lookups consult only the supplied snapshot. A missing
record is `offline_snapshot_miss`, not NXDOMAIN and not a successful result.

Hard limits include 16 MiB message input, 24 MiB request JSON, 4,096 DNS
entries, 256 KiB total TXT data, 32 DKIM signatures, 128 DNS queries, the SPF
10-lookup limit, and 512 KiB result JSON.

The result separates `complete`, DKIM, SPF, and DMARC status from advertised
`Authentication-Results` headers. A cryptographically valid signature does not
establish brand identity or trust without an explicit policy and trust model.

Build and test offline after the vendor tree is present:

```sh
cargo test --locked --manifest-path tools/email-authenticate/Cargo.toml --lib
cargo check --locked --manifest-path tools/email-authenticate/Cargo.toml --target wasm32-unknown-unknown
wasm-pack build tools/email-authenticate --target web --release --out-dir pkg
node tools/email-authenticate/test/verify.mjs tools/email-authenticate/pkg
```
