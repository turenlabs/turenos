# Protocol inspect target

Rules for `tools/protocol-inspect`, on top of the shared rules in `tools/AGENTS.md`.

- Build `tools/protocol-inspect` with wasm-pack. Its public ABI is
  `inspect(packet_bytes, link_type, options_json) -> JSON`; the packet must be
  selected by a separate offline capture reader.
- Keep link types numeric and do not add sockets, DNS, decryption, or live
  capture APIs. Payload inspection is bounded and passive.
