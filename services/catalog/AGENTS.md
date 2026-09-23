# Catalog Manifests

`manifests/` is the canonical source for TurenOS's built-in extension catalog.
It is compiled into `packages/extensions/src/generated.ts` at build time and
served through the server's `extension.list` API. There is no remote catalog
service; do not add fetch endpoints, deploy pipelines, or registry.json
artifacts back into this directory.

## Layout

- `manifests/data/` — read-only data sources on audited `security:<id>` (and
  `websearch:<id>`) adapters; each declares its fetch origins in `endpoints`,
  resolved at runtime via `ExtensionCatalog.dataEndpoint(...)`
- `manifests/skills/` — prompt-only skills and fixed-profile subagents (`skill:<id>`)
- `manifests/mcp/` — hosted, customer-url, managed-package, and local MCP
  definitions (`mcp:<id>`)
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
- Data contributions keep `tools.write` empty, name concrete tools only, and
  declare their audited fetch origins in `endpoints` — the manifest is the
  single source of truth for where data comes from; runtime adapters never
  hardcode origins.
- Skills carry bounded inline `source.content` (no secrets, commands,
  configuration, or tool policies) and meet `docs/skill-quality.md`.
- MCP contributions declare deployment, authentication, explicit tool
  allowlists, and any secrets/configuration up front. Wildcard policies are
  prohibited.
- Write tools are opt-in. List every tool that changes, runs, sends, publishes,
  cancels, or deletes anything upstream in `tools.write`, even when its name
  passes the validator's mutating-name check (`execute_*`, `publish_*`,
  `cancel_*`, and `run_*` do). Managed MCP contributions hide `tools.write`
  until the user turns on Allow write tools, and each call still asks for
  approval. A tool missing from `tools.write` is exposed read-only with no
  prompt. Any new adapter or contribution type that can write must keep the
  same opt-in default and must not grant write access from the manifest alone.
- `managed` deployments carry the full package recipe in the manifest —
  pinned `package`/`version`, `cutoff` freshness timestamp, `command`,
  `args`, `platforms`, and `environment` bindings to declared
  configuration/secrets. The generic uv-managed runner in
  `packages/forge/src/mcp/package-runtime.ts` executes them; no per-package
  runtime code is needed. Managed deployments are official-trust only.
- New adapter IDs and non-managed `local` deployments require a separately
  reviewed runtime in `packages/forge`; a manifest never grants authority by
  itself.
