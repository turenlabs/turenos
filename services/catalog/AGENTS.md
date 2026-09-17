# Catalog Manifests

`manifests/` is the canonical source for TurenOS's built-in extension catalog.
It is compiled into `packages/extensions/src/generated.ts` at build time and
served through the server's `extension.list` API. There is no remote catalog
service; do not add fetch endpoints, deploy pipelines, or registry.json
artifacts back into this directory.

## Layout

- `manifests/data/` — read-only data sources on audited `security:<id>` adapters
- `manifests/skills/` — prompt-only skills and fixed-profile subagents (`skill:<id>`)
- `manifests/mcp/` — hosted, customer-url, and local MCP definitions (`mcp:<id>`)
- `manifests/tools/` — packaged WASM tool entries
- `docs/` — feed license notes and the skill quality rubric

## Workflow

1. Edit or add a manifest under `manifests/<type>/`.
2. Run `bun run generate` from `packages/extensions` and commit the regenerated
   `src/generated.ts`. CI runs `bun run check` and fails on stale output.
3. Editing a skill manifest changes its install digest: update
   `reviewedSkillDigests` in `packages/forge/src/skill/vigil.ts` by hashing
   `JSON.stringify(manifest)` of each catalog-sourced skill in
   `ExtensionCatalog.manifests`, or Vigil treats the skill as unreviewed.

## Invariants

`generate` validates every manifest against `Extension.Manifest` and
`packages/extensions/src/validate.ts` policy. Keep these properties true:

- Manifest IDs are stable `publisher/name` strings; contribution adapters are
  globally unique.
- Data contributions keep `tools.write` empty and name concrete tools only.
- Skills carry bounded inline `source.content` (no secrets, commands,
  configuration, or tool policies) and meet `docs/skill-quality.md`.
- MCP contributions declare deployment, authentication, explicit tool
  allowlists, and any secrets/configuration up front. Wildcard policies are
  prohibited.
- New adapter IDs require a separately reviewed runtime in `packages/forge`;
  a manifest never grants authority by itself.
