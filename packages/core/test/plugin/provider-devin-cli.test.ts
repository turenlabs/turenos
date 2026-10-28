import { describe, expect } from "bun:test"
import { Catalog } from "@turenlabs/core/catalog"
import { Config } from "@turenlabs/core/config"
import { Integration } from "@turenlabs/core/integration"
import { ModelV2 } from "@turenlabs/core/model"
import { PluginV2 } from "@turenlabs/core/plugin"
import { PluginHost } from "@turenlabs/core/plugin/host"
import { ProviderPlugins } from "@turenlabs/core/plugin/provider"
import { DevinCLIPlugin } from "@turenlabs/core/plugin/provider/devin-cli"
import { DevinCLI } from "@turenlabs/core/provider/devin-cli"
import { AbsolutePath } from "@turenlabs/core/schema"
import { Effect, Schema } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const decode = Schema.decodeUnknownSync(Config.Info)

const configured = (executable: string) =>
  new Config.Document({
    type: "document",
    info: decode({ providers: { [DevinCLI.ID]: { request: { body: { [DevinCLI.EXECUTABLE_KEY]: executable } } } } }),
  })

const addPlugin = Effect.fnUntraced(function* (entries: Config.Entry[] = []) {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* DevinCLIPlugin.effect(host).pipe(
    Effect.provideService(Config.Service, Config.Service.of({ entries: () => Effect.succeed(entries) })),
  )
})

const withExecutable = Effect.fnUntraced(function* (name = "custom-devin") {
  const directory = yield* Effect.acquireRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "provider-devin-cli-"))),
    (directory) => Effect.sync(() => fs.rmSync(directory, { recursive: true, force: true })),
  )
  const executable = path.join(directory, process.platform === "win32" ? `${name}.cmd` : name)
  const marker = path.join(directory, "invoked")
  fs.writeFileSync(
    executable,
    process.platform === "win32"
      ? `@echo off\r\necho called > "${marker}"\r\nexit /b 1\r\n`
      : `#!/bin/sh\nprintf called > ${JSON.stringify(marker)}\nexit 1\n`,
    { mode: 0o755 },
  )
  return { directory, executable, marker }
})

