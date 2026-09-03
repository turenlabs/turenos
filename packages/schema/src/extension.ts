export * as Extension from "./extension"

import { Option, Schema } from "effect"
import { optional, statics } from "./schema"

const slugPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export const ID = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/)),
  Schema.brand("Extension.ID"),
  // `statics` assigns onto the schema it is handed, so this two-argument `make` replaces the
  // schema's own one-argument constructor. The original has to be captured here, while the factory
  // runs and before the assignment lands: resolving `schema.make` at call time would find this
  // function instead and recurse until the process ran out of memory.
  statics((schema) => {
    const create = schema.make.bind(schema)
    return { make: (publisher: string, name: string) => create(`${publisher}/${name}`) }
  }),
)
export type ID = typeof ID.Type

export const ContributionID = Schema.String.pipe(
  Schema.check(Schema.isPattern(slugPattern)),
  Schema.brand("Extension.ContributionID"),
)
export type ContributionID = typeof ContributionID.Type

export const Kind = Schema.Literals(["tool", "mcp", "data", "skill"])
export type Kind = typeof Kind.Type

export const Trust = Schema.Literals(["official", "verified", "community"])
export type Trust = typeof Trust.Type

export const SecretID = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z][A-Z0-9_]*$/)))
export type SecretID = typeof SecretID.Type

export const Secret = Schema.Struct({
  id: SecretID,
  label: Schema.String,
  required: Schema.Boolean,
}).annotate({ identifier: "Extension.Secret" })
export type Secret = typeof Secret.Type

export const ConfigurationID = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z][A-Za-z0-9]*$/)),
  Schema.brand("Extension.ConfigurationID"),
)
export type ConfigurationID = typeof ConfigurationID.Type

const Common = {
  id: ContributionID,
  name: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
  adapter: Schema.String,
  secrets: Schema.Array(Secret),
  defaultEnabled: Schema.Boolean,
}

export const ConfigurationField = Schema.Struct({
  id: ConfigurationID,
  label: Schema.String,
  required: Schema.Boolean,
}).annotate({ identifier: "Extension.ConfigurationField" })
export type ConfigurationField = typeof ConfigurationField.Type

export const ToolPolicy = Schema.Struct({
  allow: Schema.Array(Schema.String),
  write: Schema.Array(Schema.String),
}).annotate({ identifier: "Extension.ToolPolicy" })
export type ToolPolicy = typeof ToolPolicy.Type

export const Tool = Schema.Struct({
  type: Schema.Literal("tool"),
  ...Common,
  group: optional(Schema.String),
  commands: Schema.Array(Schema.String),
  configuration: Schema.Array(ConfigurationField),
  tools: ToolPolicy,
}).annotate({ identifier: "Extension.Tool" })
export type Tool = typeof Tool.Type

export const Data = Schema.Struct({
  type: Schema.Literal("data"),
  ...Common,
  tools: ToolPolicy,
}).annotate({ identifier: "Extension.Data" })
export type Data = typeof Data.Type

export const McpDeployment = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("hosted"),
    url: Schema.String,
    headers: optional(Schema.Record(Schema.String, Schema.String)),
  }),
  Schema.Struct({ type: Schema.Literal("customer-url"), path: Schema.String, privateNetwork: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("local"),
    command: Schema.String,
    platforms: Schema.Array(Schema.Literals(["darwin", "linux", "win32"])),
  }),
  Schema.Struct({ type: Schema.Literal("configured") }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Extension.McpDeployment" })
export type McpDeployment = typeof McpDeployment.Type

export const McpContext = Schema.Struct({
  maxLoadedTools: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 12 }))),
  unloadAfterIdleTurns: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
}).annotate({ identifier: "Extension.McpContext" })
export type McpContext = typeof McpContext.Type

export const McpOAuthConnection = Schema.Struct({
  clientId: ConfigurationID,
  clientSecret: optional(SecretID),
  scope: optional(Schema.String),
}).annotate({ identifier: "Extension.McpOAuthConnection" })
export type McpOAuthConnection = typeof McpOAuthConnection.Type

export const McpHeaderConnection = Schema.Struct({
  name: Schema.String,
  secret: optional(SecretID),
  configuration: optional(ConfigurationID),
  prefix: optional(Schema.String),
}).annotate({ identifier: "Extension.McpHeaderConnection" })
export type McpHeaderConnection = typeof McpHeaderConnection.Type

export const McpConnection = Schema.Struct({
  oauth: optional(McpOAuthConnection),
  headers: optional(Schema.Array(McpHeaderConnection)),
}).annotate({ identifier: "Extension.McpConnection" })
export type McpConnection = typeof McpConnection.Type

