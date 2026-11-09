import { describe, expect } from "bun:test"
import { Catalog } from "@turenlabs/core/catalog"
import { Config } from "@turenlabs/core/config"
import { ConfigProviderPlugin } from "@turenlabs/core/config/plugin/provider"
import { ModelV2 } from "@turenlabs/core/model"
import { PluginV2 } from "@turenlabs/core/plugin"
import { PluginHost } from "@turenlabs/core/plugin/host"
import { AntigravityAcpPlugin } from "@turenlabs/core/plugin/provider/antigravity-acp"
import { AntigravityAcpCLI } from "@turenlabs/core/provider/antigravity-acp"
import { AbsolutePath } from "@turenlabs/core/schema"
import { Effect, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const missing = "/turen-missing-antigravity-acp-executable"
const document = (executable: string) =>
  new Config.Document({
    type: "document",
    info: Schema.decodeUnknownSync(Config.Info)({
      providers: { "antigravity-acp": { request: { body: { executable } } } },
    }),
  })

const withExecutable = (executable: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.AGY_ACP_BIN
      process.env.AGY_ACP_BIN = executable
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.AGY_ACP_BIN
        else process.env.AGY_ACP_BIN = previous
      }),
  )

const register = Effect.fnUntraced(function* (entries: Config.Entry[]) {
  const catalog = yield* Catalog.Service
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  const config = Config.Service.of({ entries: () => Effect.succeed(entries) })
  yield* AntigravityAcpPlugin.effect(host).pipe(Effect.provideService(Config.Service, config))
  yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provideService(Config.Service, config))
  return catalog
})

describe("Antigravity ACP catalog executable configuration", () => {
  it.effect("enables a global executable override outside default discovery", () =>
    Effect.gen(function* () {
      yield* withExecutable(missing)
      const catalog = yield* register([document(process.execPath)])
      expect(yield* catalog.provider.get(AntigravityAcpCLI.ID)).toMatchObject({
        disabled: false,
        request: { body: { executable: process.execPath } },
      })
      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toContain(AntigravityAcpCLI.ID)
      expect(yield* catalog.model.get(AntigravityAcpCLI.ID, ModelV2.ID.make("gemini-3.8-flash"))).toMatchObject({
        request: { body: { executable: process.execPath } },
      })
    }),
  )

  it.effect("keeps an invalid explicit path disabled even when environment discovery succeeds", () =>
    Effect.gen(function* () {
      yield* withExecutable(process.execPath)
      const catalog = yield* register([document(missing)])
      expect((yield* catalog.provider.get(AntigravityAcpCLI.ID))?.disabled).toBe(true)
      expect(yield* catalog.provider.available()).toEqual([])
    }),
  )

  it.effect("ignores project-local executable overrides for discovery and launch", () =>
    Effect.gen(function* () {
      yield* withExecutable(process.execPath)
      const catalog = yield* register([
        new Config.Directory({ type: "directory", path: AbsolutePath.make("/global") }),
        document(missing),
      ])
      expect(yield* catalog.provider.get(AntigravityAcpCLI.ID)).toMatchObject({
        disabled: false,
        request: { body: { executable: process.execPath } },
      })
    }),
  )

  it.effect("preserves a global executable across later presentation and project configuration", () =>
    Effect.gen(function* () {
      yield* withExecutable(missing)
      const catalog = yield* register([
        document(process.execPath),
        new Config.Document({
          type: "document",
          info: Schema.decodeUnknownSync(Config.Info)({ providers: { "antigravity-acp": { name: "Configured ACP" } } }),
        }),
        new Config.Directory({ type: "directory", path: AbsolutePath.make("/global") }),
        document(missing),
      ])
      expect(yield* catalog.provider.get(AntigravityAcpCLI.ID)).toMatchObject({
        name: "Configured ACP",
        disabled: false,
        request: { body: { executable: process.execPath } },
      })
    }),
  )

  it.effect("discovers AGY_ACP_BIN when no global executable is configured", () =>
    Effect.gen(function* () {
      yield* withExecutable(process.execPath)
      const catalog = yield* register([])
      expect(yield* catalog.provider.get(AntigravityAcpCLI.ID)).toMatchObject({
        disabled: false,
        request: { body: { executable: process.execPath } },
      })
    }),
  )

  it.effect("rechecks executable availability when catalog configuration reloads", () =>
    Effect.gen(function* () {
      yield* withExecutable(missing)
      const entries = [document(missing)]
      const catalog = yield* register(entries)
      expect((yield* catalog.provider.get(AntigravityAcpCLI.ID))?.disabled).toBe(true)
      entries.splice(0, entries.length, document(process.execPath))
      yield* catalog.reload()
      expect(yield* catalog.provider.get(AntigravityAcpCLI.ID)).toMatchObject({
        disabled: false,
        request: { body: { executable: process.execPath } },
      })
      entries.splice(0, entries.length, document(missing))
      yield* catalog.reload()
      expect((yield* catalog.provider.get(AntigravityAcpCLI.ID))?.disabled).toBe(true)
      expect(yield* catalog.provider.available()).toEqual([])
    }),
  )
})
