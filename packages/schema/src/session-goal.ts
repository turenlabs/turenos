export * as SessionGoal from "./session-goal"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, optional, statics } from "./schema"
import { SessionID } from "./session-id"

export const ID = Schema.String.check(Schema.isStartsWith("goal_")).pipe(
  Schema.brand("SessionGoal.ID"),
  statics((schema) => ({
    create: () => schema.make(`goal_${ascending()}`),
  })),
)
export type ID = typeof ID.Type

export const Revision = PositiveInt.pipe(Schema.brand("SessionGoal.Revision"))
export type Revision = typeof Revision.Type

export const Status = Schema.Literals(["active", "paused", "blocked", "usageLimited", "complete"])
export type Status = typeof Status.Type

export const Objective = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(4_000)))
export type Objective = typeof Objective.Type

export const Info = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  revision: Revision,
  objective: Objective,
  status: Status,
  tokensUsed: NonNegativeInt,
  timeUsedSeconds: NonNegativeInt,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    statusChanged: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "SessionGoal.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionGoal.NotFoundError", {
  sessionID: SessionID,
  goalID: ID.pipe(optional),
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("SessionGoal.ConflictError", {
  sessionID: SessionID,
  goalID: ID.pipe(optional),
  expectedRevision: Revision.pipe(optional),
  actualGoalID: ID.pipe(optional),
  actualRevision: Revision.pipe(optional),
  message: Schema.String,
}) {}

export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()("SessionGoal.InvalidStateError", {
  sessionID: SessionID,
  goalID: ID,
  status: Status,
  message: Schema.String,
}) {}
