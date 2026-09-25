# Goblin target

Rules for `tools/goblin`, on top of the shared rules in `tools/AGENTS.md`.

- Build Goblin 0.10.6 at commit
  `cec6e6eba5bdcec78ec79edc80b3a1f44856039a`.
- Preserve collection and serialized-output limits in the Rust wrapper.
- Keep parsing byte-only and read-only. Do not expose archive extraction or
  Goblin writing APIs.
