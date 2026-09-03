export * as AutomationTool from "./automation"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { AgentV2 } from "../agent"
import { Location } from "../location"
import { Loop } from "../loop"
import { ModelV2 } from "../model"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const listName = "automation_list"
export const createName = "automation_create"
export const updateName = "automation_update"

const StepInput = Schema.Struct({
  name: Schema.String.annotate({
    description:
      "Short step name. Its binding ID is derived from this by lowercasing and replacing runs of non-alphanumerics with underscores.",
  }),
  task: Schema.String.annotate({
    description:
      "What this step does. Reference an earlier step with {{ steps.<id>.output }} or {{ steps.<id>.artifacts }}, and the trigger with {{ trigger.type }} or {{ trigger.scheduledAt }}. Only earlier steps may be referenced.",
  }),
  skill: Schema.String.pipe(Schema.optional).annotate({
    description: "Run this named skill for the step, using task as its instructions. Omit for a plain agent turn.",
  }),
  agent: Schema.String.pipe(Schema.optional).annotate({
    description: "Agent to run this step. Omit to inherit the Automation's agent.",
  }),
  model: ModelV2.Ref.pipe(Schema.optional).annotate({
    description: "Provider, model, and optional effort variant for this step. Omit to inherit the Automation's model.",
  }),
})

const Step = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.Literals(["agent", "skill"]),
  task: Schema.String,
  skill: Schema.NullOr(Schema.String),
  agent: Schema.NullOr(Schema.String),
  model: Schema.NullOr(ModelV2.Ref),
})

