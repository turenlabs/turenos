import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { AgentV2 } from "@turenlabs/core/agent"
import { PluginV2 } from "@turenlabs/core/plugin"
import { PluginHost } from "@turenlabs/core/plugin/host"
import { PluginPromise } from "@turenlabs/core/plugin/promise"
import { define } from "@turenlabs/plugin/v2/promise"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

describe("fromPromise", () => {
  it.effect("resolves plugin waiters after state transforms are committed", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const plugin = yield* PluginV2.Service
      const id = PluginV2.ID.make("wait-after-state")
      const observed = yield* Deferred.make<AgentV2.Info | undefined>()
      const waiting = yield* plugin.wait(id).pipe(
        Effect.andThen(agents.get(AgentV2.ID.make("waited-agent"))),
        Effect.flatMap((value) => Deferred.succeed(observed, value)),
        Effect.forkChild,
      )
      yield* Effect.yieldNow

      yield* plugin.add(id, (context) =>
        context.agent
          .transform((draft) => {
            draft.update(AgentV2.ID.make("waited-agent"), (agent) => {
              agent.mode = "subagent"
            })
          })
          .pipe(Effect.asVoid),
      )

      expect(yield* Deferred.await(observed)).toMatchObject({ id: AgentV2.ID.make("waited-agent"), mode: "subagent" })
      yield* Fiber.join(waiting)
    }),
  )

  it.effect("loads a promise plugin and registers a transform hook", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      const promisePlugin = define({
        id: "promise-example",
        setup: async (ctx) => {
          expect(ctx.options.mode).toBe("strict")
          await ctx.agent.transform((draft) => {
            draft.update("reviewer", (item) => {
              item.description = "Reviews code"
              item.mode = "subagent"
            })
          })
        },
      })

      const adapted = PluginPromise.fromPromise(promisePlugin)
      yield* adapted.effect({ ...host, options: { mode: "strict" } })

      expect(yield* agents.get(AgentV2.ID.make("reviewer"))).toMatchObject({
        description: "Reviews code",
        mode: "subagent",
      })
    }),
  )

  it.effect("disposes a hook registration on request", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      const promisePlugin = define({
        id: "promise-dispose",
        setup: async (ctx) => {
          const registration = await ctx.agent.transform((draft) => {
            draft.update("temp", (item) => {
              item.description = "temporary"
            })
          })
          await registration.dispose()
        },
      })

      const adapted = PluginPromise.fromPromise(promisePlugin)
      yield* adapted.effect(host)

      expect(yield* agents.get(AgentV2.ID.make("temp"))).toBeUndefined()
    }),
  )
})
