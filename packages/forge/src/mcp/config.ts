import { Schema } from "effect"
import { PositiveInt } from "@turenlabs/core/schema"

export const Local = Schema.Struct({
  type: Schema.Literal("local"),
  command: Schema.mutable(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
  timeout: Schema.optional(PositiveInt),
})
export type Local = Schema.Schema.Type<typeof Local>

export const OAuth = Schema.Struct({
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  callbackPort: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  redirectUri: Schema.optional(Schema.String),
})
export type OAuth = Schema.Schema.Type<typeof OAuth>

export const Remote = Schema.Struct({
  type: Schema.Literal("remote"),
  url: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  oauth: Schema.optional(Schema.Union([OAuth, Schema.Literal(false)])),
  timeout: Schema.optional(PositiveInt),
})
export type Remote = Schema.Schema.Type<typeof Remote>

export const Info = Schema.Union([Local, Remote]).annotate({ discriminator: "type" })
export type Info = Schema.Schema.Type<typeof Info>

export * as McpConfig from "./config"