const Automation = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["active", "paused", "expired"]),
  interval_seconds: Schema.Number,
  next_run_at: Schema.NullOr(Schema.Number),
  expires_at: Schema.Number,
  directory: Schema.String,
  agent: Schema.NullOr(Schema.String),
  model: Schema.NullOr(ModelV2.Ref),
  steps: Schema.Array(Step),
}).annotate({ identifier: "AutomationTool.Automation" })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const loops = yield* Loop.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    const assert = (input: {
      readonly action: string
      readonly resource: string
      readonly context: Tool.Context
      readonly metadata: Record<string, unknown>
    }) =>
      permission
        .assert({
          action: input.action,
          resources: [input.resource],
          save: ["*"],
          metadata: input.metadata,
          sessionID: input.context.sessionID,
          agent: input.context.agent,
          source: { type: "tool", messageID: input.context.assistantMessageID, callID: input.context.toolCallID },
        })
        .pipe(Effect.mapError(() => new ToolFailure({ message: `Permission to run ${input.action} was declined` })))

    yield* tools
      .register({
        [listName]: Tool.make({
          description:
            "List this machine's Automations: durable scheduled workflows that run on a repeating interval in their own session. Use this before creating or changing one so you know what already exists.",
          input: Schema.Struct({}),
          output: Schema.Array(Automation),
          execute: () => loops.list().pipe(Effect.map((infos) => infos.map(toAutomation))),
        }),
        [createName]: Tool.make({
          description: `Create one Automation: a repeating interval trigger plus 1 to 12 ordered steps that run in their own session and deliver back to the user.
Only create an Automation when the user asked for recurring or scheduled work; a one-off task belongs in this session.
The interval must be at least ${Loop.MIN_INTERVAL_SECONDS} seconds, an Automation stops running after seven days, and at most ${Loop.MAX_ACTIVE} may be active at once. Report the returned id and expiry to the user.`,
          input: Schema.Struct({
            name: Schema.String.annotate({ description: "Short name identifying the Automation to the user." }),
            interval_seconds: Schema.Int.annotate({
              description: `How often the Automation runs, in seconds. Minimum ${Loop.MIN_INTERVAL_SECONDS}.`,
            }),
            steps: Schema.Array(StepInput).annotate({
              description:
                "Ordered steps, 1 to 12. Each runs as its own turn and its output is readable by later steps.",
            }),
            directory: Schema.String.pipe(Schema.optional).annotate({
              description: "Absolute project directory the Automation runs in. Defaults to this session's directory.",
            }),
            agent: Schema.String.pipe(Schema.optional).annotate({
              description: "Agent every step inherits unless the step overrides it.",
            }),
            model: ModelV2.Ref.pipe(Schema.optional).annotate({
              description: "Provider, model, and optional effort variant every step inherits unless overridden.",
            }),
            paused: Schema.Boolean.pipe(Schema.optional).annotate({
              description: "Create the Automation without scheduling it. Omit to start it immediately.",
            }),
          }),
          output: Automation,
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.steps.length === 0)
                return yield* new ToolFailure({ message: "An Automation requires at least one step" })
              yield* assert({
                action: createName,
                resource: input.name,
                context,
                metadata: {
                  name: input.name,
                  intervalSeconds: input.interval_seconds,
                  steps: input.steps.length,
                  directory: input.directory ?? location.directory,
                },
              })
              const created = yield* loops
                .create({
                  name: input.name,
                  // The durable row still carries a legacy single prompt alongside the workflow; the
                  // first step's task is what a pre-workflow reader would have run.
                  prompt: input.steps[0].task,
                  location: input.directory
                    ? { directory: input.directory }
                    : {
                        directory: location.directory,
                        ...(location.workspaceID ? { workspaceID: location.workspaceID } : {}),
                      },
                  ...(input.agent ? { agent: AgentV2.ID.make(input.agent) } : {}),
                  ...(input.model ? { model: input.model } : {}),
                  workflow: toWorkflow(input.steps),
                  intervalSeconds: input.interval_seconds,
                  ...(input.paused === undefined ? {} : { paused: input.paused }),
                })
                .pipe(Effect.mapError(toolFailure))
              return toAutomation(created)
            }),
        }),
        [updateName]: Tool.make({
          description:
            "Change one existing Automation: rename it, change its interval, inherited agent/model, replace its steps, or pause, resume, or delete it. Replacing steps replaces the whole ordered list. Returns null when the Automation was deleted.",
          input: Schema.Struct({
            id: Schema.String.annotate({ description: `Automation id, as returned by ${listName}.` }),
            name: Schema.String.pipe(Schema.optional),
            interval_seconds: Schema.Int.pipe(Schema.optional).annotate({
              description: `New interval in seconds. Minimum ${Loop.MIN_INTERVAL_SECONDS}.`,
            }),
            steps: Schema.Array(StepInput).pipe(Schema.optional).annotate({
              description: "Replacement ordered steps, 1 to 12. Omit to leave the existing steps alone.",
            }),
            agent: Schema.NullOr(Schema.String).pipe(Schema.optional).annotate({
              description: "New inherited agent. Pass null to reset it.",
            }),
            model: Schema.NullOr(ModelV2.Ref).pipe(Schema.optional).annotate({
              description: "New inherited provider, model, and optional effort variant. Pass null to reset it.",
            }),
            status: Schema.Literals(["active", "paused", "deleted"]).pipe(Schema.optional).annotate({
              description: "Resume, pause, or delete the Automation. Omit to leave its status alone.",
            }),
          }),
          output: Schema.NullOr(Automation),
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.steps !== undefined && input.steps.length === 0)
                return yield* new ToolFailure({ message: "An Automation requires at least one step" })
              yield* assert({
                action: updateName,
                resource: input.id,
                context,
                metadata: { id: input.id, status: input.status, steps: input.steps?.length },
              })
              if (input.status === "deleted") {
                const deleted = yield* loops.delete(input.id).pipe(Effect.mapError(toolFailure))
                if (!deleted) return yield* new ToolFailure({ message: `No Automation with id ${input.id}` })
                return null
              }
              const edited = yield* editOrGet(loops, input).pipe(Effect.mapError(toolFailure))
              if (input.status === "paused" && edited.status === "active")
                return toAutomation(yield* loops.pause(input.id).pipe(Effect.mapError(toolFailure)))
              if (input.status === "active" && edited.status === "paused")
                return toAutomation(yield* loops.resume(input.id).pipe(Effect.mapError(toolFailure)))
              return toAutomation(edited)
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

const editOrGet = (
  loops: Loop.Interface,
  input: {
    readonly id: string
    readonly name?: string
    readonly interval_seconds?: number
    readonly steps?: ReadonlyArray<typeof StepInput.Type>
    readonly agent?: string | null
    readonly model?: ModelV2.Ref | null
  },
) => {
  if (
    input.name === undefined &&
    input.interval_seconds === undefined &&
    input.steps === undefined &&
    input.agent === undefined &&
    input.model === undefined
  )
    return loops.get(input.id)
  return loops.edit({
    id: input.id,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.interval_seconds === undefined ? {} : { intervalSeconds: input.interval_seconds }),
    ...(input.steps === undefined ? {} : { prompt: input.steps[0].task, workflow: toWorkflow(input.steps) }),
    ...(input.agent === null
      ? { resetAgent: true }
      : input.agent === undefined
        ? {}
        : { agent: AgentV2.ID.make(input.agent) }),
    ...(input.model === null ? { resetModel: true } : input.model === undefined ? {} : { model: input.model }),
  })
}

