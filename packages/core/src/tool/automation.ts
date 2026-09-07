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
  when: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Skip this step when the condition resolves to a falsy value (false, 0, no, off, empty). Bindings like {{ steps.<id>.output }} and {{ trigger.payload.<field> }} are resolved before evaluation. Omit to always run.",
  }),
  on_failure: Schema.Literals(["stop", "continue"]).pipe(Schema.optional).annotate({
    description: "What to do when this step fails. Stop fails the run, continue records the error and runs the next step. Omit to stop.",
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
  when: Schema.NullOr(Schema.String),
  on_failure: Schema.NullOr(Schema.Literals(["stop", "continue"])),
})

const FileChangeTriggerInput = Schema.Struct({
  type: Schema.Literal("file-change"),
  paths: Schema.Array(Schema.String).annotate({
    description: "Relative glob patterns under the Automation directory, e.g. ['src/**/*.ts'].",
  }),
  debounceMs: Schema.Number.pipe(Schema.optional).annotate({
    description: "Coalesce rapid file events for this many milliseconds. Defaults to 1000, max 60000.",
  }),
})

const SessionEndTriggerInput = Schema.Struct({
  type: Schema.Literal("session-end"),
  outcomes: Schema.Array(Schema.Literals(["success", "failure"])).pipe(Schema.optional).annotate({
    description: "Only fire for these session outcomes. Omit for both.",
  }),
  sessionID: Schema.String.pipe(Schema.optional).annotate({
    description: "Only fire for this session ID. Omit for any local session in the Automation directory.",
  }),
  agent: Schema.String.pipe(Schema.optional).annotate({
    description: "Only fire for sessions running this agent. Omit for any agent.",
  }),
})

const EventTriggerInput = Schema.Union([FileChangeTriggerInput, SessionEndTriggerInput])

