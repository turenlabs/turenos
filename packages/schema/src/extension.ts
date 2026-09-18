export * as Extension from "./extension"

import { Schema } from "effect"
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
  default: optional(Schema.String),
  options: optional(Schema.Array(Schema.String)),
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
  endpoints: Schema.Record(Schema.String, Schema.String),
  tools: ToolPolicy,
}).annotate({ identifier: "Extension.Data" })
export type Data = typeof Data.Type

export const ManagedEnvironmentValue = Schema.Union([
  Schema.String,
  Schema.Struct({ configuration: ConfigurationID }),
  Schema.Struct({ secret: SecretID }),
])
export type ManagedEnvironmentValue = typeof ManagedEnvironmentValue.Type

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
  Schema.Struct({
    type: Schema.Literal("managed"),
    package: Schema.String,
    version: Schema.String,
    cutoff: Schema.String,
    command: Schema.String,
    args: optional(Schema.Array(Schema.String)),
    platforms: Schema.Array(Schema.Literals(["darwin", "linux", "win32"])),
    environment: optional(Schema.Record(Schema.String, ManagedEnvironmentValue)),
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