describe("DevinCLIPlugin", () => {
  it.effect("is registered in the provider plugin list", () =>
    Effect.sync(() => expect(ProviderPlugins.map((item) => item.id)).toContain("devin-cli")),
  )

  it.effect("resolves a trimmed executable path and rejects non-executable files", () =>
    Effect.gen(function* () {
      const fixture = yield* withExecutable()
      expect(DevinCLI.resolveExecutable(`  ${fixture.executable}  `)).toBe(fixture.executable)
      expect(yield* Effect.promise(() => DevinCLI.probe(fixture.executable))).toEqual({
        status: "installed",
        executable: fixture.executable,
      })
      expect(fs.existsSync(fixture.marker)).toBe(false)
      if (process.platform === "win32") return
      fs.chmodSync(fixture.executable, 0o644)
      expect(yield* Effect.promise(() => DevinCLI.probe(fixture.executable))).toEqual({ status: "unavailable" })
    }),
  )

  it.effect("publishes the default model without a credential or CLI invocation", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      const fixture = yield* withExecutable()
      yield* addPlugin([configured(fixture.executable)])

      expect(yield* catalog.provider.get(DevinCLI.ID)).toMatchObject({
        name: "Devin CLI (local)",
        disabled: false,
        api: { type: "native", url: "local://devin-cli" },
        request: { body: { executable: fixture.executable } },
      })
      expect((yield* integrations.list()).map((item) => item.id)).not.toContain(Integration.ID.make("devin-cli"))
      expect((yield* catalog.provider.available()).map((item) => item.id)).toContain(DevinCLI.ID)
      const models = (yield* catalog.model.available()).filter((item) => item.providerID === DevinCLI.ID)
      expect(models.map((item) => item.id)).toEqual([ModelV2.ID.make("default")])
      expect(models[0]).toMatchObject({
        name: "Devin default",
        api: { type: "native", id: "default", url: "local://devin-cli" },
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: [],
        cost: [],
        status: "active",
        enabled: true,
        time: { released: 0 },
        limit: { context: 32_768, output: 8_192 },
      })
      expect(yield* catalog.model.small(DevinCLI.ID)).toBeUndefined()
      expect(fs.existsSync(fixture.marker)).toBe(false)
    }),
  )

  it.effect("keeps a missing executable visible but catalog-disabled", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const fixture = yield* withExecutable()
      fs.unlinkSync(fixture.executable)
      yield* addPlugin([configured(fixture.executable)])

      const provider = yield* catalog.provider.get(DevinCLI.ID)
      expect(provider?.disabled).toBe(true)
      expect(provider?.request.body[DevinCLI.EXECUTABLE_KEY]).toBeUndefined()
      expect((yield* catalog.provider.all()).map((item) => item.id)).toContain(DevinCLI.ID)
      expect((yield* catalog.provider.available()).map((item) => item.id)).not.toContain(DevinCLI.ID)
      expect((yield* catalog.model.available()).some((item) => item.providerID === DevinCLI.ID)).toBe(false)
      expect(yield* catalog.model.get(DevinCLI.ID, ModelV2.ID.make("default"))).toBeDefined()
      expect(fs.existsSync(fixture.marker)).toBe(false)
    }),
  )

  it.effect("rechecks installation and removes a stale executable on catalog reload", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const fixture = yield* withExecutable()
      yield* addPlugin([configured(fixture.executable)])
      expect((yield* catalog.provider.get(DevinCLI.ID))?.disabled).toBe(false)

      fs.unlinkSync(fixture.executable)
      yield* catalog.reload()
      const provider = yield* catalog.provider.get(DevinCLI.ID)
      expect(provider?.disabled).toBe(true)
      expect(provider?.request.body[DevinCLI.EXECUTABLE_KEY]).toBeUndefined()
      expect((yield* catalog.model.available()).some((item) => item.providerID === DevinCLI.ID)).toBe(false)
    }),
  )

  it.effect("uses the last global executable and ignores project executable overrides", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const fixture = yield* withExecutable()
      yield* addPlugin([
        configured(path.join(fixture.directory, "missing-global")),
        configured(fixture.executable),
        new Config.Directory({ type: "directory", path: AbsolutePath.make(fixture.directory) }),
        configured(path.join(fixture.directory, "missing-project")),
      ])

      const provider = yield* catalog.provider.get(DevinCLI.ID)
      expect(provider?.disabled).toBe(false)
      expect(provider?.request.body[DevinCLI.EXECUTABLE_KEY]).toBe(fixture.executable)
      expect(fs.existsSync(fixture.marker)).toBe(false)
    }),
  )

  it.effect("does not enable a project executable when the global executable is missing", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const fixture = yield* withExecutable()
      yield* addPlugin([
        configured(path.join(fixture.directory, "missing-global")),
        new Config.Directory({ type: "directory", path: AbsolutePath.make(fixture.directory) }),
        configured(fixture.executable),
      ])

      expect((yield* catalog.provider.get(DevinCLI.ID))?.disabled).toBe(true)
      expect(fs.existsSync(fixture.marker)).toBe(false)
    }),
  )

  it.effect("discovers devin on PATH when no executable is configured", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const fixture = yield* withExecutable("devin")
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env.PATH
          process.env.PATH = `${fixture.directory}${path.delimiter}${previous ?? ""}`
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) {
              delete process.env.PATH
              return
            }
            process.env.PATH = previous
          }),
      )
      yield* addPlugin()

      const provider = yield* catalog.provider.get(DevinCLI.ID)
      expect(provider?.disabled).toBe(false)
      expect(provider?.request.body[DevinCLI.EXECUTABLE_KEY]).toBe(fixture.executable)
      for (const value of [undefined, "", "  ", null, 42, {}]) {
        expect(DevinCLI.resolveExecutable(value)).toBe(fixture.executable)
      }
      expect(yield* Effect.promise(() => DevinCLI.probe())).toEqual({
        status: "installed",
        executable: fixture.executable,
      })
      expect(fs.existsSync(fixture.marker)).toBe(false)
    }),
  )
})
