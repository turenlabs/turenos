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
      "group": "threat-intelligence",
      "tools": {
        "allow": ["example_lookup"],
        "write": []
      }
    }
  ],
  "versions": [
    {
      "version": "1.0.0",
      "published": "2026-08-25"
    }
  ]
}
```

Required invariants:

- IDs are stable and use the `publisher/name` form.
- Each manifest's contributions share one type: `data`, `skill`, `mcp`, or `tool`.
- Adapter IDs are globally unique and must match an audited Turen runtime adapter.
- Data contributions declare their audited origins in `endpoints` (named credential-free HTTPS URLs on public hosts). The adapter resolves them through `ExtensionCatalog.dataEndpoint(...)` — fetch origins are never hardcoded in runtime code.
- Tool names are concrete; wildcard tool policies are prohibited.
- `tools.write` must remain empty for Data sources.
- Skill sources contain bounded prompt text only. They cannot declare secrets, commands, configuration, or tool authority.
- Subagents may select only a host-defined read-only profile and a bounded turn allowance.
- Secrets are declared explicitly and stored by Turen's secret vault, never in catalog state.
- Homepages must use credential-free HTTPS URLs.
- Version history is append-only and includes a publication date for the current version.
- Every skill must meet the review rubric in the [skill quality benchmark](./skill-quality.md).

## MCP deployment variants

`services/catalog/manifests/mcp/` deployment variants:

- `hosted` — a fixed vendor HTTPS endpoint; TurenOS connects remotely.
- `customer-url` — the user supplies their instance base URL; the manifest pins the path suffix.
- `managed` — a pinned local package (`package`, `version`, `cutoff`, `command`, `args`, `platforms`, `environment`) run by the audited uv-managed runtime in `packages/forge/src/mcp/package-runtime.ts`. The manifest is the single source of truth for what executes; official trust only.
- `local` — an executable the user already installed (for example the 1Password desktop app's bundled `1password-mcp`); TurenOS discovers it, never downloads it.

`services/catalog/manifests/tools/` entries bind packaged WASM/binary security tools to their audited `security:<id>` adapters in `packages/forge/src/security`.

## Adding a source

1. Verify the official endpoint, current free limits, commercial-use rights, attribution, and update cadence.
2. Add an audited read-only Turen adapter with fixed endpoint policy, strict input validation, response limits, caching, and compact output.
3. Add the manifest under `services/catalog/manifests/data`.
4. Add or update adapter and catalog tests.
5. Run `bun run generate` in `packages/extensions` and commit `packages/extensions/src/generated.ts`.

Catalog metadata is not runtime authority. A data manifest may select only a separately reviewed `security:<id>` adapter; it cannot grant network, process, filesystem, or credential privileges on its own.

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