const toWorkflow = (steps: ReadonlyArray<typeof StepInput.Type>): Loop.Workflow => {
  const taken: string[] = []
  return {
    version: 1,
    delivery: { type: "turen" },
    steps: steps.map((step) => {
      const id = deriveStepID(step.name, taken)
      taken.push(id)
      const execution = {
        ...(step.agent === undefined ? {} : { agent: AgentV2.ID.make(step.agent) }),
        ...(step.model === undefined ? {} : { model: step.model }),
      }
      if (step.skill === undefined)
        return { id, name: step.name, type: "agent" as const, prompt: step.task, ...execution }
      return { id, name: step.name, type: "skill" as const, skill: step.skill, instructions: step.task, ...execution }
    }),
  }
}

/** Mirrors the builder's derivation so a step's binding ID stays readable and matches `^[A-Za-z][A-Za-z0-9_-]*$`. */
const deriveStepID = (name: string, taken: ReadonlyArray<string>) => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^[^a-z]+/, "")
      .replace(/_+$/, "") || "step"
  if (!taken.includes(base)) return base
  let suffix = 2
  while (taken.includes(`${base}_${suffix}`)) suffix++
  return `${base}_${suffix}`
}

const toStep = (step: Loop.WorkflowStep) => ({
  id: step.id,
  name: step.name,
  type: step.type,
  task: step.type === "agent" ? step.prompt : step.instructions,
  skill: step.type === "skill" ? step.skill : null,
  agent: step.agent ?? null,
  model: step.model ?? null,
})

const toAutomation = (info: Loop.Info) => ({
  id: info.id,
  name: info.name,
  status: info.status,
  interval_seconds: info.schedule.seconds,
  next_run_at: info.nextRunAt ?? null,
  expires_at: info.expiresAt,
  directory: info.location.directory,
  agent: info.agent ?? null,
  model: info.model ?? null,
  // Automations created before workflows existed carry a single prompt instead of steps.
  steps: info.workflow
    ? info.workflow.steps.map(toStep)
    : [
        {
          id: "step",
          name: info.name,
          type: info.skill ? ("skill" as const) : ("agent" as const),
          task: info.prompt,
          skill: info.skill ?? null,
          agent: info.agent ?? null,
          model: info.model ?? null,
        },
      ],
})

function toolFailure(
  error:
    | Loop.NotFoundError
    | Loop.InvalidInputError
    | Loop.ActiveLimitError
    | Loop.InvalidStateError
    | Loop.RunNotFoundError,
) {
  if (error._tag === "LoopNotFoundError" || error._tag === "LoopRunNotFoundError")
    return new ToolFailure({ message: `No Automation with id ${error.id}` })
  if (error._tag === "LoopActiveLimitError")
    return new ToolFailure({ message: `At most ${error.limit} Automations may be active at once` })
  return new ToolFailure({ message: error.message })
}

export const node = makeLocationNode({
  name: "tool/automation",
  layer,
  deps: [ToolRegistry.node, Loop.node, Location.node, PermissionV2.node],
})
