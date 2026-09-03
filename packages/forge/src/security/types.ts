/**
 * Shared types for the TurenOS Security MCP server.
 *
 * Keep these small and pragmatic: they are the wire contract between
 * integrations and the stdio MCP server in `mcp/server.ts`, and everything an
 * integration returns is ultimately serialized to compact JSON for LLM
 * consumption (see CONVENTIONS.md).
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info" | "unknown"

/** A single scanner/analysis finding in a common shape across all tools. */
export interface Finding {
  /** Rule or check identifier, e.g. "aws-access-key" or "CKV_AWS_20". */
  ruleId: string
  severity: Severity
  message: string
  /** Path relative to the scanned directory when available. */
  file?: string
  startLine?: number
  endLine?: number
  /** Name of the tool that produced the finding, e.g. "gitleaks". */
  tool?: string
  /** Small amount of tool-specific detail. Keep it compact. */
  extra?: Record<string, unknown>
}

/** A vulnerability record in a common shape across data integrations. */
export interface VulnRecord {
  /** Canonical identifier, e.g. "CVE-2024-3094", "GHSA-xxxx", or an OSV id. */
  id: string
  aliases?: string[]
  summary?: string
  severity?: Severity
  /** CVSS base score when known. */
  cvss?: number
  /** EPSS probability (0..1) when known. */
  epss?: number
  /** True when the vulnerability is known to be exploited (e.g. CISA KEV). */
  knownExploited?: boolean
  affected?: {
    package: string
    ecosystem?: string
    ranges?: string[]
    fixed?: string
  }[]
  references?: string[]
  /** Integration id that produced the record, e.g. "osv". */
  source: string
  /** ISO-8601 last-modified date when known. */
  modified?: string
}

/**
 * JSON Schema (draft-07 subset) describing a tool's arguments. Structurally
 * assignable to the MCP SDK's `Tool["inputSchema"]`.
 */
export interface ToolInputSchema {
  type: "object"
  properties?: Record<string, object>
  required?: string[]
  additionalProperties?: boolean
  [key: string]: unknown
}

/** Per-integration context handed to every tool handler. */
export interface IntegrationContext {
  /** Directory the agent is working in (cwd of the MCP server process). */
  readonly workspace: string
  /** On-disk cache directory reserved for this integration. */
  readonly cacheDir: string
  /**
   * Secrets from `FORGE_SECURITY_*` env vars with the prefix stripped,
   * e.g. FORGE_SECURITY_NVD_KEY -> secrets.NVD_KEY.
   */
  readonly secrets: Record<string, string>
}

export interface ToolRequestContext {
  readonly signal: AbortSignal
  readonly progress: (input: { progress: number; total?: number; message?: string }) => Promise<void>
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: IntegrationContext,
  request: ToolRequestContext,
) => Promise<unknown>

/** A single MCP tool contributed by an integration. */
export interface ToolDef {
  /**
   * Tool name, snake_case, prefixed with the integration id
   * (dashes -> underscores), e.g. "osv_query", "native_audit_run".
   * The MCP client prefixes the server name on top of this.
   */
  name: string
  description: string
  inputSchema: ToolInputSchema
  /**
   * Returns JSON-serializable data (the server serializes + truncates it) or
   * throws `ToolError` for expected failures (missing binary, missing API
   * key, upstream API error, bad arguments).
   */
  handler: ToolHandler
}

/**
 * Expected, user-facing tool failure. The server turns it into an MCP tool
 * error result instead of crashing. Any other thrown error is treated as a
 * bug and reported with its message.
 */
export class ToolError extends Error {
  readonly detail?: unknown

  constructor(message: string, detail?: unknown) {
    super(message)
    this.name = "SecurityToolError"
    this.detail = detail
  }
}

/** Stub handler used by not-yet-implemented integrations. */
export function notImplemented(integration: string): ToolHandler {
  return () => Promise.reject(new ToolError(`integration "${integration}" is not implemented yet`))
}
