import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Equal, Exit, Hash, Schema } from "effect"
import { Tool } from "@turenlabs/core/tool/tool"
import { define } from "@turenlabs/plugin/v2/effect"
import { AgentV2 } from "@turenlabs/core/agent"
import { Catalog } from "@turenlabs/core/catalog"
import { AppNodeBuilder } from "@turenlabs/core/effect/app-node-builder"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
import { LocationServiceMap } from "@turenlabs/core/location-services"
import { Location } from "@turenlabs/core/location"
import { PluginV2 } from "@turenlabs/core/plugin"
import { overrideProbe } from "@turenlabs/core/plugin/provider/claude-code"
import { ModelV2 } from "@turenlabs/core/model"
import { ProjectV2 } from "@turenlabs/core/project"
import { ProviderV2 } from "@turenlabs/core/provider"
import { ClaudeCodeCLI } from "@turenlabs/core/provider/claude-code"
import { AbsolutePath } from "@turenlabs/core/schema"
import { SessionV2 } from "@turenlabs/core/session"
import { SessionRunnerModel } from "@turenlabs/core/session/runner/model"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolDefinitions } from "./lib/tool"
import { FSUtil } from "../src/fs-util"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { ModelsDev } from "../src/models-dev"
import { Npm } from "../src/npm"
import { Project } from "../src/project"
import { Reference } from "../src/reference"
import { ToolRegistry } from "../src/tool/registry"
import { ApplicationTools } from "../src/tool/application-tools"
import { SessionToolSnapshot } from "../src/tool/session-snapshot"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node])),
)

describe("LocationServiceMap", () => {
  it.live("reuses cached services for constructed and decoded location refs", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.scoped(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            const directory = AbsolutePath.make(dir.path)
            const constructed = Location.Ref.make({ directory })
            const decoded = Schema.decodeUnknownSync(Location.Ref)({ directory })

            expect(constructed).toEqual({ directory, workspaceID: undefined })
            expect(decoded).toEqual(constructed)
            expect(Equal.equals(constructed, decoded)).toBe(true)
            expect(Hash.hash(constructed)).toBe(Hash.hash(decoded))
            expect(yield* locations.contextEffect(constructed)).toBe(yield* locations.contextEffect(decoded))
          }),
        ),
      ),
    ),
  )

  it.live("isolates location state while sharing location policy with catalog", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([blocked, allowed]) =>
        Effect.gen(function* () {
          yield* (yield* ApplicationTools.Service).register({
            application_context: Tool.make({
              description: "Read application context",
              input: Schema.Struct({}),
              output: Schema.Struct({ ok: Schema.Boolean }),
              execute: () => Effect.succeed({ ok: true }),
            }),
          })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(blocked.path, "forge.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "test" }] },
              }),
            ),
          )

          const update = (directory: string) =>
            Effect.gen(function* () {
              yield* Reference.Service
              const catalog = yield* Catalog.Service
              yield* catalog.transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))
              return {
                providers: yield* catalog.provider.all(),
                tools: yield* toolDefinitions(yield* ToolRegistry.Service),
              }
            }).pipe(
              Effect.scoped,
              Effect.provide(
                LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(directory) })),
              ),
            )

          const blockedState = yield* update(blocked.path)
          expect(blockedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(false)
          const blockedTools = blockedState.tools.map((tool) => tool.name).sort()
          expect(blockedTools).toContain("application_context")
          expect(blockedTools).toContain("binary_inspect")
          expect(blockedTools).toContain("reflection_state")
          expect(blockedTools).toContain("yara_scan")
          const allowedState = yield* update(allowed.path)
          expect(allowedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(true)
          expect(allowedState.tools.map((tool) => tool.name).sort()).toEqual(blockedTools)
        }),
      ),
    ),
  )

  it.live(
    "rejects an unavailable selected model during location model resolution",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((dir) =>
          Effect.gen(function* () {
            const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
            yield* Effect.promise(() =>
              fs.writeFile(
                path.join(dir.path, "forge.json"),
                JSON.stringify({
                  providers: {
                    unavailable: {
                      name: "Unavailable",
                      api: { type: "native", settings: {} },
                      models: { chat: { disabled: true } },
                    },
                  },
                }),
              ),
            )
            const failure = yield* SessionRunnerModel.Service.use((models) =>
              models.resolve(
                SessionV2.Info.make({
                  id: SessionV2.ID.make("ses_unavailable_model"),
                  projectID: ProjectV2.ID.global,
                  title: "test",
                  model: {
                    id: ModelV2.ID.make("chat"),
                    providerID: ProviderV2.ID.make("unavailable"),
                  },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
                  location,
                }),
              ),
            ).pipe(Effect.provide(LocationServiceMap.Service.get(location)), Effect.flip)

            expect(failure).toMatchObject({
              _tag: "SessionRunnerModel.ModelUnavailableError",
              providerID: "unavailable",
              modelID: "chat",
            })
          }),
        ),
      ),
    { timeout: 15_000 },
  )

  it.live("waits for the Claude provider plugin during selected model resolution", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          overrideProbe(
            () =>
              new Promise((resolve) =>
                setTimeout(() => resolve({ status: "authenticated", executable: "/usr/local/bin/claude" }), 100),
              ),
          )
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const resolved = yield* SessionRunnerModel.Service.use((models) =>
            models.resolve(
              SessionV2.Info.make({
                id: SessionV2.ID.make("ses_delayed_claude_plugin"),
                projectID: ProjectV2.ID.global,
                title: "test",
                model: { id: ModelV2.ID.make("opus"), providerID: ClaudeCodeCLI.ID },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
                location,
              }),
            ),
          ).pipe(Effect.provide(LocationServiceMap.Service.get(location)))

          expect(resolved.ref).toMatchObject({ providerID: ClaudeCodeCLI.ID, id: "opus" })
        }).pipe(Effect.ensuring(Effect.sync(() => overrideProbe()))),
      ),
    ),
  )

  it.live("does not strand plugin readiness when a provider initializer fails", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          overrideProbe(() => Promise.reject(new Error("probe failed")))
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const ready = yield* SessionToolSnapshot.Service.use((snapshots) => snapshots.ready()).pipe(
            Effect.provide(LocationServiceMap.Service.get(location)),
            Effect.timeout("2 seconds"),
            Effect.exit,
          )

          expect(Exit.isSuccess(ready)).toBe(true)
        }).pipe(Effect.ensuring(Effect.sync(() => overrideProbe()))),
      ),
    ),
  )

  it.live("installs public plugins into a location", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const plugins = yield* PluginV2.Service
          const reviewer = define({
            id: "reviewer",
            effect: (ctx) =>
              ctx.agent
                .transform((agent) => {
                  agent.update("reviewer", (item) => {
                    item.description = "Reviews code"
                    item.mode = "subagent"
                  })
                })
                .pipe(Effect.asVoid),
          })
          yield* plugins.add(PluginV2.ID.make(reviewer.id), reviewer.effect)

          expect(yield* (yield* AgentV2.Service).get(AgentV2.ID.make("reviewer"))).toMatchObject({
            description: "Reviews code",
            mode: "subagent",
          })
        }).pipe(
          Effect.scoped,
          Effect.provide(LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))),
        ),
      ),
    ),
  )
})
