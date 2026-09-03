export * as GoalTool from "./goal"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SessionGoalAccounting } from "../session/goal-accounting"
import { SessionGoal } from "../session/goal"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"

export const getName = "get_goal"
export const createName = "create_goal"
export const updateName = "update_goal"

const Response = Schema.Struct({
  goal: Schema.NullOr(SessionGoal.Info),
})

const response = (goal: SessionGoal.Info | undefined) => ({
  goal: goal ?? null,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const goals = yield* SessionGoal.Service
    const accounting = yield* SessionGoalAccounting.Service

    yield* tools
      .register({
        [getName]: Tool.make({
          description: "Get the current goal for this session, including status and accumulated usage.",
          input: Schema.Struct({}),
          output: Response,
          execute: (_, context) =>
            goals.get(context.sessionID).pipe(Effect.map(response), Effect.mapError(toolFailure)),
        }),
        [createName]: Tool.make({
          description: `Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.
Fails if an unfinished goal exists; pass replace true when the user explicitly asks to switch goals, and use ${updateName} only for status.`,
          input: Schema.Struct({
            objective: Schema.String.annotate({
              description:
                "Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.",
            }),
            replace: Schema.optional(
              Schema.Boolean.annotate({
                description:
                  "Set true to clear an existing unfinished goal and start this one in its place. Only when the user explicitly asked to change the goal.",
              }),
            ),
          }),
          output: Response,
          execute: (input, context) =>
            Effect.gen(function* () {
              const objective = yield* Schema.decodeUnknownEffect(SessionGoal.Objective)(input.objective.trim()).pipe(
                Effect.mapError((error) => new ToolFailure({ message: `Invalid goal objective: ${error.message}` })),
              )
              if (input.replace === true) {
                // Compare-and-swap on the goal the model saw: a concurrent
                // revision change fails the clear instead of clobbering it.
                const current = yield* goals.get(context.sessionID).pipe(Effect.mapError(toolFailure))
                if (current && current.status !== "complete")
                  yield* goals
                    .clear({ sessionID: context.sessionID, goalID: current.id, expectedRevision: current.revision })
                    .pipe(Effect.mapError(toolFailure))
              }
              const goal = yield* goals
                .create({
                  sessionID: context.sessionID,
                  objective,
                })
                .pipe(Effect.mapError(toolFailure))
              return response(goal)
            }),
        }),
        [updateName]: Tool.make({
          description: `Update the existing goal.
Use this tool only to mark the goal achieved or genuinely blocked.
Set status to complete only when the objective has actually been achieved and no required work remains.
Set status to blocked only when the same blocking condition has repeated for at least three consecutive goal turns, including the original or resumed turn, and no meaningful progress is possible without user input or an external-state change.
Do not use blocked merely because the work is hard, slow, uncertain, incomplete, or would benefit from clarification.
Do not mark a goal complete merely because work is stopping.
Pause, resume, clear, and usage-limit changes are controlled by the user or system.`,
          input: Schema.Struct({
            status: Schema.Literals(["complete", "blocked"]).annotate({
              description:
                "Set complete only after the full objective is achieved. Set blocked only after the same genuine blocker repeats for at least three consecutive goal turns.",
            }),
          }),
          output: Response,
          execute: (input, context) =>
            Effect.gen(function* () {
              const current = yield* goals.get(context.sessionID).pipe(Effect.mapError(toolFailure))
              if (!current)
                return yield* new ToolFailure({ message: "Cannot update a goal because this session has no goal" })
              const checkpointed =
                (yield* accounting.awaitCheckpoint({ sessionID: context.sessionID, goalID: current.id })) ?? current
              const goal = yield* goals
                .status({
                  sessionID: context.sessionID,
                  goalID: checkpointed.id,
                  expectedRevision: checkpointed.revision,
                  status: input.status,
                })
                .pipe(Effect.mapError(toolFailure))
              return response(goal)
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

function toolFailure(error: SessionGoal.NotFoundError | SessionGoal.ConflictError | SessionGoal.InvalidStateError) {
  if ("message" in error) return new ToolFailure({ message: error.message })
  return new ToolFailure({ message: "Goal or session not found" })
}

export const node = makeLocationNode({
  name: "tool/goal",
  layer,
  deps: [ToolRegistry.node, SessionGoal.node, SessionGoalAccounting.node],
})
