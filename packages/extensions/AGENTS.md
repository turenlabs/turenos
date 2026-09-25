# Extensions Package

`@turenlabs/extensions` is the compiled extension catalog consumed by the
TurenOS server. Manifest source lives in `services/catalog/manifests/` — edit
there, not here.

- `src/generated.ts` is produced by `script/generate.ts`; never edit it.
  Regenerate with `bun run generate` and verify freshness with `bun run check`
  (CI enforces both).
- `src/validate.ts` holds the catalog policy (adapter uniqueness, write-tool
  rules, executable declarations, secret assignment). Keep new rules there so
  generation fails fast.
- `src/catalog.ts` builds the lookup maps (`get`, `byAdapter`,
  `writeToolActions`) over the generated manifests.
