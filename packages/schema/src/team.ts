export * as Team from "./team"

import { Schema } from "effect"
import { Agent } from "./agent"
import { Model } from "./model"
import { optional } from "./schema"

const boundedText = (max: number) => Schema.String.pipe(Schema.check(Schema.isMaxLength(max)))
const requiredText = (max: number) =>
  Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(max)))

export const FactoryConfig = Schema.Struct({
  outcome: requiredText(4000),
  parameters: Schema.Record(Schema.String.pipe(Schema.check(Schema.isMaxLength(128))), Schema.Json),
  constraints: boundedText(8000),
  acceptanceCriteria: requiredText(4000),
  directory: requiredText(4096),
  coordinatorTeammateID: requiredText(256),
  teammateIDs: Schema.Array(requiredText(256)).pipe(Schema.check(Schema.isMaxLength(10))),
}).annotate({ identifier: "Team.FactoryConfig" })
export interface FactoryConfig extends Schema.Schema.Type<typeof FactoryConfig> {}

export const Factory = Schema.Struct({
  config: FactoryConfig,
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
}).annotate({ identifier: "Team.Factory" })
export interface Factory extends Schema.Schema.Type<typeof Factory> {}

export const FactoryRunStatus = Schema.Literals([
  "running",
  "succeeded",
  "needs_input",
  "failed",
  "cancelled",
  "stale",
]).annotate({ identifier: "Team.FactoryRunStatus" })
export type FactoryRunStatus = typeof FactoryRunStatus.Type

export const FactoryRun = Schema.Struct({
  id: Schema.String,
  roomID: Schema.String,
  status: FactoryRunStatus,
  phase: Schema.Literals(["plan", "work", "check", "done"]),
  taskIDs: Schema.Array(Schema.String),
  result: boundedText(32_768).pipe(optional),
  error: boundedText(8_000).pipe(optional),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
}).annotate({ identifier: "Team.FactoryRun" })
export interface FactoryRun extends Schema.Schema.Type<typeof FactoryRun> {}

export const FactoryPlan = Schema.Struct({
  assignments: Schema.Array(Schema.Struct({ teammateID: requiredText(256), prompt: requiredText(8_000) })),
}).annotate({ identifier: "Team.FactoryPlan" })
export interface FactoryPlan extends Schema.Schema.Type<typeof FactoryPlan> {}

export const FactoryCheck = Schema.Struct({
  status: Schema.Literals(["accepted", "needs_input", "rejected"]),
  summary: requiredText(8_000),
}).annotate({ identifier: "Team.FactoryCheck" })
export interface FactoryCheck extends Schema.Schema.Type<typeof FactoryCheck> {}

export const Room = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  topic: Schema.String,
  head: Schema.Int,
  archived: Schema.Boolean.pipe(optional),
  factory: Factory.pipe(optional),
}).annotate({ identifier: "Team.Room" })
export interface Room extends Schema.Schema.Type<typeof Room> {}

export const EditRoom = Schema.Struct({
  name: Schema.String.pipe(optional),
  topic: Schema.String.pipe(optional),
}).annotate({ identifier: "Team.EditRoom" })
export interface EditRoom extends Schema.Schema.Type<typeof EditRoom> {}

export const Avatar = Schema.Array(
  Schema.String.pipe(Schema.check(Schema.isMaxLength(8)), Schema.check(Schema.isPattern(/^[.0-7]{8}$/))),
)
  .pipe(Schema.check(Schema.isMinLength(8)), Schema.check(Schema.isMaxLength(8)))
  .annotate({
    identifier: "Team.Avatar",
    description:
      "An 8 by 8 pixel avatar. Each row has eight characters. '.' is transparent; '0' through '7' select the fixed eight-color palette.",
  })
export type Avatar = typeof Avatar.Type

export const Teammate = Schema.Struct({
  id: Schema.String,
  roomID: Schema.String,
  name: Schema.String,
  handle: Schema.String,
  role: Schema.String,
  mission: Schema.String,
  status: Schema.Literals(["active", "paused"]),
  directory: Schema.String,
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  avatar: Avatar.pipe(optional),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
}).annotate({ identifier: "Team.Teammate" })
export interface Teammate extends Schema.Schema.Type<typeof Teammate> {}

