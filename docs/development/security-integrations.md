# Security MCP integration conventions

How to add or change an integration in the TurenOS Security MCP server. The server is a local stdio MCP process named
`forge-security`, started by the hidden `forge security-mcp` command, that exposes TurenOS-managed security data sources,
scanners, and agent integrations as MCP tools. Its code is in `packages/forge/src/security/`, and every integration is
paired with an official catalog manifest.

## Layout

```
packages/forge/src/security/
  types.ts              Finding, VulnRecord, ToolDef, IntegrationContext, ToolError
  registry.ts           Integration interface, the implementations list, catalog projection, env and secret helpers
  mcp/server.ts         stdio server: lists tools, dispatches calls, serializes and truncates results
  util/http.ts          fetchJson/fetchText: fixed endpoints, timeout, 429/5xx retry, memory and disk cache
  util/scanner.ts       which/requireBinary/run plus parseSarif/parseJsonOutput
  integrations/         one module per integration; data sources are grouped in data-*/ subfolders
packages/forge/src/cli/cmd/security-mcp.ts   the hidden CLI command (registered in src/index.ts)
```

## Adding an integration

1. Write the module under `integrations/` (or the matching `integrations/data-*/` folder). It exports one
   `Integration` whose `id` is the adapter name, for example `cwe` for `security:cwe`.
2. Add it to the `implementations` list in `registry.ts`. The list order is the listing order.
3. Add or update its manifest in `services/catalog/manifests/` with adapter `security:<id>`, following
   [Authoring catalog entries](../systems/developer-catalog-runtime/authoring.md). Regenerate with `bun run generate`
   in `packages/extensions`.
