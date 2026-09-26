# @turenlabs/plugin

Public plugin APIs for TurenOS plugins (`.`, `./tool`, and the `./v2/*` entry points), the `./potion` embedding loader
that Core's optional semantic memory uses, and experimental plugins that TurenOS does not register by default.

## Experiments

- [Zero-Mem prototype](../../docs/experimental/zero-mem.md): `./zero-mem` and the `./zero-mem-plugin` adapter.
- [Recursive context plugin](../../docs/experimental/recursive-context.md): `./rlm-plugin`, an opt-in context
  externalizer.
- [Embedding model benchmark](../../docs/experimental/embedding-models.md): `script/bench-embedding-models.py`, which
  compares `./potion` with other small embedding models. The shipped use of `./potion` is described in
  [Memory](../../docs/systems/memory.md).

## Verification

From this directory:

```sh
bun typecheck
bun test
bun run build
```

The focused Core memory regression suite can be run separately:

```sh
cd ../core
bun test test/memory.test.ts
```
