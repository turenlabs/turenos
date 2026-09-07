export * as Loop from "./loop"

import { Schema } from "effect"
import { Agent } from "@turenlabs/schema/agent"
import { Model } from "@turenlabs/schema/model"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, LoopNotFoundError, LoopRunNotFoundError } from "../errors"

export const ID = Schema.String
export type ID = typeof ID.Type

export const RunID = Schema.String
export type RunID = typeof RunID.Type

export const Schedule = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("interval"),
    seconds: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(60))),
    timezone: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("cron"),
    seconds: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(60))),
    expression: Schema.String,
    timezone: Schema.String,
  }),
]).annotate({ identifier: "Loop.Schedule" })
export type Schedule = typeof Schedule.Type

export const Status = Schema.Literals(["active", "paused", "expired"]).annotate({ identifier: "Loop.Status" })
export type Status = typeof Status.Type

export const Trigger = Schema.Literals(["scheduled", "manual", "file-change", "session-end"]).annotate({
  identifier: "Loop.Trigger",
})
export type Trigger = typeof Trigger.Type

export const FileChangeTrigger = Schema.Struct({
  type: Schema.Literal("file-change"),
  paths: Schema.Array(Schema.String),
  debounceMs: Schema.optional(Schema.Number),
}).annotate({ identifier: "Automation.FileChangeTrigger" })
export type FileChangeTrigger = typeof FileChangeTrigger.Type

export const SessionEndTrigger = Schema.Struct({
  type: Schema.Literal("session-end"),
  outcomes: Schema.optional(Schema.Array(Schema.Literals(["success", "failure"]))),
  sessionID: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
}).annotate({ identifier: "Automation.SessionEndTrigger" })
export type SessionEndTrigger = typeof SessionEndTrigger.Type

export const EventTrigger = Schema.Union([FileChangeTrigger, SessionEndTrigger]).annotate({
  identifier: "Automation.EventTrigger",
})
export type EventTrigger = typeof EventTrigger.Type

/**
 * Per-step execution overrides. Omitted fields inherit the Automation's own agent and
 * model, so a workflow that never sets them behaves exactly as before.
 */
const stepExecution = {
  agent: Schema.optional(Agent.ID),
  model: Schema.optional(Model.Ref),
}

const stepCondition = {
  when: Schema.optional(Schema.String),
  onFailure: Schema.optional(Schema.Literals(["stop", "continue"])),
}

export const WorkflowStep = Schema.Union([
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    type: Schema.Literal("agent"),
    prompt: Schema.String,
    ...stepExecution,
    ...stepCondition,
  }),
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    type: Schema.Literal("skill"),
    skill: Schema.String,
    instructions: Schema.String,
    ...stepExecution,
    ...stepCondition,
  }),
]).annotate({ identifier: "Automation.WorkflowStep" })
export type WorkflowStep = typeof WorkflowStep.Type

export const Workflow = Schema.Struct({
  version: Schema.Literal(1),
  steps: Schema.Array(WorkflowStep),
  delivery: Schema.Struct({ type: Schema.Literal("turen") }),
}).annotate({ identifier: "Automation.Workflow" })
export type Workflow = typeof Workflow.Type

export const StepArtifact = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("file"),
    uri: Schema.String,
    mime: Schema.String,
    name: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literals(["output", "changed"]), path: Schema.String }),
]).annotate({ identifier: "Automation.StepArtifact" })

export const StepOutput = Schema.Struct({
  text: Schema.String,
  json: Schema.optional(Schema.Unknown),
  artifacts: Schema.Array(StepArtifact),
}).annotate({ identifier: "Automation.StepOutput" })

export const CreateInput = Schema.Struct({
  name: Schema.String,
  prompt: Schema.String,
  /** When omitted, the TurenOS global data directory is used as the durable execution location. */
  location: Schema.optional(Schema.Struct({ directory: Schema.String, workspaceID: Schema.optional(Schema.String) })),
  agent: Schema.optional(Agent.ID),
  model: Schema.optional(Model.Ref),
  skill: Schema.optional(Schema.String),
  workflow: Schema.optional(Workflow),
  intervalSeconds: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(60)))),
  cronExpression: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String),
  startsAt: Schema.optional(Schema.Number),
  expiresAt: Schema.optional(Schema.Number),
  paused: Schema.optional(Schema.Boolean),
  eventTrigger: Schema.optional(EventTrigger),
}).annotate({ identifier: "Loop.CreateInput" })
export type CreateInput = typeof CreateInput.Type

export const EditInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  intervalSeconds: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(60)))),
  cronExpression: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.Number),
  agent: Schema.optional(Agent.ID),
  model: Schema.optional(Model.Ref),
  skill: Schema.optional(Schema.String),
  workflow: Schema.optional(Workflow),
  eventTrigger: Schema.optional(EventTrigger),
  resetAgent: Schema.optional(Schema.Boolean),
  resetModel: Schema.optional(Schema.Boolean),
  resetSkill: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Loop.EditInput" })