4. Add tests in `packages/forge/test/security/`, then run the checks under [Verification](#verification).

`registry.ts` projects each implementation through its catalog contribution when the module loads, and throws if:

- no contribution has adapter `security:<id>`, or it isn't a `tool`, `data`, or `mcp` contribution;
- the manifest's `tools.allow` doesn't list exactly the implementation's tool names;
- a `tool` manifest's `commands` don't match the implementation's `executables`.

The manifest, not the module, supplies `category`, `description`, `instructions`, `secrets`, and the settings `group`.

## The contract

```ts
export interface Integration {
  id: string // adapter name; also the token in FORGE_SECURITY_INTEGRATIONS
  category: "data" | "tools" | "agent-data" | "agent-tools" // overwritten from the manifest
  group?: IntegrationGroup // overwritten from the manifest for tool contributions
  description: string // overwritten from the manifest
  instructions?: string // overwritten from the manifest
  secrets?: string[] // overwritten from the manifest's declared secrets
  executables?: readonly string[] // host executables the adapter runs; must match the manifest's commands
  tools: ToolDef[]
}

export interface ToolDef {
  name: string // snake_case, prefixed with the integration id (dashes become underscores)
  description: string
  inputSchema: ToolInputSchema // JSON Schema draft-07 subset, additionalProperties: false
  handler: ToolHandler
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: IntegrationContext,
  request: ToolRequestContext, // { signal: AbortSignal; progress(input): Promise<void> }
) => Promise<unknown>
```

`ctx` provides `workspace` (the MCP server's working directory, which is the agent's), `cacheDir` (a disk cache reserved
for the integration), and `secrets` (the `FORGE_SECURITY_*` values for the secret names this integration declares, with
the prefix stripped; see [Secrets and enablement](#secrets-and-enablement)). `request` carries the MCP call's abort
`signal` and a `progress` callback that sends `notifications/progress` when the client supplied a progress token.

## Handlers

- Validate arguments yourself; the schema is advisory. Throw `ToolError` on bad input.
- Throw `ToolError` for every expected failure: missing binary, missing API key, upstream 4xx, unsupported project type.
  The message must tell the model what to do next, for example `"trivy" is not installed... Install it with: brew
install trivy`. Any other exception is treated as a bug: it is logged to stderr and returned as an error result reading
  `internal error in <tool>: <message>`, with secret values redacted.
- Return plain JSON-serializable data, not Markdown or prose.
- Log only to `process.stderr`; stdout carries the JSON-RPC protocol.

## Output

- The server serializes each result to compact JSON and truncates anything over 50,000 bytes into a `truncated: true`
  envelope (`MAX_RESULT_BYTES` in `mcp/server.ts`). Don't rely on it: cap your own output (about 50 items sorted by
  severity, plus `total` counts) so results stay complete and valid.
- Scanners return `{ tool, target, findings: Finding[], total, ... }` using the shared `Finding` shape, via
  `Scanner.parseSarif` or your own mapping. Redact secret values (gitleaks) to rule, file, and line.
- Data sources return `VulnRecord[]`-shaped data where it fits, otherwise a compact summary, never the raw response.

## Fetching and caching (data sources)

Fetch through `util/http.ts` (`fetchJson`/`fetchText`). It sets the `forge-security` User-Agent, retries 429, 5xx, and
network errors with backoff (three attempts by default), and caches in memory and on disk.

- Adapters in the `integrations/data-*/` folders pass `fixedEndpoint: { id, endpoint, pathPrefix }`. The helper then
  pins public DNS addresses for one hour, refuses redirects and origin or path escapes, and rejects private and metadata
  networks. The top-level data adapters (`osv`, `depsdev`, `kev`, `epss`, `ghsa`, `hibp`, `exploitdb`, `nvd`) pass no
  `fixedEndpoint` and use plain `fetch`, so they get none of those checks. In both cases endpoints are source constants,
  never tool arguments.
- Set `maxResponseBytes` below the 64 MiB default when the source documents a smaller bound.
- Whole-feed sources (`kev`, `exploitdb`) download the feed with `cache: { dir: ctx.cacheDir, ttlMs: 24 * 3_600_000 }`
  and answer lookups locally. Per-query APIs (`osv`, `depsdev`, `epss`, `ghsa`, `hibp`, `nvd`) cache for about an hour
  (`ttlMs: 3_600_000`).

## Scanners (tool integrations)

- `Scanner.requireBinary("name", "install hint")` finds an executable and never installs one.
- `Scanner.run([bin, ...args], { cwd, timeoutMs })` takes an argv array, never a shell string, and returns non-zero exit
  codes instead of throwing, since many scanners exit 1 when they find something.
- Resolve a user-supplied `path` against `ctx.workspace` and reject paths that resolve outside it.

## Secrets and enablement

A secret is declared in the manifest, entered by the user in settings, and sealed in the Secret Vault under the
extension's scope. When TurenOS starts the managed server, `spawnEnvironment` passes the enabled integration ids as
`FORGE_SECURITY_INTEGRATIONS` and each enabled integration's secrets as `FORGE_SECURITY_<NAME>`; inside the server they
appear as `ctx.secrets.<NAME>`. `FORGE_SECURITY_INTEGRATIONS` unset or `all` means every integration, and an empty value
means none, in `enabledIntegrations`. The `forge security-mcp` command sets an unset variable to the empty string before
starting the server, so a hand-started server with no `FORGE_SECURITY_INTEGRATIONS` enables none; set it to `all` to
enable every integration.

TurenOS builds the managed `forge-security` MCP entry itself when at least one security integration is enabled; it is not
read from the user's `mcp` configuration. `FORGE_SECURITY_*` variables are passed only to that managed process and are
stripped from every other MCP server's environment. The HIBP integration uses only keyless endpoints and reads no secret.

Build the server command with `resolvePtyCommand(FORGE_CLI_COMMAND, ["security-mcp"])` from
`packages/forge/src/server/pty-command.ts`, which handles dev and compiled binaries. Don't use the literal `"forge"` as
`command[0]`: the MCP client sets `BUN_BE_BUN=1` for it, which turns a compiled binary into a plain Bun runtime and the
CLI never runs.

## Verification

From `packages/forge`:

```sh
bun typecheck
bun test test/security
```

## Source

- [`packages/forge/src/security/registry.ts`](../../packages/forge/src/security/registry.ts)
- [`packages/forge/src/security/types.ts`](../../packages/forge/src/security/types.ts)
- [`packages/forge/src/security/mcp/server.ts`](../../packages/forge/src/security/mcp/server.ts)
- [`packages/forge/src/security/util/http.ts`](../../packages/forge/src/security/util/http.ts)
- [`packages/forge/src/security/util/scanner.ts`](../../packages/forge/src/security/util/scanner.ts)
- [`packages/forge/src/mcp/index.ts`](../../packages/forge/src/mcp/index.ts)
