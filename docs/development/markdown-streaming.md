# Streaming Markdown link repair

Session UI uses a Rust WebAssembly module to repair incomplete links and images in streaming Markdown. The renderer loads the packaged module when it first sees bracket markup. It uses the JavaScript repair path while the module loads, after a load failure, or when the UTF-8 input exceeds the 256 KiB module buffer. Marked parses the resulting Markdown and DOMPurify sanitizes its HTML.

The Rust module returns UTF-16 offsets so the renderer can edit the original JavaScript string. The test suite compares the checked-in binary with Remend's text-only repair on partial links, images, code and Unicode text.

## Rebuild and verify

From `packages/session-ui`, run the following commands when changing the Rust source. Commit the generated `src/components/markdown-links.wasm` alongside the source change. Regular app builds use the checked-in module.

```sh
rustup toolchain install 1.97.1 --target wasm32-unknown-unknown
bun run build:markdown-links
bun test src/components/markdown-link-repair.test.ts src/components/markdown-stream.test.ts
```

## Source

- [Renderer repair and fallback](../../packages/session-ui/src/components/markdown-link-repair.ts)
- [Rust link repair](../../packages/session-ui/rust/markdown-links.rs)
- [Differential tests](../../packages/session-ui/src/components/markdown-link-repair.test.ts)