export const Message = Schema.Struct({
  id: Schema.String,
  roomID: Schema.String,
  seq: Schema.Int,
  kind: Schema.Literals(["human", "teammate", "system"]),
  author: Schema.String,
  teammateID: Schema.String.pipe(optional),
  text: Schema.String,
  replyTo: Schema.String.pipe(optional),
  sessionID: Schema.String.pipe(optional),
  sourceMessageIDs: Schema.Array(requiredText(256)).pipe(Schema.check(Schema.isMaxLength(256)), optional),
  runID: Schema.String.pipe(optional),
  loopID: Schema.String.pipe(optional),
  time: Schema.Number,
}).annotate({ identifier: "Team.Message" })
export interface Message extends Schema.Schema.Type<typeof Message> {}

export const TaskStatus = Schema.Literals([
  "queued",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "stale",
]).annotate({ identifier: "Team.TaskStatus" })
export type TaskStatus = typeof TaskStatus.Type

export const Task = Schema.Struct({
  id: Schema.String,
  roomID: Schema.String,
  messageID: Schema.String,
  teammateID: Schema.String,
  sessionID: Schema.String,
  status: TaskStatus,
  error: Schema.String.pipe(optional),
  factoryRunID: Schema.String.pipe(optional),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
}).annotate({ identifier: "Team.Task" })
export interface Task extends Schema.Schema.Type<typeof Task> {}

export const Duty = Schema.Struct({ loopID: Schema.String, teammateID: Schema.String }).annotate({
  identifier: "Team.Duty",
})
export interface Duty extends Schema.Schema.Type<typeof Duty> {}

export const State = Schema.Struct({
  rooms: Schema.Array(Room),
  room: Room,
  teammates: Schema.Array(Teammate),
  messages: Schema.Array(Message),
  tasks: Schema.Array(Task),
  duties: Schema.Array(Duty),
  factoryRuns: Schema.Array(FactoryRun).pipe(optional),
  hasMore: Schema.Boolean,
}).annotate({ identifier: "Team.State" })
export interface State extends Schema.Schema.Type<typeof State> {}

export const CreateTeammate = Schema.Struct({
  roomID: Schema.String.pipe(optional),
  name: Schema.String,
  handle: Schema.String,
  role: Schema.String,
  mission: Schema.String,
  directory: Schema.String.pipe(optional),
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  avatar: Avatar.pipe(optional),
}).annotate({ identifier: "Team.CreateTeammate" })
export interface CreateTeammate extends Schema.Schema.Type<typeof CreateTeammate> {}

export const EditTeammate = Schema.Struct({
  name: Schema.String.pipe(optional),
  role: Schema.String.pipe(optional),
  mission: Schema.String.pipe(optional),
  status: Schema.Literals(["active", "paused"]).pipe(optional),
  directory: Schema.String.pipe(optional),
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  avatar: Avatar.pipe(optional),
  resetAgent: Schema.Boolean.pipe(optional),
  resetModel: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Team.EditTeammate" })
export interface EditTeammate extends Schema.Schema.Type<typeof EditTeammate> {}

export const PostMessage = Schema.Struct({
  id: Schema.String,
  roomID: Schema.String.pipe(optional),
  text: Schema.String,
}).annotate({ identifier: "Team.PostMessage" })
export interface PostMessage extends Schema.Schema.Type<typeof PostMessage> {}

export const Posted = Schema.Struct({ message: Message, tasks: Schema.Array(Task) }).annotate({
  identifier: "Team.Posted",
})
export interface Posted extends Schema.Schema.Type<typeof Posted> {}

export class InvalidRequestError extends Schema.TaggedErrorClass<InvalidRequestError>()("Team.InvalidRequestError", {
  message: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Team.NotFoundError", {
  message: Schema.String,
}) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("Team.ConflictError", {
  message: Schema.String,
}) {}

export function mentionedHandles(text: string) {
  // Match complete tokens so @rae- cannot fall back to @rae.
  return [
    ...new Set(
      [...text.matchAll(/(?:^|[^a-zA-Z0-9_])@([a-zA-Z][a-zA-Z0-9_-]{0,31})(?![a-zA-Z0-9_-])/g)].map((match) =>
        match[1]!.toLowerCase(),
      ),
    ),
  ]
}
