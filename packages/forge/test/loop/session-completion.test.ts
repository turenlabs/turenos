import { expect, test } from "bun:test"
import { Deferred, Effect, Layer, LayerMap, Schema, Stream } from "effect"
import { ForgeEvent } from "@turenlabs/protocol/groups/event"
import { Loop } from "@turenlabs/core/loop"
import { TeamWorkspace } from "@turenlabs/core/team/workspace"
import { Database } from "@turenlabs/core/database/database"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { EventV2 } from "@turenlabs/core/event"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionEvent } from "@turenlabs/schema/session-event"
import { LocationServiceMap } from "@turenlabs/core/location-service-map"
import type { LocationServices } from "@turenlabs/core/location-services"
import { LoopScheduler } from "../../src/loop/scheduler"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Loop.node, TeamWorkspace.node])))
const unexpected = () => Effect.die("Unexpected probe service call")

test("execution settlement encodes on the public SSE event surface", () => {
  const encoded = Schema.encodeSync(ForgeEvent)({
    id: EventV2.ID.create(),
    type: SessionEvent.ExecutionSettled.type,
    data: { sessionID: SessionV2.ID.make("ses_completed"), outcome: "success" },
  })
  expect(encoded.type).toBe(SessionEvent.ExecutionSettled.type)
})

for (const scenario of [
  {
    name: "intermediate tool-call turn is not completion",
    type: SessionEvent.Step.Ended.type,
    outcome: "success",
    finish: "tool-calls",
    expected: 0,
  },
  {
    name: "intermediate stop turn is not completion",
    type: SessionEvent.Step.Ended.type,
    outcome: "success",
    finish: "stop",
    expected: 0,
  },
  {
    name: "intermediate failure is not completion",
    type: SessionEvent.Step.Failed.type,
    outcome: "failure",
    finish: "error",
    expected: 0,
  },
  {
    name: "settled success dispatches",
    type: SessionEvent.ExecutionSettled.type,
    outcome: "success",
    finish: "stop",
    expected: 1,
  },
  {
    name: "settled failure dispatches",
    type: SessionEvent.ExecutionSettled.type,
    outcome: "failure",
    finish: "error",
    expected: 1,
  },
]) {
  it.live(scenario.name, () =>
    Effect.gen(function* () {
      const loops = yield* Loop.Service
      const team = yield* TeamWorkspace.Service
      const directory = "/work/probe-source"
      const info = yield* loops.create({
        name: "session-end probe",
        prompt: "Only when session ends",
        location: { directory: directory },
        eventTrigger: { type: "session-end" },
      })
      const processed = yield* Deferred.make<void>()
      const sessionID = SessionV2.ID.make("ses_probe_source")
      const event = { data: { sessionID, finish: scenario.finish, outcome: scenario.outcome } }
      const dependencies = Layer.mergeAll(
        Layer.succeed(Loop.Service, loops),
        Layer.succeed(TeamWorkspace.Service, team),
        Layer.mock(SessionV2.Service, {
          goal: { get: unexpected, set: unexpected, edit: unexpected, status: unexpected, clear: unexpected },
          revert: { stage: unexpected, clear: unexpected, commit: unexpected },
          get: (id) =>
            id !== sessionID
              ? Effect.fail(new SessionV2.NotFoundError({ sessionID: id }))
              : Effect.succeed({ id: sessionID, location: { directory }, agent: "build" } as SessionV2.Info),
          create: () => Effect.never,
          interrupt: () => Effect.void,
        }),
        Layer.effect(
          LocationServiceMap.Service,
          LayerMap.make(
            (): Layer.Layer<LocationServices> => Layer.effectContext(Effect.die("Unexpected location lookup")),
          ),
        ),
        Layer.mock(EventV2.Service, {
          subscribe: ((definition: { type: string }) =>
            definition.type === SessionEvent.ExecutionSettled.type ||
            definition.type === SessionEvent.Step.Ended.type ||
            definition.type === SessionEvent.Step.Failed.type
              ? Stream.concat(
                  definition.type === scenario.type ? Stream.make(event) : Stream.empty,
                  Stream.fromEffect(Deferred.succeed(processed, undefined)).pipe(Stream.drain),
                ).pipe(Stream.concat(Stream.never))
              : Stream.never) as EventV2.Interface["subscribe"],
        }),
      )
      yield* Layer.build(
        (
          LoopScheduler.node.implementation as Layer.Layer<
            LoopScheduler.Service,
            never,
            Loop.Service | TeamWorkspace.Service | SessionV2.Service | LocationServiceMap.Service | EventV2.Service
          >
        ).pipe(Layer.provide(dependencies)),
      )
      yield* awaitWithTimeout(Deferred.await(processed), "event not processed")
      const runs = yield* loops.listRuns(info.id)
      expect(runs).toHaveLength(scenario.expected)
      if (scenario.expected) expect(runs[0]?.triggerPayload?.outcome).toBe(scenario.outcome)
    }),
  )
}
