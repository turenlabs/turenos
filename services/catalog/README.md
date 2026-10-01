# Built-in extension catalog

`services/catalog` is the canonical source for TurenOS's built-in extension catalog: curated cybersecurity data sources, prompt-only skills and fixed-profile subagents, MCP server definitions, and packaged security tools. Everything here ships inside the monorepo — there is no remote catalog service.

The catalog holds manifests, not binaries or credentials. MCP entries are hosted endpoints or pinned install recipes (`managed` entries name the package, version, and command that the uv-managed runtime installs and runs); tool entries bind security scanners that run a host executable the user installs (Bandit, Trivy, Gitleaks, and others; Batou is downloaded on first enable) or the built-in Yolk integration. No manifest can add arbitrary HTTP endpoints, provider credentials, or permission rules.

## How it ships

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
  tools/    security scanner integrations on security:<id> adapters, plus builtin:yolk
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
