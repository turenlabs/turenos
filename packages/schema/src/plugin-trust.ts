export * as PluginTrust from "./plugin-trust"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { AbsolutePath, RelativePath } from "./schema"

export const MAX_FILES = 2_048
export const MAX_PATH_LENGTH = 4_096

export const Decision = Schema.Literals(["allow", "deny"]).annotate({ identifier: "PluginTrust.Decision" })
export type Decision = typeof Decision.Type

export const State = Schema.Literals(["none", "pending", "trusted", "denied", "invalid"]).annotate({
  identifier: "PluginTrust.State",
})
export type State = typeof State.Type

export const Fingerprint = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("PluginTrust.Fingerprint"),
)
export type Fingerprint = typeof Fingerprint.Type

export const Files = Schema.Array(RelativePath.pipe(Schema.check(Schema.isMaxLength(MAX_PATH_LENGTH)))).pipe(
  Schema.check(Schema.isMaxLength(MAX_FILES)),
)
export type Files = typeof Files.Type

const repository = { root: AbsolutePath, files: Files }
const fingerprinted = { ...repository, fingerprint: Fingerprint }

export const None = Schema.Struct({
  status: Schema.Literal("none"),
  ...repository,
}).annotate({ identifier: "PluginTrust.None" })
export type None = typeof None.Type

export const Pending = Schema.Struct({
  status: Schema.Literal("pending"),
  ...fingerprinted,
}).annotate({ identifier: "PluginTrust.Pending" })
export type Pending = typeof Pending.Type

export const Trusted = Schema.Struct({
  status: Schema.Literal("trusted"),
  ...fingerprinted,
}).annotate({ identifier: "PluginTrust.Trusted" })
export type Trusted = typeof Trusted.Type

export const Denied = Schema.Struct({
  status: Schema.Literal("denied"),
  ...fingerprinted,
}).annotate({ identifier: "PluginTrust.Denied" })
export type Denied = typeof Denied.Type

export const Invalid = Schema.Struct({
  status: Schema.Literal("invalid"),
  ...repository,
  reason: Schema.String,
}).annotate({ identifier: "PluginTrust.Invalid" })
export type Invalid = typeof Invalid.Type

export const Status = Schema.Union([None, Pending, Trusted, Denied, Invalid]).annotate({
  identifier: "PluginTrust.Status",
})
export type Status = typeof Status.Type

const Required = define({
  type: "plugin.trust.required",
  schema: {
    root: AbsolutePath,
    fingerprint: Fingerprint,
    files: Files,
  },
})

export const Event = { Required, Definitions: inventory(Required) }
