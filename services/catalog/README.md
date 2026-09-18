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
docs/
  feed-licenses.md   data feed rights and exclusions
  skill-quality.md   the skill review rubric
```

Each manifest is one JSON file holding a single extension whose contributions share one type.

`manifests/mcp/` deployment variants:

- `hosted` — a fixed vendor HTTPS endpoint; TurenOS connects remotely.
- `customer-url` — the user supplies their instance base URL; the manifest pins the path suffix.
- `managed` — a pinned local package (`package`, `version`, `cutoff`, `command`, `args`, `platforms`, `environment`) run by the audited uv-managed runtime in `packages/forge/src/mcp/package-runtime.ts`. The manifest is the single source of truth for what executes; official trust only.
- `local` — an executable the user already installed (for example the 1Password desktop app's bundled `1password-mcp`); TurenOS discovers it, never downloads it.

`manifests/tools/` entries bind packaged WASM/binary security tools to their audited `security:<id>` adapters in `packages/forge/src/security`.

## Current Sources

The catalog contains 23 cybersecurity data sources:

- CISA Known Exploited Vulnerabilities
- CIRCL Hashlookup
- deps.dev
- ENISA EUVD
- EPSS by FIRST.org
- Exploit-DB
- CERT-FR MISP
- Datadog Malicious Artifacts
- GitHub Security Advisories
- GTFOBins
- Have I Been Pwned
- LOLBAS
- MITRE ATT&CK
- MITRE CWE
- MITRE D3FEND
- NIST NVD
- OpenSSF Scorecard
- OSV
- Phishing.Database
- Tor Exit Nodes
- TweetFeed
- Exa Web Search
- Parallel Web Search

Every entry declares its exact agent-facing tool allowlist. All `tools.write` lists are empty.
Threat-feed rights and exclusions are recorded in [`docs/feed-licenses.md`](docs/feed-licenses.md).

## Current Skills And Subagents

The catalog contains eleven downloadable skills:

- Secure Code Review
- Bug Root Cause
- Test Strategy
- Dependency Risk Review
- Threat Intelligence Brief
- Detection Engineering Review
- Incident Evidence Triage
- Technical Security Blog
- Threat Model Review
- IaC Config Review
- Customize Forge

It also contains four downloadable subagents:

- Software Architecture Reviewer
- Vulnerability Analyst
- Incident Responder
- Threat Hunter

Catalog prompts are original Turen content. They do not grant permissions. Subagents select only one host-defined profile (`read`, `data`, or `binary`), and Turen constructs the fixed read-only permission set.

## Selection Policy

A source belongs in this catalog only when all of the following are true:

- It provides cybersecurity data or structured defensive knowledge.
- Access is free without a paid-only dependency. Optional free API keys are acceptable.
- Commercial/product use is permitted by the source's current terms.
- The source has an official HTTPS API, documented feed, or versioned artifact.
- Turen uses a fixed audited origin and path; manifests cannot introduce arbitrary request URLs.
- Queries and responses can be bounded, cached, attributed, and exposed read-only.
- The source is not used to fetch malware, contact listed infrastructure, or execute catalog content.

Free tiers restricted to personal, internal, nonprofit, or noncommercial use are excluded. That currently excludes sources such as VirusTotal Public API, Shodan InternetDB, GreyNoise Community, AlienVault OTX, OpenPhish Community, Cloudflare Radar, and the authenticated abuse.ch URLhaus/ThreatFox/MalwareBazaar APIs.

## Manifest Contract

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
- Every skill must meet the review rubric in `docs/skill-quality.md`.

## Adding A Source

1. Verify the official endpoint, current free limits, commercial-use rights, attribution, and update cadence.
2. Add an audited read-only Turen adapter with fixed endpoint policy, strict input validation, response limits, caching, and compact output.
3. Add the manifest under `manifests/data`.
4. Add or update adapter and catalog tests.
5. Run `bun run generate` in `packages/extensions` and commit `src/generated.ts`.

Catalog metadata is not runtime authority. A data manifest may select only a separately reviewed `security:<id>` adapter; it cannot grant network, process, filesystem, or credential privileges on its own.

## Adding A Skill Or Subagent

1. Author original, bounded defensive instructions and a stable contribution ID.
2. Use a `catalog` source and keep secrets, commands, configuration, and tool policies empty.
3. Add `agent.profile` only for a subagent; choose `read`, `data`, or `binary`.
4. List non-authoritative tool requirements so the UI can disclose expected capabilities.
5. Review the entry against `docs/skill-quality.md`, then run `bun run generate` in `packages/extensions`.
6. Installs are scanned by Vigil; reviewed manifests are allowlisted by digest in `packages/forge/src/skill/vigil.ts`.

## Adding A Managed MCP Package

1. Vendor audit the package and record the exact `version` pin and a `cutoff` timestamp that bounds its transitive dependencies.
2. Declare the `managed` deployment with `command`, `args`, `platforms`, and `environment` bindings that reference declared `configuration` fields or `secrets` only.
3. Keep the tool allowlist explicit and read-only where the package supports it (for example `--read-only`).
4. Run `bun run generate` in `packages/extensions`; `validate.ts` enforces official trust, exact pins, safe declarations, and reference integrity.
