export * as ReflectionTool from "./reflection"

import { ToolFailure } from "@turenlabs/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Reflection } from "../reflection"
import { SessionStore } from "../session/store"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"

export const stateName = "reflection_state"
export const readName = "reflection_read"
export const completeName = "reflection_complete"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const reflection = yield* Reflection.Service
    const sessions = yield* SessionStore.Service

    yield* tools
      .register({
        [readName]: Tool.make({
          description:
            "Read the current session's durable prediction and hypotheses before updating or evaluating them.",
          input: Schema.Struct({}),
          output: Schema.NullOr(Reflection.WorkState),
          execute: (_, context) =>
            reflection.work(context.sessionID).pipe(
              Effect.map((state) => state ?? null),
              Effect.mapError(() => new ToolFailure({ message: "Unable to read reflection state" })),
            ),
        }),
        [stateName]: Tool.make({
          description:
            "Persist the current prediction, explicit hypotheses, and next action before uncertain work; update it after external results so assumptions are resolved against evidence.",
          input: Schema.Struct({
            prediction: Reflection.WorkState.fields.prediction,
            hypotheses: Reflection.WorkState.fields.hypotheses,
            next_action: Reflection.WorkState.fields.nextAction,
          }),
          output: Reflection.WorkState,
          execute: (input, context) =>
            reflection
              .updateWork(context.sessionID, {
                prediction: input.prediction,
                hypotheses: input.hypotheses,
                nextAction: input.next_action,
              })
              .pipe(Effect.mapError(() => new ToolFailure({ message: "Unable to persist reflection state" }))),
        }),
        [completeName]: Tool.make({
          description:
            "Complete a due TurenOS self-reflection checkpoint after comparing predictions and hypotheses with external results and writing any stable cross-session memories.",
          input: Reflection.ReflectionInput,
          output: Schema.Struct({ completed: Schema.Boolean }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const session = yield* sessions.get(context.sessionID)
              if (!session) return yield* new ToolFailure({ message: "Session not found" })
              const completed = yield* reflection.complete(session, input)
              if (!completed)
                return yield* new ToolFailure({ message: "No reflection checkpoint is due for this Session" })
              return { completed }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/reflection",
  layer,
  deps: [ToolRegistry.node, Reflection.node, SessionStore.node],
})
