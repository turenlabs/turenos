import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@turenlabs/core/catalog"
import { Integration } from "@turenlabs/core/integration"
import { PluginV2 } from "@turenlabs/core/plugin"
import { PluginHost } from "@turenlabs/core/plugin/host"
import { ProviderPlugins } from "@turenlabs/core/plugin/provider"
import { ClaudeCodePlugin, overrideProbe, resetProbeCache } from "@turenlabs/core/plugin/provider/claude-code"
import { ClaudeCodeCLI } from "@turenlabs/core/provider/claude-code"
import { ModelV2 } from "@turenlabs/core/model"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = (result: ClaudeCodeCLI.ProbeResult) =>
  Effect.gen(function* () {
    overrideProbe(() => Promise.resolve(result))
    const plugin = yield* PluginV2.Service
    const host = yield* PluginHost.make(plugin)
    yield* ClaudeCodePlugin.effect(host)
  }).pipe(Effect.ensuring(Effect.sync(() => overrideProbe())))

describe("ClaudeCodePlugin", () => {
  it.effect("is registered so the local CLI provider reaches the v2 catalog", () =>
    Effect.sync(() => expect(ProviderPlugins.map((item) => item.id)).toContain(PluginV2.ID.make("claude-code"))),
  )

  it.effect("registers claude-code when the CLI probes as authenticated", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* addPlugin({ status: "authenticated", executable: "/usr/local/bin/claude" })

      const provider = yield* catalog.provider.get(ClaudeCodeCLI.ID)
      expect(provider?.api).toMatchObject({ type: "native", url: ClaudeCodeCLI.API_URL })
      expect(provider?.request.body[ClaudeCodeCLI.EXECUTABLE_KEY]).toBe("/usr/local/bin/claude")
      expect(provider?.disabled).toBe(false)

      const model = yield* catalog.model.get(ClaudeCodeCLI.ID, ModelV2.ID.make("opus"))
      expect(model?.api).toMatchObject({ type: "native", id: "opus", url: ClaudeCodeCLI.API_URL })
      expect(model?.capabilities.tools).toBe(true)
      expect(model?.enabled).toBe(true)
      // The runner must accept it without any credential — this provider has none.
      expect(SessionRunnerModel.selectable(model!)).toBe(true)
    }),
  )

  it.effect("is available without a credential, unlike every other provider", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      yield* addPlugin({ status: "authenticated", executable: "/usr/local/bin/claude" })

      expect((yield* integrations.list()).map((item) => item.id)).not.toContain(Integration.ID.make("claude-code"))
      expect((yield* catalog.provider.available()).map((item) => item.id)).toContain(ClaudeCodeCLI.ID)
      expect((yield* catalog.model.available()).some((item) => item.providerID === ClaudeCodeCLI.ID)).toBe(true)
    }),
  )

  it.effect("stays visible but unavailable when the CLI is missing or logged out", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* addPlugin({ status: "unauthenticated", executable: "/usr/local/bin/claude" })
      expect((yield* catalog.provider.get(ClaudeCodeCLI.ID))?.disabled).toBe(true)
      expect((yield* catalog.provider.available()).map((item) => item.id)).not.toContain(ClaudeCodeCLI.ID)
      expect((yield* catalog.model.available()).some((item) => item.providerID === ClaudeCodeCLI.ID)).toBe(false)

      yield* addPlugin({ status: "unavailable" })
      expect((yield* catalog.provider.get(ClaudeCodeCLI.ID))?.disabled).toBe(true)
      expect((yield* catalog.provider.available()).map((item) => item.id)).not.toContain(ClaudeCodeCLI.ID)
    }),
  )

  it.effect("reprobes after the cache is reset", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)
      let result: ClaudeCodeCLI.ProbeResult = {
        status: "unauthenticated",
        executable: "/usr/local/bin/claude",
      }
      overrideProbe(() => Promise.resolve(result))

      yield* ClaudeCodePlugin.effect(host)
      expect((yield* catalog.provider.get(ClaudeCodeCLI.ID))?.disabled).toBe(true)

      result = { status: "authenticated", executable: "/usr/local/bin/claude" }
      yield* ClaudeCodePlugin.effect(host)
      expect((yield* catalog.provider.get(ClaudeCodeCLI.ID))?.disabled).toBe(true)

      resetProbeCache()
      yield* ClaudeCodePlugin.effect(host)
      expect((yield* catalog.provider.get(ClaudeCodeCLI.ID))?.disabled).toBe(false)
    }).pipe(Effect.ensuring(Effect.sync(() => overrideProbe()))),
  )

  // The composer builds its effort selector from the v1 snapshot but the turn is
  // resolved against this catalog, so a level offered there and missing here would
  // silently degrade to the model default. Both sides read the same table.
  it.effect("publishes the CLI's effort levels as variants, per model", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* addPlugin({ status: "authenticated", executable: "/usr/local/bin/claude" })

      for (const id of ["fable", "opus", "sonnet"]) {
        const model = yield* catalog.model.get(ClaudeCodeCLI.ID, ModelV2.ID.make(id))
        expect(model?.variants.map((variant) => String(variant.id))).toEqual([...ClaudeCodeCLI.EFFORT_LEVELS])
        expect(model?.variants.map((variant) => variant.body[ClaudeCodeCLI.EFFORT_KEY])).toEqual([
          ...ClaudeCodeCLI.EFFORT_LEVELS,
        ])
      }

      // Haiku 4.5 carries no effort capability in the CLI's own model catalog, so
      // the selector must not offer levels the flag would be refused for.
      const haiku = yield* catalog.model.get(ClaudeCodeCLI.ID, ModelV2.ID.make("haiku"))
      expect(haiku?.variants).toEqual([])
    }),
  )

  it.effect("never becomes the default or small model", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* addPlugin({ status: "authenticated", executable: "/usr/local/bin/claude" })
      // Forking a CLI for background work (titles, summaries) would be a
      // surprise; release time 0 keeps it out of every recency-ranked pick.
      expect(yield* catalog.model.small(ClaudeCodeCLI.ID)).toBeUndefined()
    }),
  )
})
