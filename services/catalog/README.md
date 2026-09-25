# Turen Catalog

`services/catalog` is the canonical source for TurenOS's built-in extension catalog: curated cybersecurity data sources, prompt-only skills and fixed-profile subagents, MCP server definitions, and packaged security tools. Everything here ships inside the monorepo — there is no remote catalog service.

The catalog does not distribute MCP servers, executable security tools, provider credentials, arbitrary HTTP endpoints, commands, or permission rules.

## How It Ships

Manifests under `manifests/` are compiled into `packages/extensions/src/generated.ts` at build time:

```sh
cd packages/extensions
bun run generate   # regenerate src/generated.ts
bun run check      # verify generated.ts is current (CI runs this)
bun test           # catalog policy and validation tests
```

`generate` validates every manifest against `Extension.Manifest` and the catalog policy rules in `packages/extensions/src/validate.ts`, then fails on duplicate IDs or adapters. The generated catalog is served by the TurenOS server through `extension.list`; the app consumes only that API.

## Layout

```text
manifests/
  data/     read-only cybersecurity data sources (security:<id> adapters)
  skills/   prompt-only skills and fixed-profile subagents (skill:<id>)
  mcp/      hosted, customer-URL, managed-package, and local MCP definitions (mcp:<id>)
  tools/    packaged WASM security tools (tool adapters)
```

## Documentation

- [Developer catalog runtime](../../docs/systems/developer-catalog-runtime/README.md): how the catalog is validated,
  projected, installed, and updated at runtime.
- [Authoring catalog entries](../../docs/systems/developer-catalog-runtime/authoring.md): the selection policy, manifest
  contract, MCP deployment variants, and how to add a source, skill, subagent, or managed MCP package.
- [Catalog contents](../../docs/systems/developer-catalog-runtime/catalog-contents.md): the data sources, skills, and
  subagents the catalog ships today.
- [Skill quality benchmark](../../docs/systems/developer-catalog-runtime/skill-quality.md) and
  [threat intelligence feed rights](../../docs/systems/developer-catalog-runtime/feed-licenses.md).