export type EditInput = typeof EditInput.Type

export const Info = Schema.Struct({
  id: ID,
  name: Schema.String,
  prompt: Schema.String,
  schedule: Schedule,
  status: Status,
  location: Schema.Struct({ directory: Schema.String, workspaceID: Schema.optional(Schema.String) }),
  agent: Schema.optional(Agent.ID),
  model: Schema.optional(Model.Ref),
  skill: Schema.optional(Schema.String),
  workflow: Schema.optional(Workflow),
  eventTrigger: Schema.optional(EventTrigger),
  overlapPolicy: Schema.Literal("skip"),
  startsAt: Schema.Number,
  expiresAt: Schema.Number,
  nextRunAt: Schema.optional(Schema.Number),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
}).annotate({ identifier: "Loop.Info" })
export type Info = typeof Info.Type

export const Run = Schema.Struct({
  id: RunID,
  loopID: ID,
  scheduledAt: Schema.Number,
  status: Schema.Literals(["claimed", "running", "succeeded", "failed", "cancelled", "skipped", "stale"]),
  trigger: Schema.Literals(["scheduled", "manual", "file-change", "session-end"]),
  triggerPayload: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /** Zero-based index of the step currently executing (or attempted); outputs holds completed steps. */
  currentStep: Schema.Number,
  sessionID: Schema.optional(Schema.String),
  outputs: Schema.Record(Schema.String, StepOutput),
  error: Schema.optional(Schema.String),
  time: Schema.Struct({
    created: Schema.Number,
    updated: Schema.Number,
    started: Schema.optional(Schema.Number),
    completed: Schema.optional(Schema.Number),
  }),
}).annotate({ identifier: "Loop.Run" })
export type Run = typeof Run.Type

const loopErrors = [InvalidRequestError, ConflictError, LoopNotFoundError] as const

export const LoopGroup = HttpApiGroup.make("server.loop")
  .add(
    HttpApiEndpoint.post("loop.create", "/api/loop", {
      payload: CreateInput,
      success: Info,
      error: loopErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.loop.create",
        summary: "Create loop",
        description:
          "Create and activate a recurring prompt loop. When no location is selected, it runs in the TurenOS global data directory.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("loop.list", "/api/loop", {
      success: Schema.Array(Info),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.loop.list",
        summary: "List loops",
        description: "List recurring prompt loops configured for a location.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("loop.get", "/api/loop/:loopID", {
      params: { loopID: ID },
      success: Info,
      error: LoopNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.loop.get",
        summary: "Get loop",
        description: "Retrieve one recurring prompt loop by ID.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("loop.edit", "/api/loop/:loopID", {
      params: { loopID: ID },
      payload: EditInput,
      success: Info,
      error: loopErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.loop.edit",
        summary: "Edit loop",
        description: "Edit a loop's prompt, schedule, or model selection.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("loop.pause", "/api/loop/:loopID/pause", {
      params: { loopID: ID },
      success: Info,
      error: loopErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.loop.pause",
        summary: "Pause loop",
        description: "Pause future scheduled runs of a loop.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("loop.resume", "/api/loop/:loopID/resume", {
      params: { loopID: ID },
      success: Info,
      error: loopErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.loop.resume",
        summary: "Resume loop",
        description: "Resume future scheduled runs of a paused loop.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("loop.delete", "/api/loop/:loopID", {
      params: { loopID: ID },
      success: HttpApiSchema.NoContent,
      error: loopErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.loop.delete",
        summary: "Delete loop",
        description: "Delete a loop and prevent future scheduled runs.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("loop.runNow", "/api/loop/:loopID/run", {
      params: { loopID: ID },
      success: Run,
      error: loopErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.loop.runNow",
        summary: "Run loop now",
        description: "Start an immediate manual run of a loop.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("loop.runList", "/api/loop/:loopID/run", {
      params: { loopID: ID },
      success: Schema.Array(Run),
      error: LoopNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.loop.run.list",
        summary: "List loop runs",
        description: "List execution history for a loop.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("loop.runGet", "/api/loop/:loopID/run/:runID", {
      params: { loopID: ID, runID: RunID },
      success: Run,
      error: [LoopNotFoundError, LoopRunNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.loop.run.get",
        summary: "Get loop run",
        description: "Retrieve one run from a loop's execution history.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("loop.runCancel", "/api/loop/:loopID/run/:runID/cancel", {
      params: { loopID: ID, runID: RunID },
      success: Run,
      error: [ConflictError, LoopNotFoundError, LoopRunNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.loop.run.cancel",
        summary: "Cancel loop run",
        description: "Cancel a pending or running loop execution.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "loops", description: "Location-scoped recurring prompt loops and run history." }),
  )