export const Mcp = Schema.Struct({
  type: Schema.Literal("mcp"),
  ...Common,
  upstreamPolicy: Schema.Literals(["static", "audited-linear-dynamic-v1"]),
  deployment: McpDeployment,
  authentication: Schema.Literals(["none", "oauth", "key", "desktop", "client-credentials"]),
  localOnly: Schema.Boolean,
  configuration: optional(Schema.Array(ConfigurationField)),
  connection: optional(McpConnection),
  mcpContext: optional(McpContext),
  tools: ToolPolicy,
}).annotate({ identifier: "Extension.Mcp" })
export type Mcp = typeof Mcp.Type

export const SkillAgentProfile = Schema.Literals(["read", "data", "binary"])
export type SkillAgentProfile = typeof SkillAgentProfile.Type

export const SkillAgent = Schema.Struct({
  profile: SkillAgentProfile,
  steps: optional(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 50 })))),
}).annotate({ identifier: "Extension.SkillAgent" })
export type SkillAgent = typeof SkillAgent.Type

export const Skill = Schema.Struct({
  type: Schema.Literal("skill"),
  ...Common,
  source: Schema.Union([
    Schema.Struct({ type: Schema.Literal("embedded"), name: Schema.String }),
    Schema.Struct({ type: Schema.Literal("discovered") }),
    Schema.Struct({
      type: Schema.Literal("catalog"),
      content: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(32_768))),
    }),
  ]).pipe(Schema.toTaggedUnion("type")),
  requires: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(80)))).pipe(
    Schema.check(Schema.isMaxLength(20)),
  ),
  agent: optional(SkillAgent),
}).annotate({ identifier: "Extension.Skill" })
export type Skill = typeof Skill.Type

export const Contribution = Schema.Union([Tool, Mcp, Data, Skill])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Extension.Contribution" })
export type Contribution = typeof Contribution.Type

export class Manifest extends Schema.Class<Manifest>("Extension.Manifest")({
  schemaVersion: Schema.Literal(1),
  id: ID,
  name: Schema.String,
  description: Schema.String,
  version: Schema.String,
  publisher: Schema.String,
  trust: Trust,
  homepage: optional(Schema.String),
  contributions: Schema.Array(Contribution),
}) {}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function normalizeExternalContribution(value: unknown, manifestDescription?: string) {
  const contribution = record(value)
  if (contribution?.type === "mcp") return normalizeExternalMcp(contribution)
  if (contribution?.type === "skill") return normalizeExternalSkill(contribution, manifestDescription)
}

function normalizeExternalMcp(contribution: Record<string, unknown>) {
  const deployment = record(contribution.deployment)
  const tools = record(contribution.tools)
  if (
    typeof contribution.id !== "string" ||
    (contribution.authentication !== "none" && contribution.authentication !== "oauth") ||
    (Array.isArray(contribution.secrets) && contribution.secrets.length > 0) ||
    contribution.connection !== undefined ||
    deployment?.type !== "hosted" ||
    typeof deployment.url !== "string" ||
    !tools ||
    !Array.isArray(tools.allow) ||
    !Array.isArray(tools.write) ||
    tools.allow.some((tool) => typeof tool !== "string") ||
    tools.write.some((tool) => typeof tool !== "string")
  ) {
    return
  }
  const context = record(contribution.mcpContext)
  const writes = new Set(tools.write as string[])
  return {
    ...contribution,
    adapter: `mcp:${contribution.id}`,
    secrets: Array.isArray(contribution.secrets) ? contribution.secrets : [],
    configuration: Array.isArray(contribution.configuration) ? contribution.configuration : [],
    upstreamPolicy: "static",
    deployment: {
      type: "hosted",
      url: deployment.url,
      ...(record(deployment.headers) ? { headers: deployment.headers } : {}),
    },
    localOnly: contribution.localOnly === true,
    mcpContext: {
      maxLoadedTools:
        typeof context?.maxLoadedTools === "number"
          ? context.maxLoadedTools
          : Math.min(12, Math.max(1, tools.allow.length || 4)),
      unloadAfterIdleTurns: typeof context?.unloadAfterIdleTurns === "number" ? context.unloadAfterIdleTurns : 3,
    },
    // Dynamic installs remain read-only until runtime permissions can ingest a signed write policy.
    tools: { allow: (tools.allow as string[]).filter((tool) => !writes.has(tool)), write: [] },
  }
}

