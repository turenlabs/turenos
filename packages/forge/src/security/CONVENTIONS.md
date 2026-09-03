# TurenOS Security MCP — implementer conventions

A local stdio MCP server ("forge-security") exposing TurenOS-managed security and
agent integrations as MCP tools. Started by the hidden CLI command `forge security-mcp`; the forge
MCP client spawns it as a `type: "local"` server and prefixes every tool name
with the config key (`<server>_<tool>`).

## Layout

```
src/security/
  types.ts            Finding, VulnRecord, ToolDef, IntegrationContext, ToolError
  registry.ts         Integration interface + INTEGRATIONS list + env/context helpers
  mcp/server.ts       stdio server: lists tools, dispatches calls, serializes/truncates
  util/http.ts        fetchJson/fetchText: timeout, 429/5xx retry, memory+disk cache
  util/scanner.ts     which/requireBinary/run + parseSarif/parseJsonOutput
  integrations/<id>.ts  one file per integration (yours)
CLI: src/cli/cmd/security-mcp.ts (registered in src/index.ts)
```

## Ownership

You implement exactly one file: `integrations/<your-id>.ts`. It is already
wired into `registry.ts` — do not edit `registry.ts`, `mcp/server.ts`,
`types.ts`, the util files, or any other integration. If a shared helper is
missing, add a private helper inside your own file. Tests (optional) go in
`packages/forge/test/security/<your-id>.test.ts`.

## The contract

Your file exports one `Integration` (see `registry.ts`):

```ts
export interface Integration {
  id: string // stable id used in FORGE_SECURITY_INTEGRATIONS
  category: "data" | "tools" | "agent-data" | "agent-tools"
  description: string // one line, shown in server instructions
  secrets?: string[] // secret names you read from ctx.secrets
  tools: ToolDef[]
}
```

and each tool (see `types.ts`):

```ts
export interface ToolDef {
  name: string // snake_case, prefixed with your id (dashes -> underscores)
  description: string
  inputSchema: ToolInputSchema // JSON Schema draft-07 subset, additionalProperties: false
  handler: (args: Record<string, unknown>, ctx: IntegrationContext) => Promise<unknown>
}
```

`ctx` gives you `workspace` (agent's cwd), `cacheDir` (your private disk cache
dir), and `secrets` (all `FORGE_SECURITY_*` env vars, prefix stripped).

Replace the `notImplemented(...)` handler with your implementation; keep the
exported name and `id` exactly as stubbed. You may adjust/add tools and input
schemas within your integration.

## Handlers

- Validate args yourself (the schema is advisory); throw `ToolError` on bad input.
- Throw `ToolError` for every expected failure: missing binary, missing API
  key, upstream 4xx, unsupported project type. The message must tell the LLM
  what to do next (e.g. `"trivy" is not installed... Install it with: brew install trivy`).
  Any other exception is treated as a bug (logged, generic error returned).
- Return plain JSON-serializable data. No Markdown, no prose paragraphs.
- Log only via `process.stderr` — stdout is the JSON-RPC wire.

## Output

- Results are serialized to compact JSON by the server with a hard cap of
  50KB; oversized payloads get truncated with a `truncated: true` envelope.
  Do not rely on that: cap your own output (top ~50 items, sorted by
  severity, plus `total` counts) so results are always valid JSON.
- Scanners ("tools"): return `{ tool, target, findings: Finding[], total, ... }`
  using the shared `Finding` shape (map via `Scanner.parseSarif` or your own
  JSON mapping). Redact secret values (gitleaks!) — rule + file + line only.
- Data APIs: return `VulnRecord[]`-shaped data where it fits; otherwise a
  compact summary of the upstream response, never the raw response verbatim.

## Caching (data integrations)

Always fetch through `util/http.ts` (`fetchJson`/`fetchText`) — it sets the
`forge-security` User-Agent, retries 429/5xx with backoff, and caches:

- Every new external data adapter must pass `fixedEndpoint: { id, endpoint, pathPrefix }`.
  The helper pins public DNS addresses for one hour, prohibits redirects and
  origin/path escapes, and rejects private or metadata networks. Endpoint
  values are audited source constants, never tool arguments or manifest data.
- Set `maxResponseBytes` below the 64 MiB default whenever the source contract
  has a smaller documented bound.

- Cached feeds (kev, exploitdb): download the full feed with
  `cache: { dir: ctx.cacheDir, ttlMs: 24 * 3_600_000 }`, answer lookups locally.
- Per-query APIs (osv, depsdev, epss, ghsa, hibp, nvd):
  `cache: { dir: ctx.cacheDir, ttlMs: 3_600_000 }` (~1h).

## Scanners (tools integrations)

- `Scanner.requireBinary("name", "install hint")` — never install anything.
- `Scanner.run([bin, ...args], { cwd, timeoutMs })` — argv arrays only, no
  shell; non-zero exit is returned (many scanners exit 1 on findings).
- Resolve user-supplied `path` args against `ctx.workspace` and reject paths
  that resolve outside it.

## Env vars

| Var                           | Meaning                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `FORGE_SECURITY_INTEGRATIONS` | comma-separated ids; unset or `all` = everything, empty = none |
| `FORGE_SECURITY_NVD_KEY`      | NVD API key -> `ctx.secrets.NVD_KEY`                           |
| `FORGE_SECURITY_GITHUB_TOKEN` | GitHub token for GHSA -> `ctx.secrets.GITHUB_TOKEN`            |
| `FORGE_SECURITY_HIBP_KEY`     | HIBP API key -> `ctx.secrets.HIBP_KEY`                         |

New secrets follow the same pattern: `FORGE_SECURITY_<NAME>` -> `ctx.secrets.<NAME>`;
declare them in your `Integration.secrets`.

## How forge spawns this server

The app writes an MCP config entry (`config.mcp["forge-security"]`):

```jsonc
{
  "type": "local",
  "command": ["/path/to/forge-binary", "security-mcp"],
  "environment": { "FORGE_SECURITY_INTEGRATIONS": "osv,kev,gitleaks" },
}
```

In-process, build the command with `resolvePtyCommand(FORGE_CLI_COMMAND, ["security-mcp"])`
from `src/server/pty-command.ts` (handles dev vs compiled binary). Do NOT use
the literal string `"forge"` as `command[0]` — the MCP client sets
`BUN_BE_BUN=1` for it, which turns the compiled binary into a plain bun
runtime and the CLI never runs.

## Verify

```sh
cd packages/forge && ../../node_modules/.bin/tsgo --noEmit   # bun is NOT installed here
```

Typecheck must be green before you finish. Do not run `bun`.
