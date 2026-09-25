# Authoring catalog entries

How to add a data source, skill, subagent, or managed MCP package to the built-in catalog in `services/catalog/manifests/`,
and the rules every manifest must meet. Regenerate and check the catalog with the commands in
[`services/catalog/README.md`](../../../services/catalog/README.md).

## Selection policy

A source belongs in this catalog only when all of the following are true:

- It provides cybersecurity data or structured defensive knowledge.
- Access is free without a paid-only dependency. Optional free API keys are acceptable.
- Commercial/product use is permitted by the source's current terms.
- The source has an official HTTPS API, documented feed, or versioned artifact.
- Turen uses a fixed audited origin and path; manifests cannot introduce arbitrary request URLs.
- Queries and responses can be bounded, cached, attributed, and exposed read-only.
- The source is not used to fetch malware, contact listed infrastructure, or execute catalog content.

Free tiers restricted to personal, internal, nonprofit, or noncommercial use are excluded. That currently excludes sources such as VirusTotal Public API, Shodan InternetDB, GreyNoise Community, AlienVault OTX, OpenPhish Community, Cloudflare Radar, and the authenticated abuse.ch URLhaus/ThreatFox/MalwareBazaar APIs.

## Manifest contract

Each manifest is one JSON file holding a single extension whose contributions share one type.

```json
{
  "schemaVersion": 1,
  "id": "turenlabs/example",
  "name": "Example Source",
  "description": "Query a reviewed cybersecurity dataset",
  "version": "1.0.0",
  "publisher": "Turen Labs",
  "trust": "official",
  "homepage": "https://example.com/docs",
  "contributions": [
    {
      "type": "data",
      "id": "example",
      "name": "Example Source",
      "description": "Query a reviewed cybersecurity dataset",
      "instructions": "Preserve attribution and corroborate results before action.",
      "adapter": "security:example",
      "secrets": [],
      "endpoints": { "api": "https://api.example.com/v1" },
      "defaultEnabled": false,
      "tools": {
        "allow": ["example_lookup"],
        "write": []
      }
    }
  ]
}
```

`Extension.Manifest` in `packages/schema/src/extension.ts` defines the accepted fields. Decoding drops any field it
doesn't define, so `group` is honored only on `tool` contributions, and a manifest-level `versions` array is not part of
the contract.

Enforced when the catalog is generated (`packages/extensions/src/validate.ts`, `packages/extensions/script/generate.ts`,
and the schema):

- IDs use the lowercase `publisher/name` form, and only the `turenlabs/` namespace may declare `official` trust.
- A manifest with more than one contribution may hold only generic MCP contributions, so every other manifest has one
  `data`, `skill`, `mcp`, or `tool` contribution.
- Extension IDs and adapter IDs are unique across the catalog.
- Data contributions declare at least one audited origin in `endpoints`: lowercase names mapped to credential-free
  HTTPS URLs on public hosts. The adapter resolves them through `ExtensionCatalog.dataEndpoint(...)`, so fetch origins
  are not hardcoded in runtime code.
- `tools.write` is empty for data contributions. For every type, write tools must also appear in `tools.allow`, and an
  allowed tool whose name looks mutating (`create`, `delete`, `update`, `write`, and similar) must be declared in
  `tools.write`.
- Skills use a `skill:<id>` adapter and declare no secrets. Non-official skills must embed `catalog` prompt content.
- Subagents select a `read`, `data`, or `binary` profile and at most 50 steps.
- A secret ID is declared by only one extension. Secrets are stored in the TurenOS secret vault, never in catalog state.

Review conventions that no validator checks:

- IDs stay stable once published.
- Adapters match an audited TurenOS runtime adapter. For `security:` tool and data adapters, the registry in
  `packages/forge/src/security/registry.ts` does fail at load when the manifest is missing or its `commands` or
  `tools.allow` don't match the adapter.
- Tool names are concrete; don't use wildcard tool policies.
- Homepages use credential-free HTTPS URLs.
- Every skill meets the review rubric in the [skill quality benchmark](./skill-quality.md).

## MCP deployment variants

`services/catalog/manifests/mcp/` deployment variants:

- `hosted` — a fixed vendor HTTPS endpoint; TurenOS connects remotely.
- `customer-url` — the user supplies their instance base URL; the manifest pins the path suffix.
- `managed` — a pinned local package (`package`, `version`, `cutoff`, `command`, `args`, `platforms`, `environment`) run by the audited uv-managed runtime in `packages/forge/src/mcp/package-runtime.ts`. The manifest is the single source of truth for what executes; official trust only.
- `local` — an executable the user already installed (for example the 1Password desktop app's bundled `1password-mcp`); TurenOS discovers it, never downloads it.

`services/catalog/manifests/tools/` entries bind security scanners to their audited `security:<id>` adapters in `packages/forge/src/security`. A tool manifest's `commands` must match the adapter's `executables`, and its `tools.allow` must match the adapter's tool names; the registry refuses to load otherwise (see [Security MCP integration conventions](../../development/security-integrations.md)). The user installs the scanner executables; only Batou is downloaded by TurenOS.

## Adding a source

1. Verify the official endpoint, current free limits, commercial-use rights, attribution, and update cadence.
2. Add an audited read-only Turen adapter with fixed endpoint policy, strict input validation, response limits, caching, and compact output.
3. Add the manifest under `services/catalog/manifests/data`.
4. Add or update adapter and catalog tests.
5. Run `bun run generate` in `packages/extensions` and commit `packages/extensions/src/generated.ts`.

Catalog metadata is not runtime authority. A data manifest may select only a separately reviewed `security:<id>` or `websearch:<id>` adapter; it cannot grant network, process, filesystem, or credential privileges on its own.

## Adding a skill or subagent

1. Author original, bounded defensive instructions and a stable contribution ID.
2. Use a `catalog` source and keep secrets, commands, configuration, and tool policies empty.
3. Add `agent.profile` only for a subagent; choose `read`, `data`, or `binary`.
4. List non-authoritative tool requirements so the UI can disclose expected capabilities.
5. Review the entry against the [skill quality benchmark](./skill-quality.md), then run `bun run generate` in `packages/extensions`.
6. Installs are scanned by Vigil; reviewed manifests are allowlisted by digest in `packages/forge/src/skill/vigil.ts`.

## Adding a managed MCP package

1. Vendor audit the package and record the exact `version` pin and a `cutoff` timestamp that bounds its transitive dependencies.
2. Declare the `managed` deployment with `command`, `args`, `platforms`, and `environment` bindings that reference declared `configuration` fields or `secrets` only.
3. Keep the tool allowlist explicit and read-only where the package supports it (for example `--read-only`).
4. Run `bun run generate` in `packages/extensions`; `validate.ts` enforces official trust, exact pins, safe declarations, and reference integrity.
