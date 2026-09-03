import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = Config.boolean("FORGE_EXPERIMENTAL").pipe(Config.withDefault(true))
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@forge/RuntimeFlags", {
  pure: bool("FORGE_PURE"),
  disableDefaultPlugins: bool("FORGE_DISABLE_DEFAULT_PLUGINS"),
  disableExternalSkills: bool("FORGE_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("FORGE_DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("FORGE_DISABLE_CLAUDE_CODE"),
    direct: bool("FORGE_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("FORGE_DISABLE_CLAUDE_CODE"),
    direct: bool("FORGE_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExperimentalModels: bool("FORGE_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("FORGE_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("FORGE_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("FORGE_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("FORGE_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("FORGE_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("FORGE_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("FORGE_EXPERIMENTAL_PLAN_MODE"),
  experimentalCodeMode: enabledByExperimental("FORGE_EXPERIMENTAL_CODE_MODE"),
  experimentalEventSystem: enabledByExperimental("FORGE_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("FORGE_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("FORGE_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("FORGE_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("FORGE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("FORGE_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("FORGE_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("FORGE_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const node = LayerNode.make({ service: Service, layer: Service.layer.pipe(Layer.orDie), deps: [] })

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@turenlabs/core/effect/layer-node"
