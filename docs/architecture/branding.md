# TurenOS branding and compatibility policy

This policy separates the product name from durable technical identity. The product-facing name is
**TurenOS**. The company name is **Turen Labs**. The repository still contains intentional Forge
compatibility seams; those seams are part of the supported technical surface and must not be changed
as a documentation-only rebrand.

## Naming rules

### Product and backend roles

**TurenOS** names the user-facing web UI and Desktop application. It is where users work with
sessions, agents, tools, providers, and security workflows. **`forge`** names the supporting backend
CLI utility, not a second user-facing product or an alternative product name for TurenOS.

Use `forge` when referring to the actual executable or commands such as `forge serve`. Its role is
headless server operation, remote hosts over SSH, managed WSL backends, and backend administration.
Desktop starts its local server directly in an Electron utility process; users do not need to install
the CLI separately to use the local TurenOS application.

The current executable still exposes broader commands, including agent runs, provider management,
sessions, and upgrades. This policy defines the intended product roles; it does not claim those
commands have been removed. Preserving `forge` and `forge-cli` for compatibility does not make the
full existing command surface a parallel product direction. Command removal or renaming requires a
separate implementation and compatibility review.

### Use TurenOS for product copy

Use **TurenOS** in user-facing prose when referring to the product, application, desktop experience,
server experience, agent environment, or documentation set.

Use **TurenOS** in:

- Documentation titles, headings, navigation labels, and page descriptions.
- Product descriptions, UI examples, onboarding copy, and release-facing explanations.
- Descriptions of the desktop shell, local server, CLI experience, sessions, tools, integrations,
  and security workflows when the text is about what a user sees.
- New prose that explains the runtime in this repository, even when the implementation lives under
  `packages/forge`.

Use **Turen Labs** for the legal entity, company, organization, or corporate website. Do not change
that company name to TurenOS.

### Preserve technical identity

Keep a compatibility identifier exactly as it is when it is code, a command, a path, an environment
variable, a package or namespace name, a URL, a serialized format, a protocol field, or a historical
finding. Put these values in code formatting when writing about them so the distinction is clear.

| Surface                    | Retain exactly                                                                                                                    | Why                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI and executable         | `forge`, `forge-cli`                                                                                                              | Existing scripts, installed binaries, shell completion, and process discovery use these names.                                              |
| Packages and paths         | `forge`, `@turenlabs/forge`, `packages/forge`                                                                                     | Package resolution, imports, repository layout, and source links depend on them.                                                            |
| Runtime namespaces         | `@forge/*`, `mcp__forge__*`, `ForgeEvent`, `ForgeHttpApi`                                                                         | Service tags, MCP routing, generated types, and API composition are serialized or imported identities.                                      |
| Configuration              | `forge.json`, `forge.jsonc`, `.forge/`                                                                                            | Existing projects and user configuration resolve these paths.                                                                               |
| Environment                | `FORGE_*`                                                                                                                         | Environment variable names are part of the CLI/server contract. Never invent a replacement prefix.                                          |
| Local data                 | `forge.db`, `forge-dev.db`, `forge-local.db`, `~/.local/share/forge`, `~/Library/Caches/forge`                                    | Renaming storage paths can orphan databases, caches, credentials, or user state.                                                            |
| Secret envelope            | `forge-secret:v1`                                                                                                                 | The prefix is authenticated serialized data and is parsed by the vault.                                                                     |
| Protocol seams             | `x-forge-ticket`, `x-forge-workspace`, `ForgeHttpApi`                                                                             | Wire clients and middleware compare these exact values.                                                                                     |
| Provider attribution       | `X-Title: Forge`, `X-Source` (two values, see below), `X-BILLING-INVOKE-ORIGIN: Forge`, `X-Cerebras-3rd-Party-Integration: Forge` | These identify registered provider integrations, not the Desktop display name; change them only with provider-specific registration review. |
| Source and repository URLs | `https://github.com/turenlabs/forge` and URLs containing `/forge/`                                                                | URLs are technical links and external references, not display copy.                                                                         |
| Application identity       | `com.turenlabs.forge`, `com.turenlabs.forge.dev`, `com.turenlabs.forge.beta`                                                      | Bundle IDs and OS data/keychain locations are durable identity.                                                                             |
| Historical evidence        | An original Forge name in a dated finding, measurement, or compatibility record                                                   | Changing evidence makes the historical statement inaccurate.                                                                                |