const Automation = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["active", "paused", "expired"]),
  interval_seconds: Schema.Number,
  cron_expression: Schema.NullOr(Schema.String),
  schedule_type: Schema.Literals(["interval", "cron"]),
  timezone: Schema.String,
  event_trigger: Schema.NullOr(EventTriggerInput),
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
          description: `Create one Automation: a repeating interval or cron trigger, or a local file-change or session-end event trigger, plus 1 to 12 ordered steps that run in their own session and deliver back to the user.
Only create an Automation when the user asked for recurring, scheduled, or event-driven work; a one-off task belongs in this session.
The interval must be at least ${Loop.MIN_INTERVAL_SECONDS} seconds, cron uses five fields like '*/5 * * * *', an Automation stops running after seven days, and at most ${Loop.MAX_ACTIVE} may be active at once. Report the returned id and expiry to the user.`,
          input: Schema.Struct({
            name: Schema.String.annotate({ description: "Short name identifying the Automation to the user." }),
            interval_seconds: Schema.Int.pipe(Schema.optional).annotate({
              description: `How often the Automation runs, in seconds. Minimum ${Loop.MIN_INTERVAL_SECONDS}. Provide exactly one of interval_seconds, cron_expression, or event_trigger.`,
            }),
            cron_expression: Schema.String.pipe(Schema.optional).annotate({
              description: "Cron schedule in five fields (minute hour day month weekday), e.g. '0 9 * * MON-FRI'.",
            }),
            event_trigger: EventTriggerInput.pipe(Schema.optional).annotate({
              description: "Local event trigger (file-change or session-end). No network triggers are supported.",
            }),
            timezone: Schema.String.pipe(Schema.optional).annotate({
              description: "IANA timezone for cron fire times, e.g. 'America/New_York'. Defaults to UTC.",
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
                  cronExpression: input.cron_expression,
                  eventTrigger: input.event_trigger?.type,
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
                  ...(input.interval_seconds === undefined ? {} : { intervalSeconds: input.interval_seconds }),
                  ...(input.cron_expression === undefined ? {} : { cronExpression: input.cron_expression }),
                  ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
                  ...(input.event_trigger === undefined
                    ? {}
                    : { eventTrigger: toEventTrigger(input.event_trigger) }),
                  ...(input.paused === undefined ? {} : { paused: input.paused }),
                })
                .pipe(Effect.mapError(toolFailure))
              return toAutomation(created)
            }),
        }),
        [updateName]: Tool.make({
          description:
            "Change one existing Automation: rename it, change its interval, cron, or event trigger, inherited agent/model, replace its steps, or pause, resume, or delete it. Replacing steps replaces the whole ordered list. Returns null when the Automation was deleted.",
          input: Schema.Struct({
            id: Schema.String.annotate({ description: `Automation id, as returned by ${listName}.` }),
            name: Schema.String.pipe(Schema.optional),
            interval_seconds: Schema.Int.pipe(Schema.optional).annotate({
              description: `New interval in seconds. Minimum ${Loop.MIN_INTERVAL_SECONDS}. Provide at most one of interval_seconds, cron_expression, event_trigger.`,
            }),
            cron_expression: Schema.String.pipe(Schema.optional).annotate({
              description: "New cron schedule in five fields. Provide at most one schedule field.",
            }),
            event_trigger: EventTriggerInput.pipe(Schema.optional).annotate({
              description: "New local event trigger. Provide at most one schedule field.",
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
    readonly cron_expression?: string
    readonly event_trigger?: typeof EventTriggerInput.Type
    readonly steps?: ReadonlyArray<typeof StepInput.Type>
    readonly agent?: string | null
    readonly model?: ModelV2.Ref | null
  },
) => {
  if (
    input.name === undefined &&
    input.interval_seconds === undefined &&
    input.cron_expression === undefined &&
    input.event_trigger === undefined &&
    input.steps === undefined &&
    input.agent === undefined &&
    input.model === undefined
  )
    return loops.get(input.id)
  return loops.edit({
    id: input.id,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.interval_seconds === undefined ? {} : { intervalSeconds: input.interval_seconds }),
    ...(input.cron_expression === undefined ? {} : { cronExpression: input.cron_expression }),
    ...(input.event_trigger === undefined ? {} : { eventTrigger: toEventTrigger(input.event_trigger) }),
    ...(input.steps === undefined ? {} : { prompt: input.steps[0].task, workflow: toWorkflow(input.steps) }),
    ...(input.agent === null
      ? { resetAgent: true }
      : input.agent === undefined
        ? {}
        : { agent: AgentV2.ID.make(input.agent) }),
    ...(input.model === null ? { resetModel: true } : input.model === undefined ? {} : { model: input.model }),
  })
}

const toEventTrigger = (trigger: typeof EventTriggerInput.Type): Loop.EventTriggerConfig => {
  if (trigger.type === "file-change")
    return {
      type: "file-change",
      paths: [...trigger.paths],
      ...(trigger.debounceMs === undefined ? {} : { debounceMs: trigger.debounceMs }),
    }
  return {
    type: "session-end",
    ...(trigger.outcomes === undefined ? {} : { outcomes: [...trigger.outcomes] }),
    ...(trigger.sessionID === undefined ? {} : { sessionID: trigger.sessionID }),
    ...(trigger.agent === undefined ? {} : { agent: trigger.agent }),
  }
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
      const condition = {
        ...(step.when === undefined ? {} : { when: step.when }),
        ...(step.on_failure === undefined ? {} : { onFailure: step.on_failure }),
      }
      if (step.skill === undefined)
        return { id, name: step.name, type: "agent" as const, prompt: step.task, ...execution, ...condition }
      return {
        id,
        name: step.name,
        type: "skill" as const,
        skill: step.skill,
        instructions: step.task,
        ...execution,
        ...condition,
      }
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
  when: step.when ?? null,
  on_failure: step.onFailure ?? null,
})

const toAutomation = (info: Loop.Info) => ({
  id: info.id,
  name: info.name,
  status: info.status,
  interval_seconds: info.schedule.seconds,
  cron_expression: info.schedule.type === "cron" ? info.schedule.expression : null,
  schedule_type: info.schedule.type,
  timezone: info.schedule.timezone,
  event_trigger: info.eventTrigger
    ? info.eventTrigger.type === "file-change"
      ? {
          type: "file-change" as const,
          paths: [...info.eventTrigger.paths],
          ...(info.eventTrigger.debounceMs === undefined ? {} : { debounceMs: info.eventTrigger.debounceMs }),
        }
      : {
          type: "session-end" as const,
          ...(info.eventTrigger.outcomes === undefined ? {} : { outcomes: [...info.eventTrigger.outcomes] }),
          ...(info.eventTrigger.sessionID === undefined ? {} : { sessionID: info.eventTrigger.sessionID }),
          ...(info.eventTrigger.agent === undefined ? {} : { agent: info.eventTrigger.agent }),
        }
    : null,
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
          when: null,
          on_failure: null,
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
