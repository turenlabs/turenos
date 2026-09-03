export * as Config from "./config"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { type ParseError, parse } from "jsonc-parser"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Permission } from "@turenlabs/schema/permission"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Location } from "./location"
import { Policy } from "./policy"
import { AbsolutePath } from "./schema"
import { ConfigAgent } from "./config/agent"
import { ConfigAttachments } from "./config/attachments"
import { ConfigCompaction } from "./config/compaction"
import { ConfigCommand } from "./config/command"
import { ConfigExperimental } from "./config/experimental"
import { ConfigFormatter } from "./config/formatter"
import { ConfigLSP } from "./config/lsp"
import { ConfigPlugin } from "./config/plugin"
import { ConfigProvider } from "./config/provider"
import { ConfigRetention } from "./config/retention"
import { ConfigReflection } from "./config/reflection"
import { ConfigSemanticMemory } from "./config/semantic-memory"
import { ConfigSubagent } from "./config/subagent"
import { ConfigToolOutput } from "./config/tool-output"
import { ConfigWatcher } from "./config/watcher"
import { ConfigV1 } from "./v1/config/config"
import { ConfigMigrateV1 } from "./v1/config/migrate"

export class Info extends Schema.Class<Info>("Config.Info")({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.String.pipe(Schema.optional).annotate({
    description: "Default shell to use for terminal and shell tool execution",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description: "Default model to use when no session or agent model is selected",
  }),
  default_agent: Schema.String.pipe(Schema.optional).annotate({
    description: "Default primary agent to use when no session agent is selected",
  }),
  autoupdate: Schema.Union([Schema.Boolean, Schema.Literal("notify")])
    .pipe(Schema.optional)
    .annotate({
      description: "Automatically update or notify when a new version is available",
    }),
  enterprise: Schema.Struct({
    url: Schema.String.pipe(Schema.optional),
  })
    .pipe(Schema.optional)
    .annotate({
      description: "Legacy session import and revocation service configuration",
    }),
  username: Schema.String.pipe(Schema.optional).annotate({
    description: "Username displayed in conversations and used for telemetry identity",
  }),
  permissions: Permission.Ruleset.pipe(Schema.optional).annotate({
    description: "Ordered tool permission rules applied to agent tool use",
  }),
  agents: Schema.Record(Schema.String, ConfigAgent.Info).pipe(Schema.optional).annotate({
    description: "Named built-in agent overrides and custom agent definitions",
  }),
  subagents: ConfigSubagent.Info.pipe(Schema.optional).annotate({
    description: "Durable subagent delegation limits",
  }),
  snapshots: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable snapshots used for undo and revert behavior",
  }),
  watcher: ConfigWatcher.Info.pipe(Schema.optional).annotate({
    description: "Filesystem watcher configuration",
  }),
  formatter: ConfigFormatter.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in formatters or configure formatter overrides",
  }),
  lsp: ConfigLSP.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in language servers or configure server overrides",
  }),
  attachments: ConfigAttachments.Info.pipe(Schema.optional).annotate({
    description: "Attachment processing configuration",
  }),
  tool_output: ConfigToolOutput.Info.pipe(Schema.optional).annotate({
    description: "Tool output truncation thresholds",
  }),
  compaction: ConfigCompaction.Info.pipe(Schema.optional).annotate({
    description: "Conversation compaction behavior",
  }),
  retention: ConfigRetention.Info.pipe(Schema.optional).annotate({
    description: "How long stored session payloads are kept in full before they are reduced to previews",
  }),
  reflection: ConfigReflection.Info.pipe(Schema.optional).annotate({
    description: "Embedded prediction, hypothesis, verification, and periodic self-reflection behavior",
  }),
  semantic_memory: ConfigSemanticMemory.Info.pipe(Schema.optional).annotate({
    description: "Optional local semantic memory retrieval backed by the Potion embedding model.",
  }),
  commands: Schema.Record(Schema.String, ConfigCommand.Info).pipe(Schema.optional).annotate({
    description: "Named slash command definitions",
  }),
  skills: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: "Ordered local directory or HTTPS discovery sources for skills",
  }),
  plugins: ConfigPlugin.Plugins.pipe(Schema.optional).annotate({
    description: "Ordered external plugin packages to load",
  }),
  providers: Schema.Record(Schema.String, ConfigProvider.Info).pipe(Schema.optional),
  experimental: ConfigExperimental.Experimental.pipe(Schema.optional),
}) {}

export class Document extends Schema.Class<Document>("Config.Document")({
  type: Schema.Literal("document"),
  path: Schema.String.pipe(Schema.optional),
  info: Info,
}) {}

export class Directory extends Schema.Class<Directory>("Config.Directory")({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}) {}

export type Entry = Document | Directory

/**
 * Lowers v1 keys that survive inside an otherwise-v2 document onto their v2 names.
 *
 * V1's compaction knobs become `compaction.keep` / `compaction.buffer`. `auto`
 *   and `prune` are spelled identically in both versions, so without this the
 *   dangerous half of a v1 block survives and the preservation half does not.
 */
