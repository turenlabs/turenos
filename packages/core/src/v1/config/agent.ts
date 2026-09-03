export * as ConfigAgentV1 from "./agent"

import { Schema, SchemaGetter } from "effect"
import { PositiveInt } from "../../schema"
import { ConfigPermissionV1 } from "./permission"

const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

const AgentSchema = Schema.Struct({
  model: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String).annotate({
    description: "Default model variant for this agent (applies only when using the agent's configured model).",
  }),
  prompt: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description: "@deprecated Use 'permission' field instead",
  }),
  disable: Schema.optional(Schema.Boolean),
  description: Schema.optional(Schema.String).annotate({ description: "Description of when to use the agent" }),
  mode: Schema.optional(Schema.Literals(["subagent", "primary", "all"])),
  hidden: Schema.optional(Schema.Boolean).annotate({
    description: "Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)",
  }),
  color: Schema.optional(Color).annotate({
    description: "Hex color code (e.g., #FF5733) or theme color (e.g., primary)",
  }),
  steps: Schema.optional(PositiveInt).annotate({
    description: "Maximum number of agentic iterations before forcing text-only response",
  }),
  maxSteps: Schema.optional(PositiveInt).annotate({ description: "@deprecated Use 'steps' field instead." }),
  permission: Schema.optional(ConfigPermissionV1.Info),
})

const normalize = (agent: Schema.Schema.Type<typeof AgentSchema>): Schema.Schema.Type<typeof AgentSchema> => {
  const permission: ConfigPermissionV1.Info = {}
  for (const [tool, enabled] of Object.entries(agent.tools ?? {})) {
    const action = enabled ? "allow" : "deny"
    if (tool === "write" || tool === "edit" || tool === "patch") {
      permission.edit = action
      continue
    }
    permission[tool] = action
  }
  globalThis.Object.assign(permission, agent.permission)

  const steps = agent.steps ?? agent.maxSteps
  return { ...agent, permission, ...(steps !== undefined ? { steps } : {}) }
}

export const Info = AgentSchema.pipe(
  Schema.decodeTo(AgentSchema, {
    decode: SchemaGetter.transform(normalize),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
).annotate({ identifier: "AgentConfig" })
export type Info = Schema.Schema.Type<typeof Info>
