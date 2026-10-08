import { expect } from "bun:test"
import { Deferred, Effect, Layer, LayerMap, Stream } from "effect"
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

for (const scenario of [
  {
    name: "missing source fails closed on success",
    missing: true,
    other: true,
    failure: false,
    agent: undefined,
    sourceAgent: "build",
    expected: 0,
  },
  {
    name: "missing source fails closed on failure",
    missing: true,
    other: true,
    failure: true,
    agent: undefined,
    sourceAgent: "build",
    expected: 0,
  },
  {
    name: "matching directory dispatches",
    missing: false,
    other: false,
    failure: false,
    agent: undefined,
    sourceAgent: "build",
    expected: 1,
  },
  {
    name: "other directory is ignored",
    missing: false,
    other: true,
    failure: false,
    agent: undefined,
    sourceAgent: "build",
    expected: 0,
  },
  {
    name: "matching agent dispatches failure",
    missing: false,
    other: false,
    failure: true,
    agent: "build",
    sourceAgent: "build",
    expected: 1,
  },
  {
    name: "different agent is ignored",
    missing: false,
    other: false,
    failure: false,
    agent: "plan",
    sourceAgent: "build",
    expected: 0,
  },
  {
    name: "unknown agent cannot satisfy filter",
    missing: false,
    other: false,
    failure: false,
    agent: "build",
    sourceAgent: undefined,
    expected: 0,
  },
  {
    name: "unfiltered loop accepts known session without agent",
    missing: false,
    other: false,
    failure: false,
    agent: undefined,
    sourceAgent: undefined,
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
        location: { directory: scenario.other ? "/work/probe-other" : directory },
        eventTrigger: { type: "session-end", agent: scenario.agent },
      })
      const processed = yield* Deferred.make<void>()
      const sessionID = SessionV2.ID.make("ses_probe_source")
      const event = { data: { sessionID, finish: "stop" } }
      const dependencies = Layer.mergeAll(
        Layer.succeed(Loop.Service, loops),
        Layer.succeed(TeamWorkspace.Service, team),
        Layer.mock(SessionV2.Service, {
          goal: { get: unexpected, set: unexpected, edit: unexpected, status: unexpected, clear: unexpected },
          revert: { stage: unexpected, clear: unexpected, commit: unexpected },
          get: (id) =>
            scenario.missing || id !== sessionID
              ? Effect.fail(new SessionV2.NotFoundError({ sessionID: id }))
              : Effect.succeed({
                  id: sessionID,
                  location: { directory },
                  agent: scenario.sourceAgent,
                } as SessionV2.Info),
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
            definition.type === (scenario.failure ? SessionEvent.Step.Failed.type : SessionEvent.Step.Ended.type)
              ? Stream.concat(
                  Stream.make(event),
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
    }),
  )
}
