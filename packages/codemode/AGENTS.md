# `@turenlabs/codemode`

- This local package owns confined execution over explicit schema-described tools. Applications own authorization, persistence, external authority, and tool-specific delivery semantics.
- Do not add a speculative generic permission or approval policy. A host omits tools it does not expose and enforces domain authorization inside each provided tool.
- Keep Code Mode unaware of host session, channel, and conversation models. The hosting application supplies trusted execution scope around it.
- Tool schemas are the model-facing Interface. Keep arguments minimal and natural to the operation; never add unrelated IDs as ambient capability tokens.
- Keep the public/private error split: `ToolError` carries a safe model-visible message plus a private cause, and unknown host failures stay sanitized.
- Never add ambient host capabilities (`fetch`, `crypto`, filesystem handles, modules, network clients). Any such capability is opt-in by the host and unavailable by default.
- Values crossing the sandbox boundary stay JSON-like; binary values need explicit tagged shapes and size limits first.

## OpenAPI

- Generate an operation only when its transport semantics are supported; otherwise return a precise `skipped` reason.
- Never guess parameter serialization or malformed security semantics. Unsupported serialization is skipped and malformed security fails closed.
- Render unresolved schema constructs as `unknown`, never as invented TypeScript names.
- Keep network reads bounded and map expected encoding, transport, and decoding failures to model-safe `ToolError` values.
- Test supported behavior directly; do not reproduce adapter algorithms in tests.