function normalizeExternalSkill(contribution: Record<string, unknown>, manifestDescription?: string) {
  const source = record(contribution.source)
  const agent = normalizeExternalSkillAgent(contribution.agent)
  const requires = normalizeExternalSkillRequirements(contribution.requires)
  if (
    typeof contribution.id !== "string" ||
    contribution.id.length > 80 ||
    typeof contribution.name !== "string" ||
    typeof contribution.description !== "string" ||
    manifestDescription === undefined ||
    typeof contribution.instructions !== "string" ||
    (Array.isArray(contribution.secrets) && contribution.secrets.length > 0) ||
    source?.type !== "catalog" ||
    typeof source.content !== "string" ||
    source.content.length === 0 ||
    source.content.trim() !== source.content ||
    source.content.length > 32_768 ||
    requires === undefined ||
    new Set(requires).size !== requires.length ||
    agent === false ||
    (agent !== undefined && externalReservedAgentIDs.has(contribution.id))
  ) {
    return
  }
  return {
    type: "skill",
    id: contribution.id,
    name: contribution.name,
    description: manifestDescription,
    instructions: contribution.instructions,
    adapter: `skill:${contribution.id}`,
    secrets: [],
    defaultEnabled: false,
    source: { type: "catalog", content: source.content },
    requires,
    ...(agent ? { agent } : {}),
  }
}

const externalReservedAgentIDs = new Set([
  "build",
  "plan",
  "general",
  "explore",
  "worker",
  "adversarial-review",
  "harness-reviewer",
  "qualification",
  "research",
  "lobby",
  "compaction",
  "title",
  "summary",
])

function normalizeExternalSkillRequirements(value: unknown) {
  const requires = value === undefined ? [] : value
  if (
    !Array.isArray(requires) ||
    requires.length > 20 ||
    requires.some((item) => typeof item !== "string" || item.length > 80)
  ) {
    return
  }
  return requires as string[]
}

function normalizeExternalSkillAgent(
  value: unknown,
): { profile: "read" | "data" | "binary"; steps?: number } | false | undefined {
  if (value === undefined) return
  const agent = record(value)
  if (!agent || (agent.profile !== "read" && agent.profile !== "data" && agent.profile !== "binary")) return false
  if (
    agent.steps !== undefined &&
    (!Number.isInteger(agent.steps) || (agent.steps as number) < 1 || (agent.steps as number) > 50)
  ) {
    return false
  }
  return { profile: agent.profile, ...(typeof agent.steps === "number" ? { steps: agent.steps } : {}) }
}

/** Projects catalog metadata onto runtime-safe hosted MCP and prompt-only skill shapes. */
export function normalizeExternalManifest(input: unknown): Manifest | undefined {
  const source = record(input)
  if (!source || !Array.isArray(source.contributions) || source.contributions.length === 0) return
  const manifestDescription =
    typeof source.description === "string" &&
    source.description.length <= 500 &&
    source.description.trim() === source.description &&
    !/[\r\n]/.test(source.description)
      ? source.description
      : undefined
  const contributions = source.contributions.map((value) => normalizeExternalContribution(value, manifestDescription))
  if (contributions.some((contribution) => contribution === undefined)) return

  const decoded = Schema.decodeUnknownOption(Manifest, {
    errors: "all",
    onExcessProperty: "ignore",
  })({
    ...source,
    // Display metadata from a configured catalog is not proof of publisher identity.
    trust: "community",
    contributions,
  })
  return Option.getOrUndefined(decoded)
}

export const RuntimeStatus = Schema.Literals([
  "available",
  "disabled",
  "needs-auth",
  "needs-config",
  "needs-install",
  "connecting",
  "connected",
  "failed",
  "unavailable",
])
export type RuntimeStatus = typeof RuntimeStatus.Type

export class Item extends Schema.Class<Item>("Extension.Item")({
  manifest: Manifest,
  origin: Schema.Literals(["catalog", "configuration", "discovery"]),
  mutable: Schema.Boolean,
  enabled: Schema.Boolean,
  status: RuntimeStatus,
  detail: optional(Schema.String),
  installed: optional(Schema.Boolean),
  updateAvailable: optional(Schema.Boolean),
  secretsSet: Schema.Record(Schema.String, Schema.Boolean),
  configurationSet: Schema.Record(Schema.String, Schema.Boolean),
}) {}

export const Update = Schema.Struct({
  enabled: Schema.Boolean,
  connect: optional(Schema.Boolean),
  operationID: optional(Schema.String),
  manifest: optional(Manifest),
  secrets: optional(Schema.Record(Schema.String, Schema.String)),
  configuration: optional(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "Extension.Update" })
export type Update = typeof Update.Type
