export * as SessionTask from "./session-task"

import { Schema } from "effect"
import { Agent } from "./agent"
import { ascending } from "./identifier"
import { Model } from "./model"
import { Permission } from "./permission"
import { Prompt } from "./prompt"
import { AbsolutePath, DateTimeUtcFromMillis, NonNegativeInt, optional, statics } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

export const MAX_DESCRIPTION_LENGTH = 120
export const MAX_PROMPT_BYTES = 512_000
export const MAX_AUTHORITY_BYTES = 512_000
export const MAX_PERMISSION_RULES = 1_024
export const MAX_ANCESTOR_PERMISSION_SETS = 8
export const MAX_WRITE_ROOTS = 16
export const MAX_PATH_LENGTH = 4_096
export const MAX_COMMANDS = 32
export const MAX_COMMAND_LENGTH = 64 * 1_024
export const MAX_RESULT_LENGTH = 100_000
export const MAX_ERROR_LENGTH = 16_384
export const MAX_TOOL_CALL_ID_LENGTH = 256
export const MAX_AGENT_ID_LENGTH = 256
export const MAX_MODEL_ID_LENGTH = 512
export const MAX_PROVIDER_ID_LENGTH = 256
export const MAX_VARIANT_ID_LENGTH = 256
export const REQUEST_HASH_LENGTH = 64

/**
 * Bounds for how many subagents one root Session may run at the same time.
 *
 * The effective value is configurable (`subagents.max_concurrent`), so these
 * live beside the other durable task bounds rather than inside the enforcing
 * module: the config schema and the durable task layer both need them, and the
 * config schema cannot import the task layer.
 *
 * `DEFAULT_ACTIVE_PER_ROOT` is the normal ceiling. `MAX_ACTIVE_PER_ROOT` is a
 * hard cap that configuration cannot raise:
 * every concurrent child is a whole model session with its own provider stream
 * and tool subprocesses, and depth is capped at one, so this bounds a root at
 * fifty-one live sessions rather than an unbounded fan-out. `MIN_ACTIVE_PER_ROOT`
 * is one because zero would advertise subagent tools that can never succeed;
 * denying the `spawn_agent` permission is how delegation gets turned off.
 */
export const MIN_ACTIVE_PER_ROOT = 1
export const DEFAULT_ACTIVE_PER_ROOT = 50
export const MAX_ACTIVE_PER_ROOT = 50

const bounded = (maximum: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(maximum)))
const Ruleset = Permission.Ruleset.pipe(Schema.check(Schema.isMaxLength(MAX_PERMISSION_RULES)))
const TaskPrompt = Prompt
const TaskAgentID = Agent.ID.pipe(Schema.check(Schema.isMaxLength(MAX_AGENT_ID_LENGTH)))
const TaskModelRef = Schema.Struct({
  id: Model.ID.pipe(Schema.check(Schema.isMaxLength(MAX_MODEL_ID_LENGTH))),
  providerID: Model.Ref.fields.providerID.pipe(Schema.check(Schema.isMaxLength(MAX_PROVIDER_ID_LENGTH))),
  variant: Model.VariantID.pipe(Schema.check(Schema.isMaxLength(MAX_VARIANT_ID_LENGTH)), optional),
})
const RequestHash = Schema.String.check(
  Schema.isMinLength(REQUEST_HASH_LENGTH),
  Schema.isMaxLength(REQUEST_HASH_LENGTH),
  Schema.isPattern(/^[0-9a-f]{64}$/),
)

export const ID = Schema.String.check(Schema.isStartsWith("tsk_")).pipe(
  Schema.brand("SessionTask.ID"),
  statics((schema) => ({ create: () => schema.make(`tsk_${ascending()}`) })),
)
export type ID = typeof ID.Type

export const OperationID = Schema.String.check(Schema.isStartsWith("tso_")).pipe(
  Schema.brand("SessionTask.OperationID"),
  statics((schema) => ({ create: () => schema.make(`tso_${ascending()}`) })),
)
export type OperationID = typeof OperationID.Type

export const Status = Schema.Literals([
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]).annotate({ identifier: "SessionTask.Status" })
export type Status = typeof Status.Type

export const ActiveStatus = Schema.Literals(["starting", "running"]).annotate({
  identifier: "SessionTask.ActiveStatus",
})
export type ActiveStatus = typeof ActiveStatus.Type

export const TerminalStatus = Schema.Literals(["completed", "failed", "cancelled", "interrupted"]).annotate({
  identifier: "SessionTask.TerminalStatus",
})
export type TerminalStatus = typeof TerminalStatus.Type

export const OperationKind = Schema.Literals(["spawn", "send", "interrupt"]).annotate({
  identifier: "SessionTask.OperationKind",
})
export type OperationKind = typeof OperationKind.Type

export const OperationStatus = Schema.Literals(["pending", "applied", "failed"]).annotate({
  identifier: "SessionTask.OperationStatus",
})
export type OperationStatus = typeof OperationStatus.Type

export interface Actor extends Schema.Schema.Type<typeof Actor> {}
export const Actor = Schema.Struct({
  sessionID: SessionID,
  assistantMessageID: SessionMessage.ID,
  toolCallID: bounded(MAX_TOOL_CALL_ID_LENGTH),
}).annotate({ identifier: "SessionTask.Actor" })

export interface Authority extends Schema.Schema.Type<typeof Authority> {}
export const Authority = Schema.Struct({
  parentPermissions: Ruleset,
  ancestorPermissionSets: Schema.Array(Ruleset).pipe(Schema.check(Schema.isMaxLength(MAX_ANCESTOR_PERMISSION_SETS))),
  childPermissions: Ruleset,
  hardPermissions: Ruleset,
  writeRoots: Schema.Array(AbsolutePath.pipe(Schema.check(Schema.isMaxLength(MAX_PATH_LENGTH)))).pipe(
    Schema.check(Schema.isMaxLength(MAX_WRITE_ROOTS)),
  ),
  commands: Schema.Array(bounded(MAX_COMMAND_LENGTH)).pipe(Schema.check(Schema.isMaxLength(MAX_COMMANDS))),
}).annotate({ identifier: "SessionTask.Authority" })

export interface Time extends Schema.Schema.Type<typeof Time> {}
export const Time = Schema.Struct({
  created: DateTimeUtcFromMillis,
  updated: DateTimeUtcFromMillis,
  started: DateTimeUtcFromMillis.pipe(optional),
  completed: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "SessionTask.Time" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  rootSessionID: SessionID,
  parentSessionID: SessionID,
  childSessionID: SessionID,
  parentTaskID: ID.pipe(optional),
  actor: Actor,
  agent: TaskAgentID,
  model: TaskModelRef.pipe(optional),
  prompt: TaskPrompt,
  description: bounded(MAX_DESCRIPTION_LENGTH),
  depth: NonNegativeInt,
  status: Status,
  revision: NonNegativeInt,
  authority: Authority,
  result: bounded(MAX_RESULT_LENGTH).pipe(optional),
  error: bounded(MAX_ERROR_LENGTH).pipe(optional),
  time: Time,
}).annotate({ identifier: "SessionTask.Info" })

export interface Operation extends Schema.Schema.Type<typeof Operation> {}
export const Operation = Schema.Struct({
  id: OperationID,
  taskID: ID,
  rootSessionID: SessionID,
  actor: Actor,
  kind: OperationKind,
  requestHash: RequestHash,
  messageID: SessionMessage.ID.pipe(optional),
  prompt: TaskPrompt.pipe(optional),
  status: OperationStatus,
  error: bounded(MAX_ERROR_LENGTH).pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "SessionTask.Operation" })
