export * as PluginInternal from "./internal"

import { makeLocationNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import type { PluginContext } from "@turenlabs/plugin/v2/effect"
import { Effect, Layer } from "effect"
import type { Plugin } from "./define"
import { AgentV2 } from "../agent"
import { Catalog } from "../catalog"
import { CommandV2 } from "../command"
import { Config } from "../config"
import { ConfigAgentPlugin } from "../config/plugin/agent"
import { ConfigCommandPlugin } from "../config/plugin/command"
import { ConfigProviderPlugin } from "../config/plugin/provider"
import { ConfigSkillPlugin } from "../config/plugin/skill"
import { EventV2 } from "../event"
import { ExtensionRuntime } from "../extension"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Integration } from "../integration"
import { Location } from "../location"
import { ModelsDev } from "../models-dev"
import { Npm } from "../npm"
import { PluginV2 } from "../plugin"
import { Reference } from "../reference"
import { SkillV2 } from "../skill"
import { SkillDiscovery } from "../skill/discovery"
import { State } from "../state"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { AgentPlugin } from "./agent"
import { CommandPlugin } from "./command"
import { ComplexityRatchetPlugin } from "./complexity-ratchet"
import { ModelsDevPlugin } from "./models-dev"
import { ProviderPlugins } from "./provider"
import { SkillPlugin } from "./skill"
import { VariantPlugin } from "./variant"

export { define, type Plugin, type Requirements } from "./define"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const commands = yield* CommandV2.Service
    const plugin = yield* PluginV2.Service
    const integration = yield* Integration.Service
    const agents = yield* AgentV2.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const modelsDev = yield* ModelsDev.Service
    const npm = yield* Npm.Service
    const events = yield* EventV2.Service
    const extensions = yield* ExtensionRuntime.Service
    const fs = yield* FSUtil.Service
    const filesystem = yield* FileSystem.Service
    const global = yield* Global.Service
    const http = yield* HttpClient.HttpClient
    const skill = yield* SkillV2.Service
    const skillDiscovery = yield* SkillDiscovery.Service
    const reference = yield* Reference.Service
    const add = <R>(input: Plugin<R>) => {
      const loaded = {
        id: input.id,
        effect: (context: PluginContext) =>
          input
            .effect(context)
            .pipe(
              Effect.provideService(Catalog.Service, catalog),
              Effect.provideService(CommandV2.Service, commands),
              Effect.provideService(Integration.Service, integration),
              Effect.provideService(AgentV2.Service, agents),
              Effect.provideService(Config.Service, config),
              Effect.provideService(Location.Service, location),
              Effect.provideService(ModelsDev.Service, modelsDev),
              Effect.provideService(Npm.Service, npm),
              Effect.provideService(EventV2.Service, events),
              Effect.provideService(ExtensionRuntime.Service, extensions),
              Effect.provideService(FSUtil.Service, fs),
              Effect.provideService(FileSystem.Service, filesystem),
              Effect.provideService(Global.Service, global),
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.provideService(SkillV2.Service, skill),
              Effect.provideService(SkillDiscovery.Service, skillDiscovery),
              Effect.provideService(Reference.Service, reference),
            ),
      }
      return plugin.add(PluginV2.ID.make(loaded.id), loaded.effect)
    }

    yield* Effect.gen(function* () {
      // The runner waits for config-agent. Keep it as the final readiness barrier
      // so every independent registry is materialized before a cold first turn.
      // Always publish it even if another initializer fails, otherwise waiters
      // cannot distinguish failed startup from startup that is still in progress.
      yield* Effect.all(
        [
          add(AgentPlugin.Plugin),
          Effect.gen(function* () {
            yield* add(CommandPlugin.Plugin)
            yield* add(ConfigCommandPlugin.Plugin)
          }),
          add(ComplexityRatchetPlugin.Plugin),
          Effect.gen(function* () {
            yield* add(ConfigSkillPlugin.Plugin)
            yield* add(SkillPlugin.Plugin)
          }),
          Effect.gen(function* () {
            yield* State.batch(
              Effect.gen(function* () {
                yield* add(ModelsDevPlugin)
                for (const item of ProviderPlugins) yield* add(item)
              }),
            )
            yield* add(ConfigProviderPlugin.Plugin)
            yield* add(VariantPlugin.Plugin)
          }),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.ensuring(add(ConfigAgentPlugin.Plugin)))
    }).pipe(Effect.withSpan("PluginInternal.boot"), Effect.forkScoped({ startImmediately: true }))
  }),
)

export const locationLayer = layer.pipe(
  Layer.provideMerge(Config.locationLayer),
  Layer.provideMerge(FetchHttpClient.layer),
)

export const node = makeLocationNode({
  name: "plugin-internal",
  layer,
  deps: [
    Catalog.node,
    CommandV2.node,
    PluginV2.node,
    Integration.node,
    AgentV2.node,
    Config.node,
    Location.node,
    ModelsDev.node,
    Npm.node,
    EventV2.node,
    ExtensionRuntime.node,
    FSUtil.node,
    FileSystem.node,
    Global.node,
    httpClient,
    SkillV2.node,
    SkillDiscovery.node,
    Reference.node,
  ],
})