function lower(input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input
  const record = input as Record<string, unknown>
  const compaction = ConfigMigrateV1.compactionAliases(record["compaction"])
  // The provider allow/deny lists become `experimental.policies`, which is how v2
  // represents provider access. The desktop app still writes `disabled_providers`
  // on provider disconnect, because the v1 server is what honours it.
  const statements = ConfigMigrateV1.providerPolicies(record["disabled_providers"], record["enabled_providers"])
  if (!statements.length && !compaction) return input
  let lowered = record
  if (statements.length) {
    const experimental =
      typeof record["experimental"] === "object" && record["experimental"] !== null
        ? (record["experimental"] as Record<string, unknown>)
        : {}
    const authored = Array.isArray(experimental["policies"]) ? experimental["policies"] : []
    lowered = { ...lowered, experimental: { ...experimental, policies: [...statements, ...authored] } }
  }
  if (compaction) lowered = { ...lowered, compaction }
  return lowered
}

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .findLast((entry) => entry.info[key] !== undefined)?.info[key]
}

export interface Interface {
  /** Returns location config documents and supplemental directories from lowest to highest priority. */
  readonly entries: () => Effect.Effect<Entry[]>
}

export class Service extends Context.Service<Service, Interface>()("@forge/v2/Config") {}

/** Config file names read from every candidate directory, lowest priority first. */
export const NAMES = ["forge.json", "forge.jsonc"] as const

const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
const decodeV1Info = Schema.decodeUnknownOption(ConfigV1.Info, decodeOptions)

/**
 * Decodes one config document's text, or `undefined` when it will not parse or decode.
 *
 * Module-scoped rather than closed over the layer so global-scoped services can read the global
 * config file without opening a Location -- `Config.Service` is location-scoped, and a global
 * maintenance job has no location to open. All-or-nothing by design: a document that fails to
 * decode is ignored entirely rather than applied in part.
 */
export function decodeDocument(text: string, filepath?: string): Document | undefined {
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) return

  const asV1 = () => decodeV1Info(input).pipe(Option.map(ConfigMigrateV1.migrate), Option.flatMap(decodeInfo))
  const asV2 = () =>
    decodeInfo(lower(input)).pipe(
      Option.map((info) => {
        const providers = legacyProviders(input)
        if (!providers) return info
        return new Info({ ...info, providers: { ...providers, ...info.providers } })
      }),
    )
  const info = Option.getOrUndefined(
    ConfigMigrateV1.isV1(input)
      ? asV1()
      : // A file with no v1-only key is read as v2 first. Falling back to the
        // v1 path when that fails keeps documents readable when they mix v2
        // naming with a v1-shaped block, which would otherwise decode to
        // nothing and drop the whole file.
        asV2().pipe(Option.orElse(asV1)),
  )
  if (!info) return
  return new Document({ type: "document", path: filepath, info })
}

function legacyProviders(input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return
  if (!("provider" in input)) return
  const decoded = Option.getOrUndefined(decodeV1Info({ provider: input.provider }))
  if (!decoded) return
  return Option.getOrUndefined(decodeInfo(ConfigMigrateV1.migrate(decoded)))?.providers
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const policy = yield* Policy.Service
    const names = NAMES

    const loadFile = Effect.fnUntraced(function* (filepath: string) {
      const text = yield* fs.readFileStringSafe(filepath)
      if (!text) return
      return decodeDocument(text, filepath)
    })

    const loadDirectory = Effect.fnUntraced(function* (directory: AbsolutePath) {
      return [
        ...(yield* Effect.forEach(names, (file) => loadFile(path.join(directory, file))).pipe(
          Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
        )),
        new Directory({ type: "directory", path: directory }),
      ]
    })

    const globalDirectory = AbsolutePath.make(global.config)
    const locationIsGlobal = path.resolve(location.directory) === path.resolve(global.config)
    // Read configuration once when this location opens. Later calls reuse these
    // values until the location is reopened.
    const discovered = locationIsGlobal
      ? []
      : yield* fs
          .up({
            targets: [".forge", ...names.toReversed()],
            start: location.directory,
            stop: location.project.directory,
          })
          .pipe(Effect.orDie)
    const directories = [
      globalDirectory,
      ...discovered
        .filter((item) => path.basename(item) === ".forge")
        .toReversed()
        .map((directory) => AbsolutePath.make(directory)),
    ]
    // A config closer to the opened directory should win over one higher up.
    // Search starts nearby, so reverse the results before applying them.
    const directPaths = discovered.filter((item) => path.basename(item) !== ".forge").toReversed()
    const direct = yield* Effect.forEach(directPaths, loadFile).pipe(
      Effect.orDie,
      Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
    )
    const supplementary = yield* Effect.forEach(directories, loadDirectory).pipe(Effect.orDie)
    // Apply general settings first and more specific settings last:
    // global config, project files, then `.forge` files.
    const configs = [...(supplementary[0] ?? []), ...direct, ...supplementary.slice(1).flat()]
    // Rules use the opposite order so a user-global rule can override a
    // repository rule. Statement order inside each file stays unchanged.
    yield* policy.load(
      configs
        .filter((config): config is Document => config.type === "document")
        .toReversed()
        .flatMap((config) => config.info.experimental?.policies ?? []),
    )

    return Service.of({
      entries: Effect.fn("Config.entries")(function* () {
        return configs
      }),
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Policy.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Policy.node],
})