LLM Gateway currently receives two different `X-Source` values. The Session V2 provider plugin sends `X-Source: Forge`
([`packages/core/src/plugin/provider/llmgateway.ts`](../../packages/core/src/plugin/provider/llmgateway.ts), pinned by
`packages/core/test/plugin/provider-llmgateway.test.ts`), and the legacy provider sends `X-Source: Turen`
([`packages/forge/src/provider/provider.ts`](../../packages/forge/src/provider/provider.ts)). Both are retained as they
are until the registered value is confirmed with LLM Gateway; do not align one to the other as a copy edit.

This is a minimum list, not a license to infer a new identifier. If a value is consumed by a parser,
loader, lookup, import, migration, API client, operating system, or external service, preserve it
unless a separately reviewed migration explicitly changes the contract.

## Copy examples

| Avoid in new product prose  | Use instead                                                                                   | Preserve when it is the subject                                     |
| --------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `# Forge Quality Gate`      | `# TurenOS Quality Gate`                                                                      | The filename or path `.forge-quality-gate-probe.ts`                 |
| `Forge's session runner`    | `TurenOS's session runner`                                                                    | The symbol or service tag `@forge/v2/SessionExecution`              |
| `The Forge desktop app`     | `The TurenOS desktop app`                                                                     | `packages/desktop` source references and `com.turenlabs.forge*` IDs |
| `Forge tools are available` | `TurenOS tools are available`                                                                 | The MCP namespace `mcp__forge__*`                                   |
| `Turen cache directory`     | `TurenOS cache directory`                                                                     | A literal path such as `~/Library/Caches/forge`                     |
| `Forge package`             | `TurenOS package` when discussing the product; `@turenlabs/forge` when discussing the package | `@turenlabs/forge` and `packages/forge`                             |
| `Turen's server`            | `TurenOS's server`                                                                            | `Turen Labs` as the company name                                    |

Do not mechanically replace text inside code, commands, paths, URLs, environment variables, package
names, namespaces, or historical findings. A sentence may use TurenOS around an unchanged technical
value, for example: "TurenOS serves the API implemented in `packages/forge`."

## Retained Forge seams

The Forge name remains visible because it participates in compatibility rather than because it is the
current product name. The main seams are:

1. **User data and credentials.** The application ID, user-data directory, database path, and
   Electron safe-storage service name are tied to existing users. `packages/desktop/src/main/index.ts`
   therefore retains its internal `APP_NAMES` values until a credential migration exists. A
   display-name change must not silently point at a new keychain item or data directory.
2. **CLI and package consumers.** Existing scripts invoke `forge`, package manifests resolve
   `@turenlabs/forge`, and source imports use `packages/forge`.
3. **Wire and generated contracts.** MCP tool routing, service tags, protocol headers, generated
   type names, and serialized envelopes are compared or decoded exactly.
4. **Configuration and migration inputs.** `.forge/`, `forge.json`, `forge.jsonc`, and related
   database/cache files are existing inputs. They can be described as TurenOS compatibility paths,
   but their spelling must remain unchanged.
5. **Historical records.** Measurements and findings that name Forge document the state or product
   vocabulary at the time of observation. Correct a historical record only when the correction is
   explicitly about its accuracy; do not rewrite it solely for visual consistency.

The rebrand changes the visible product vocabulary around these seams. It does not change their
meaning, lookup behavior, serialization, or storage location.

## Documentation checklist

Before merging a documentation change:

- Does the title and product-facing prose say TurenOS where it means the product?
- Does company copy retain Turen Labs?
- Are commands, code spans, paths, environment variables, package names, namespaces, URLs, and
  serialized values unchanged?
- Are old names retained when the paragraph is documenting a historical observation or compatibility
  finding?
- Do source links point to the actual implementation, and do generated-file instructions point to
  the source generator rather than a generated output?
- If a new example includes a retained Forge value, is it clearly shown as code or as a compatibility
  seam rather than presented as the current display name?

For the source-grounded architecture and system descriptions, see [Architecture](./README.md)
and [Systems](../systems/README.md). The implementation rationale for several retained names is also recorded
in [`packages/desktop/src/main/index.ts`](../../packages/desktop/src/main/index.ts),
[`packages/core/src/database/database.ts`](../../packages/core/src/database/database.ts), and
[`packages/core/src/secret-vault.ts`](../../packages/core/src/secret-vault.ts).
